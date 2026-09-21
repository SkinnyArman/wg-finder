"""WG-Gesucht watcher: poll -> read ad -> draft reply -> ask you on Telegram."""
import asyncio
import functools
import html
import re
import time
import logging
import os
import random
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (Application, CallbackQueryHandler, CommandHandler,
                          ContextTypes)

from . import settings, store
from .scraper import Blocked, WGClient
from .writer import Writer

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

logging.basicConfig(
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    level=logging.INFO, datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("bot")

CFG = yaml.safe_load((ROOT / "profile.yaml").read_text(encoding="utf-8"))
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
SCAN_JOB = "scan"
_burst = 0          # extra ads unlocked by /more, consumed by the next scan
_tick = 0
_cancel = False     # set by /pause to stop a scan already in progress

writer = Writer(os.environ["OPENAI_API_KEY"],
                os.getenv("OPENAI_MODEL", "gpt-4o"), CFG)

_scan_lock = asyncio.Lock()

_OWNER = (CFG.get("about", {}) or {}).get("name") or "its owner"
STRANGER_REPLY = (f"Sorry, this bot was built for {_OWNER}'s own flat search "
                  "and only answers to them.")


def owner_only(fn):
    """Every handler is wrapped: strangers get a polite no and nothing runs."""
    @functools.wraps(fn)
    async def guard(update: Update, context: ContextTypes.DEFAULT_TYPE):
        chat = update.effective_chat
        if not chat or str(chat.id) != str(CHAT_ID):
            log.warning("ignored %s from chat %s",
                        getattr(update.effective_user, "username", "?"),
                        chat.id if chat else "?")
            if update.message:
                await update.message.reply_text(STRANGER_REPLY)
            elif update.callback_query:
                await update.callback_query.answer(STRANGER_REPLY, show_alert=True)
            return
        return await fn(update, context)
    return guard


# ----------------------------- filtering -----------------------------
PENDLER_WORDS = ("pendler", "pendlerin", "pendler*in", "wochenend",
                 "zwischenmiete", "nur unter der woche", "mo-do", "mo - do",
                 "monday to thursday", "weekdays only", "commuter")


def passes_filters(ad) -> tuple[bool, str]:
    f = settings.load()
    title = (ad.title or "").lower()

    for bad in f.get("skip_if_title_contains") or []:
        if bad.lower() in title:
            return False, f"title contains '{bad}'"
    req = f.get("require_title_contains") or []
    if req and not any(r.lower() in title for r in req):
        return False, "missing required keyword"

    if f.get("skip_female_only", True) and ad.seeking == "female":
        return False, "WG wants a woman"

    if f.get("skip_pendler", True):
        for wd in PENDLER_WORDS:
            if wd in title:
                return False, f"Pendler room ('{wd}')"

    rent = ad.rent_eur
    if rent is not None:
        if f.get("max_rent") and rent > f["max_rent"]:
            return False, f"{rent} EUR over max"
        if f.get("min_rent") and rent < f["min_rent"]:
            return False, f"{rent} EUR under min"
    return True, ""


# ----------------------------- telegram UI -----------------------------
def _kb(ad_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("Approve", callback_data=f"ok:{ad_id}"),
        InlineKeyboardButton("Rewrite", callback_data=f"re:{ad_id}"),
        InlineKeyboardButton("Skip", callback_data=f"no:{ad_id}"),
    ]])


def _header(ad, draft: dict) -> str:
    e = html.escape
    flag = "DE" if draft["language"] == "de" else "EN"
    warn = " · <i>thin ad</i>" if draft.get("thin_ad") else ""
    used = draft.get("facts_used") or []
    extra = f"\n<i>used: {e(', '.join(used))}</i>" if used else ""
    return (
        f"<b>{e(ad.title or 'Untitled')}</b>\n"
        f"{e(ad.rent or '?')} · {e(ad.size or '?')} · {e(ad.district or '?')}\n"
        f"{e(ad.flatmates) + chr(10) if ad.flatmates else ''}"
        f"written in <b>{flag}</b>{warn}{extra}\n"
        f'<a href="{e(ad.url)}">open the Anzeige</a>'
    )


