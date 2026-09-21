"""WG-Gesucht watcher: poll -> read ad -> draft reply -> ask you on Telegram."""
import asyncio
import functools
import html
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
_blocked_until = 0.0   # unix ts; set when wg-gesucht shows its captcha
_tick = 0

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
async def scan(context: ContextTypes.DEFAULT_TYPE):
    global _blocked_until
    if _scan_lock.locked():
        log.info("Previous scan still running, skipping this tick.")
        return
    if time.time() < _blocked_until:
        mins = int((_blocked_until - time.time()) / 60) + 1
        log.info("Still backing off from wg-gesucht for ~%d min.", mins)
        return
    async with _scan_lock:
        app = context.application
        try:
            await _scan_once(app)
        except Blocked as e:
            backoff = settings.load()['block_backoff_min']
            _blocked_until = time.time() + backoff * 60
            log.warning("%s Pausing %d min.", e, backoff)
            await app.bot.send_message(
                CHAT_ID,
                f"wg-gesucht is showing a captcha, so I can't read ads right now. "
                f"This is rate limiting, not a crash. Pausing for "
                f"{backoff} minutes, then trying again on my own. "
                f"Nothing is lost - queued ads stay queued.")
        except Exception as e:
            log.exception("scan failed")
            await app.bot.send_message(CHAT_ID, f"Scan error: {html.escape(str(e))[:300]}")


async def _scan_once(app):
    async with WGClient() as c:
        global _tick
        _tick += 1
        searches = CFG.get("searches") or []
        # The outlying towns get a handful of ads a month. Checking all six
        # every 15 minutes is what tripped wg-gesucht's captcha, so the quiet
        # ones are only checked every 4th scan (roughly hourly).
        if _tick % 4 != 1 and len(searches) > 1:
            searches = searches[:1]

        fresh = []
        for search in searches:
            name = search.get("name", search["url"])
            ads = await c.fetch_listing(search["url"])
            log.info("%-45s %d ad(s)", name, len(ads))
            for ad in ads:
                if store.seen(ad.ad_id):
                    continue
                ok, why = passes_filters(ad)
                if not ok:
                    log.info("  filtered %s (%s)", ad.ad_id, why)
                    store.record(ad.ad_id, url=ad.url, title=ad.title,
                                 rent=ad.rent, status="filtered")
                    continue
                fresh.append(ad)

        global _burst
        max_per_hour = settings.load()['max_per_hour']
        budget = max(0, max_per_hour - store.pushed_since(3600)) + _burst
        _burst = 0
        if len(fresh) > budget:
            log.info("%d new ad(s); sending %d (limit %d/hour). Rest stay queued.",
                     len(fresh), budget, max_per_hour)
        else:
            log.info("%d new ad(s) to write for", len(fresh))
        if budget == 0:
            return

        for ad in fresh[:budget]:
            try:
                await c.fetch_ad_text(ad)
                if len((ad.text or "").strip()) < 80:
                    # usually a captcha on the detail page. Drafting from an
                    # empty ad produces a generic message, so requeue instead.
                    log.warning("skipping %s: no usable ad text", ad.ad_id)
                    store.note_failure(ad.ad_id, ad.url, ad.title)
                    continue
                draft = await writer.compose(ad)
                await _push(app, ad, draft)
            except Exception:
                log.exception("ad %s failed", ad.ad_id)
                store.note_failure(ad.ad_id, ad.url, ad.title)


# ----------------------------- handlers -----------------------------
@owner_only
async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query

    if q.data.startswith("set:"):
        parts = q.data.split(":")
        if parts[1] == "noop":
            await q.answer()
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
        "/more [n] - send n more now, ignoring the hourly cap (default 5)\n"
        "/scan     - check for new ads right now\n"
        "/stats    - what I've seen\n"
        "/filters  - see and change the ad filters\n"
        "/settings - check interval, ads per hour, captcha pause\n"
        "/retry    - re-draft ads that errored")


@owner_only
async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Scanning now...")
    await scan(context)
    await update.message.reply_text("Scan done.")


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
    return InlineKeyboardMarkup([
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
    n = max(1, min(n, 20))
    _burst = n
    await update.message.reply_text(f"Unlocking {n} more. Scanning...")
    await scan(context)
    await update.message.reply_text("Done.")


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
    app.add_handler(CallbackQueryHandler(on_button))

    _reschedule(app)

    log.info("Bot up. Send /start in Telegram.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    sys.exit(main())