async def _push(app, ad, draft: dict):
    store.record(ad.ad_id, url=ad.url, title=ad.title, rent=ad.rent,
                 district=ad.district, status="pending",
                 language=draft["language"], ad_text=ad.text,
                 flatmates=ad.flatmates,
                 message=draft["message"])
    store.mark_pushed(ad.ad_id)

    # photo first (caption = the ad header), then the draft + buttons
    if ad.image:
        try:
            await app.bot.send_photo(
                chat_id=CHAT_ID, photo=ad.image, caption=_header(ad, draft),
                parse_mode=ParseMode.HTML)
        except Exception as e:
            log.warning("photo failed for %s (%s), sending text only", ad.ad_id, e)
            await app.bot.send_message(
                chat_id=CHAT_ID, text=_header(ad, draft),
                parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    else:
        await app.bot.send_message(
            chat_id=CHAT_ID, text=_header(ad, draft),
            parse_mode=ParseMode.HTML, disable_web_page_preview=True)

    await app.bot.send_message(
        chat_id=CHAT_ID, text=f"<pre>{html.escape(draft['message'])}</pre>",
        parse_mode=ParseMode.HTML, reply_markup=_kb(ad.ad_id))


# ----------------------------- the scan job -----------------------------
async def scan(context: ContextTypes.DEFAULT_TYPE) -> tuple[str, int]:
    """Returns (status, ads_sent). Status is what the user needs told."""
    if _scan_lock.locked():
        log.info("Previous scan still running, skipping this tick.")
        return "busy", 0

    paused, state = settings.pause_state()
    if paused:
        log.info("Scan skipped (%s).", state)
        return "paused", 0

    blocked, left = settings.block_state()
    if blocked:
        log.info("Still backing off from wg-gesucht (%s left).", left)
        return "blocked", 0

    async with _scan_lock:
        global _cancel
        _cancel = False
        app = context.application
        try:
            sent = await _scan_once(app)
            return ("cancelled" if _cancel else "ok"), sent
        except Blocked:
            already, _ = settings.block_state()
            backoff = settings.load()["block_backoff_min"]
            settings.start_block(backoff)
            if already:
                log.warning("captcha again; backoff extended to %d min", backoff)
                return "blocked", 0
            log.warning("wg-gesucht captcha. Pausing %d min.", backoff)
            await app.bot.send_message(
                CHAT_ID,
                f"<b>Paused: wg-gesucht wants a captcha</b>\n\n"
                f"This is their rate limiting, not a crash, and nothing is "
                f"lost - every ad I hadn't got to is still queued.\n\n"
                f"I'll wait <b>{backoff} minutes</b> and start again by myself. "
                f"You don't need to do anything. Asking me to scan before then "
                f"only makes it last longer.\n\n"
                f"Check the time left with /settings.",
                parse_mode=ParseMode.HTML)
            return "blocked", 0
        except Exception as e:
            log.exception("scan failed")
            await app.bot.send_message(
                CHAT_ID,
                f"Something went wrong during the scan:\n"
                f"<code>{html.escape(str(e))[:300]}</code>\n\n"
                f"I'll try again at the next check. Queued ads are safe.",
                parse_mode=ParseMode.HTML)
            return "error", 0


# ----------------------------- handlers -----------------------------
@owner_only
async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query

    if q.data.startswith("set:"):
        parts = q.data.split(":")
        if parts[1] == "noop":
            await q.answer()
            return
        if parts[1] in ("pause", "resume"):
            global _cancel
            if parts[1] == "pause":
                _cancel = True
                await q.answer(settings.pause())
            else:
                _cancel = False
                settings.resume()
                await q.answer("Running again")
            try:
                await q.edit_message_text(
                    settings.behaviour_summary()
                    + "\n\nTap to change, or: /settings poll_minutes 30"
                    + "\nAd filters are under /filters",
                    reply_markup=_settings_kb())
            except Exception:
                pass
            return
        key = parts[1]
        cur = settings.load().get(key, 0) or 0
        ok, msg = settings.set_value(key, cur + int(parts[2]))
        await q.answer(msg)
        if ok and key == "poll_minutes":
            _reschedule(context.application)
        try:
            await q.edit_message_text(
                settings.behaviour_summary()
                + "\n\nTap to change, or: /settings poll_minutes 30"
                + "\nAd filters are under /filters",
                reply_markup=_settings_kb())
        except Exception:
            pass
        return

    if q.data.startswith("flt:"):
        parts = q.data.split(":")
        key = parts[1]
        if len(parts) == 3:                       # numeric nudge
            cur = settings.load().get(key, 0) or 0
            ok, msg = settings.set_value(key, max(0, cur + int(parts[2])))
        else:                                     # boolean toggle
            ok, msg = settings.toggle(key)
        await q.answer(msg)
        try:
            await q.edit_message_text(
                settings.summary() + "\n\nTap to change, or: /filters max_rent 750",
                reply_markup=_filters_kb())
        except Exception:
            pass
        return

    action, ad_id = q.data.split(":", 1)
    row = store.get(ad_id)
    if not row:
        await q.answer("Unknown ad.")
        return

    if action == "no":
        store.set_status(ad_id, "skipped")
        await q.answer("Skipped")
        await q.edit_message_reply_markup(reply_markup=None)
        await q.message.reply_text("Skipped.")
        return

    if action == "ok":
        store.set_status(ad_id, "approved")
        await q.answer("Here you go")
        await q.edit_message_reply_markup(reply_markup=None)
        # Clean, tap-to-copy block plus the link to paste it into.
        await q.message.reply_text(
            f"<pre>{html.escape(row['message'])}</pre>",
            parse_mode=ParseMode.HTML)
        await q.message.reply_text(f"Paste it here: {row['url']}",
                                   disable_web_page_preview=True)
        return

    if action == "re":
        await q.answer("Rewriting...")
        await q.edit_message_reply_markup(reply_markup=None)

        class _A:  # minimal shim for the writer
            ad_id, url, title = row["ad_id"], row["url"], row["title"]
            rent, district, text = row["rent"], row["district"], row["ad_text"]
        try:
            draft = await writer.compose(
                _A(), retry_note="The previous draft was rejected. Take a "
                                 "noticeably different angle, open with a "
                                 "different detail, and vary the rhythm.")
            await _push(context.application, _A(), draft)
        except Exception as e:
            await q.message.reply_text(f"Rewrite failed: {e}")


@owner_only
async def cmd_start(update: Update, _):
    await update.message.reply_text(
        f"WG watcher running.\nYour chat id: {update.effective_chat.id}\n"
        f"{settings.behaviour_summary()}\n\n"
        "/pause [2h] - stop searching (forever, or for a while)\n"
        "/resume   - start again\n"
        "/more [n] - send n more now, ignoring the hourly cap (default 5)\n"
        "/scan     - check for new ads right now\n"
        "/stats    - what I've seen\n"
        "/filters  - see and change the ad filters\n"
        "/settings - check interval, ads per hour, captcha pause\n"
        "/retry    - re-draft ads that errored")


@owner_only
async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    paused, state = settings.pause_state()
    if paused:
        await update.message.reply_text(f"I'm {state}. /resume first.")
        return
    if await _blocked_reply(update):
        return
    await update.message.reply_text("Checking now...")
    msg = _outcome(*await scan(context))
    if msg:
        await update.message.reply_text(msg)


def _filters_kb() -> InlineKeyboardMarkup:
    f = settings.load()
    mark = lambda b: "ON " if b else "OFF"        # noqa: E731
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(f"[{mark(f.get('skip_female_only'))}] skip women-only",
                              callback_data="flt:skip_female_only")],
        [InlineKeyboardButton(f"[{mark(f.get('skip_pendler'))}] skip Pendler rooms",
                              callback_data="flt:skip_pendler")],
        [InlineKeyboardButton(f"max rent: {f.get('max_rent')} EUR  (-50)",
                              callback_data="flt:max_rent:-50"),
         InlineKeyboardButton("(+50)", callback_data="flt:max_rent:+50")],
    ])


def _outcome(status: str, sent: int) -> str | None:
    """What to tell the user after a scan. None = already told them."""
    if status == "blocked":
        return None                      # scan() sent the captcha notice
    if status == "busy":
        return "A scan was already running - let that one finish."
    if status == "paused":
        return "I'm paused. /resume first."
    if status == "cancelled":
        return "Stopped. Anything I hadn't sent is still queued."
    if status == "error":
        return None                      # scan() already explained
    if sent == 0:
        return "Nothing new - everything currently listed I've already shown you."
    return f"Sent {sent} ad{'s' if sent != 1 else ''}."


async def _blocked_reply(update) -> bool:
    """True (and tells the user) if wg-gesucht currently has us blocked."""
    blocked, left = settings.block_state()
    if blocked:
        await update.message.reply_text(
            f"wg-gesucht is still showing a captcha. {left} left on the backoff.\n\n"
            f"Asking again now would only extend it - I'll start by myself when "
            f"the timer runs out.")
    return blocked


def _parse_duration(text: str) -> int | None:
    """'30m', '2h', '90' (minutes), 'tomorrow' -> seconds. None if unparseable."""
    t = (text or "").strip().lower()
    if not t:
        return None
    if t in ("tomorrow", "morgen"):
        return 12 * 3600
    m = re.fullmatch(r"(\d+)\s*([mhd]?)", t)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2) or "m"
    return n * {"m": 60, "h": 3600, "d": 86400}[unit]


@owner_only
async def cmd_pause(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/pause - stop until told otherwise. /pause 2h - stop for a while."""
    global _cancel
    _cancel = True          # stop a scan that is already running

    secs = _parse_duration(context.args[0]) if context.args else None
    if context.args and secs is None:
        await update.message.reply_text(
            "Didn't understand that. Try /pause, /pause 30m, /pause 2h, /pause 1d")
        return

    msg = settings.pause(secs)
    busy = " Stopping the scan that was running." if _scan_lock.locked() else ""
    await update.message.reply_text(
        f"{msg}.{busy}\n\nNothing is lost - ads stay queued and nothing is "
        f"sent to anyone. /resume when you want it back.")


@owner_only
async def cmd_resume(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global _cancel
    _cancel = False
    settings.resume()
    if await _blocked_reply(update):
        await update.message.reply_text("Un-paused, but waiting out the captcha first.")
        return
    await update.message.reply_text("Running again. Checking now...")
    msg = _outcome(*await scan(context))
    if msg:
        await update.message.reply_text(msg)


def _reschedule(app) -> int:
    """Apply the current poll interval to the running job queue."""
    mins = settings.load()["poll_minutes"]
    for job in app.job_queue.get_jobs_by_name(SCAN_JOB):
        job.schedule_removal()
    app.job_queue.run_repeating(
        scan, interval=mins * 60, first=15, name=SCAN_JOB,
        job_kwargs={"misfire_grace_time": 300, "jitter": 90})
    log.info("scan scheduled every %d min", mins)
    return mins


def _settings_kb() -> InlineKeyboardMarkup:
    f = settings.load()
    paused, _ = settings.pause_state()
    top = ([InlineKeyboardButton("Resume searching", callback_data="set:resume")]
           if paused else
           [InlineKeyboardButton("Pause searching", callback_data="set:pause")])
    return InlineKeyboardMarkup([
        top,
        [InlineKeyboardButton("-5 min", callback_data="set:poll_minutes:-5"),
         InlineKeyboardButton(f"every {f['poll_minutes']} min", callback_data="set:noop"),
         InlineKeyboardButton("+5 min", callback_data="set:poll_minutes:+5")],
        [InlineKeyboardButton("-1", callback_data="set:max_per_hour:-1"),
         InlineKeyboardButton(f"{f['max_per_hour']} ads/hour", callback_data="set:noop"),
         InlineKeyboardButton("+1", callback_data="set:max_per_hour:+1")],
        [InlineKeyboardButton("-15", callback_data="set:block_backoff_min:-15"),
         InlineKeyboardButton(f"captcha pause {f['block_backoff_min']} min",
                              callback_data="set:noop"),
         InlineKeyboardButton("+15", callback_data="set:block_backoff_min:+15")],
    ])


@owner_only
async def cmd_settings(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/settings - timing; /settings poll_minutes 30 - set one."""
    if context.args:
        key = context.args[0]
        val = context.args[1] if len(context.args) > 1 else None
        if val is None:
            await update.message.reply_text("Usage: /settings poll_minutes 30")
            return
        ok, msg = settings.set_value(key, val)
        await update.message.reply_text(msg)
        if ok and key == "poll_minutes":
            _reschedule(context.application)
        if ok:
            await update.message.reply_text(settings.behaviour_summary(),
                                            reply_markup=_settings_kb())
        return
    await update.message.reply_text(
        settings.behaviour_summary()
        + "\n\nTap to change, or: /settings poll_minutes 30"
        + "\nAd filters are under /filters",
        reply_markup=_settings_kb())


@owner_only
async def cmd_filters(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/filters - show them; /filters max_rent 750 - change one."""
    if context.args:
        key = context.args[0]
        val = context.args[1] if len(context.args) > 1 else None
        if val is None:
            await update.message.reply_text("Usage: /filters <key> <value>")
            return
        ok, msg = settings.set_value(key, val)
        await update.message.reply_text(msg)
        if ok:
            await update.message.reply_text(settings.summary(),
                                            reply_markup=_filters_kb())
        return
    await update.message.reply_text(
        settings.summary() + "\n\nTap to change, or: /filters max_rent 750",
        reply_markup=_filters_kb())


@owner_only
async def cmd_more(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/more [n] - ignore the hourly cap and send n more now (default 5)."""
    global _burst
    try:
        n = int(context.args[0]) if context.args else 5
    except (ValueError, IndexError):
        n = 5
    paused, state = settings.pause_state()
    if paused:
        await update.message.reply_text(f"I'm {state}. /resume first.")
        return
    if await _blocked_reply(update):
        return
    n = max(1, min(n, 20))
    _burst = n
    await update.message.reply_text(f"Unlocking {n} more. Checking...")
    status, sent = await scan(context)
    if status == "ok" and sent == 0:
        await update.message.reply_text(
            "Nothing new to send - everything listed right now you've "
            "already seen. I'll keep watching.")
    else:
        msg = _outcome(status, sent)
        if msg:
            await update.message.reply_text(msg)


@owner_only
async def cmd_retry(update: Update, context: ContextTypes.DEFAULT_TYPE):
    n = store.retry_failed()
    await update.message.reply_text(
        f"Cleared {n} failed ad(s). Running a scan now..." if n
        else "No failed ads. Scanning anyway...")
    await scan(context)
    await update.message.reply_text("Done.")


@owner_only
async def cmd_stats(update: Update, _):
    s = store.stats()
    if not s:
        await update.message.reply_text("Nothing seen yet.")
        return
    await update.message.reply_text(
        "\n".join(f"{k}: {v}" for k, v in sorted(s.items())))


def main():
    store.init()
    app = Application.builder().token(os.environ["TELEGRAM_BOT_TOKEN"]).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("scan", cmd_scan))
    app.add_handler(CommandHandler("stats", cmd_stats))
    app.add_handler(CommandHandler("retry", cmd_retry))
    app.add_handler(CommandHandler("more", cmd_more))
    app.add_handler(CommandHandler("filters", cmd_filters))
    app.add_handler(CommandHandler("settings", cmd_settings))
    app.add_handler(CommandHandler("pause", cmd_pause))
    app.add_handler(CommandHandler("resume", cmd_resume))
    app.add_handler(CallbackQueryHandler(on_button))

    _reschedule(app)

    log.info("Bot up. Send /start in Telegram.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    sys.exit(main())
