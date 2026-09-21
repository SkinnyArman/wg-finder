import {
  Blocked, get, parseListing, parseAdText, flatmates, rentEur,
  type Ad, type CookieJar,
} from "./scraper.ts";
import { Store, type AdRow } from "./store.ts";
import {
  behaviourSummary, blockSecondsLeft, clearBlock, filtersSummary, fmtLeft,
  loadSettings, pause, pauseState, resume, setSetting, startBlock,
  type Profile, type Settings,
} from "./settings.ts";
import { compose } from "./writer.ts";
import { Telegram, esc, type Button } from "./telegram.ts";

export interface Env {
  DB: D1Database;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_OWNER_ID: string;
  WEBHOOK_SECRET: string;
}

const PENDLER = ["pendler", "wochenend", "zwischenmiete", "nur unter der woche",
  "mo-do", "mo - do", "monday to thursday", "weekdays only", "commuter"];

// The profile is ~4.5KB of JSON - too big for a Worker secret (5.1KB limit,
// and base64 inflates it). It lives in D1 instead, seeded by make-profile.sh.
// Cached per isolate so repeated invocations don't re-read or re-parse it.
let _profileCache: Profile | null = null;

async function profileOf(env: Env): Promise<Profile> {
  if (_profileCache) return _profileCache;
  const raw = await new Store(env.DB).kvGet("profile");
  if (!raw) {
    throw new Error(
      "No profile in D1. Run ./make-profile.sh then: " +
      "npx wrangler d1 execute wg-finder --remote --file=profile.sql");
  }
  _profileCache = JSON.parse(raw) as Profile;
  return _profileCache;
}

/** Session cookies persisted in D1 so we look like a returning visitor. */
function cookieJar(store: Store): CookieJar {
  return {
    read: () => store.kvGet("cookies"),
    write: (c: string) => store.kvSet("cookies", c),
  };
}

function passes(ad: Ad, s: Settings): [boolean, string] {
  const title = (ad.title || "").toLowerCase();
  for (const bad of s.skip_if_title_contains ?? [])
    if (title.includes(bad.toLowerCase())) return [false, `title contains '${bad}'`];
  if (s.skip_female_only && ad.seeking === "female") return [false, "WG wants a woman"];
  if (s.skip_pendler)
    for (const w of PENDLER) if (title.includes(w)) return [false, `Pendler room ('${w}')`];
  const rent = rentEur(ad);
  if (rent !== null) {
    if (s.max_rent && rent > s.max_rent) return [false, `${rent} EUR over max`];
    if (s.min_rent && rent < s.min_rent) return [false, `${rent} EUR under min`];
  }
  return [true, ""];
}

// ---------------------------------------------------------------- one step
/**
 * A single cron tick does ONE small thing, so no invocation comes near the
 * free plan's 10ms CPU budget:
 *   - if an ad is queued, fetch its description, draft it, send it
 *   - otherwise refresh the next city's listing
 */
async function step(env: Env, tg: Telegram): Promise<string> {
  const store = new Store(env.DB);
  const profile = await profileOf(env);

  const [paused] = await pauseState(store);
  if (paused) return "paused";

  const blockedFor = await blockSecondsLeft(store);
  if (blockedFor > 0) return `blocked ${fmtLeft(blockedFor)}`;

  const s = await loadSettings(store, profile);

  try {
    const queued = await store.nextQueued();
    if (queued) {
      const budget = s.max_per_hour - (await store.pushedSince(3600));
      if (budget <= 0) return "hourly cap reached";
      return await draftOne(env, tg, store, profile, queued);
    }
    return await refreshOneCity(env, store, profile, s);
  } catch (e) {
    if (e instanceof Blocked) {
      await startBlock(store, s.block_backoff_min);
      await tg.send(
        `<b>Paused: wg-gesucht wants a captcha</b>\n\n` +
        `This is their rate limiting, not a crash, and nothing is lost — ` +
        `every ad I hadn't got to is still queued.\n\n` +
        `<b>Trying again in ${s.block_backoff_min} minutes</b>, automatically. ` +
        `You don't need to do anything.\n\nCountdown: /settings`);
      return "captcha";
    }
    throw e;
  }
}

async function refreshOneCity(
  env: Env, store: Store, profile: Profile, s: Settings,
): Promise<string> {
  const searches = profile.searches ?? [];
  if (!searches.length) return "no searches configured";

  // The cron fires every 2 minutes, but that is the step rate, not the
  // crawl rate. Spread one full pass over poll_minutes: with 60 minutes and
  // 6 cities that is one listing every 10 minutes, ~6 requests an hour
  // instead of 30. Hammering the site is what gets us captcha'd.
  const gap = Math.max(60, Math.floor((s.poll_minutes * 60) / searches.length));
  const last = Number((await store.kvGet("last_refresh")) ?? 0);
  const nowTs = Math.floor(Date.now() / 1000);
  if (nowTs - last < gap) {
    return `idle (next city in ${Math.ceil((gap - (nowTs - last)) / 60)} min)`;
  }
  await store.kvSet("last_refresh", String(nowTs));

  // round-robin so each tick touches exactly one city
  const idx = Number((await store.kvGet("city_cursor")) ?? 0) % searches.length;
  await store.kvSet("city_cursor", String((idx + 1) % searches.length));
  const search = searches[idx];

  const html = await get(search.url, cookieJar(store));
  const ads = parseListing(html);
  const seen = await store.seenMany(ads.map((a) => a.ad_id));

  let queued = 0;
  for (const ad of ads) {
    if (seen.has(ad.ad_id)) continue;
    const [ok, why] = passes(ad, s);
    if (!ok) { await store.markFiltered(ad, why); continue; }
    await store.queue(ad, flatmates(ad));
    queued++;
  }
  return `${search.name}: ${ads.length} ads, ${queued} queued`;
}

async function draftOne(
  env: Env, tg: Telegram, store: Store, profile: Profile, row: AdRow,
): Promise<string> {
  const html = await get(row.url, cookieJar(store));
  const text = parseAdText(html);
  if (text.trim().length < 80) {
    await store.noteFailure(row.ad_id);
    return `${row.ad_id}: no usable ad text, requeued`;
  }

  const draft = await compose(env.OPENAI_API_KEY, env.OPENAI_MODEL, profile, {
    title: row.title, rent: row.rent, size: row.size,
    district: row.district, text, flatmates: row.flatmates,
  });

  await store.saveDraft(row.ad_id, draft.language, text, draft.message);
  await push(tg, row, draft.language, draft.facts_used, draft.thin_ad, draft.message);
  return `sent ${row.ad_id}`;
}

/** One screen that answers "is this thing working?" */
export async function statusReport(env: Env, store: Store, profile: Profile): Promise<string> {
  const s = await loadSettings(store, profile);
  const [paused, pstate] = await pauseState(store);
  const blockedFor = await blockSecondsLeft(store);
  const stats = await store.stats();
  const queued = await store.countQueued();
  const sentHour = await store.pushedSince(3600);
  const last = await store.lastPushed();

  let head: string;
  if (paused) head = `⏸ <b>Paused</b> — ${pstate}. Send /start to go again.`;
  else if (blockedFor)
    head = `⏳ <b>Waiting out a captcha</b> — back in ${fmtLeft(blockedFor)}. Nothing for you to do.`;
  else head = `✅ <b>Running</b> — checking every ${s.poll_minutes} min.`;

  const ago = last
    ? `${fmtLeft(Math.max(0, Math.floor(Date.now() / 1000) - last))} ago`
    : "nothing sent yet";
  const seen = Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing yet";

  return [
    head,
    "",
    `Sent this hour:  ${sentHour} of ${s.max_per_hour}`,
    `Waiting to draft: ${queued}`,
    `Last ad sent:    ${ago}`,
    `Cities watched:  ${(profile.searches ?? []).length}`,
    "",
    `Seen so far: ${seen}`,
  ].join("\n");
}


function header(row: AdRow, lang: string, used: string[], thin: boolean): string {
  const flag = lang === "de" ? "DE" : "EN";
  const warn = thin ? " · <i>thin ad</i>" : "";
  const extra = used.length ? `\n<i>used: ${esc(used.join(", "))}</i>` : "";
  return (
    `<b>${esc(row.title || "Untitled")}</b>\n` +
    `${esc(row.rent || "?")} · ${esc(row.size || "?")} · ${esc(row.district || "?")}\n` +
    (row.flatmates ? `${esc(row.flatmates)}\n` : "") +
    `written in <b>${flag}</b>${warn}${extra}\n` +
    `<a href="${esc(row.url)}">open the Anzeige</a>`
  );
}

const adKeyboard = (id: string): Button[][] => [[
  { text: "Approve", callback_data: `ok:${id}` },
  { text: "Rewrite", callback_data: `re:${id}` },
  { text: "Skip", callback_data: `no:${id}` },
]];

async function push(
  tg: Telegram, row: AdRow, lang: string, used: string[], thin: boolean, message: string,
) {
  const head = header(row, lang, used, thin);
  if (row.image) {
    try { await tg.sendPhoto(row.image, head); }
    catch { await tg.send(head); }
  } else {
    await tg.send(head);
  }
  await tg.send(`<pre>${esc(message)}</pre>`, tg.keyboard(adKeyboard(row.ad_id)));
}

// ------------------------------------------------------------- webhook
function parseDuration(t: string): number | null {
  const s = (t || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "tomorrow") return 12 * 3600;
  const m = /^(\d+)\s*([mhd]?)$/.exec(s);
  if (!m) return null;
  const mult = { m: 60, h: 3600, d: 86400 }[m[2] || "m"]!;
  return Number(m[1]) * mult;
}

const settingsKeyboard = (s: Settings, paused: boolean): Button[][] => [
  [{ text: paused ? "Resume searching" : "Pause searching",
     callback_data: paused ? "set:resume" : "set:pause" }],
  [{ text: "-5 min", callback_data: "set:poll_minutes:-5" },
   { text: `every ${s.poll_minutes} min`, callback_data: "set:noop" },
   { text: "+5 min", callback_data: "set:poll_minutes:+5" }],
  [{ text: "-1", callback_data: "set:max_per_hour:-1" },
   { text: `${s.max_per_hour} ads/hour`, callback_data: "set:noop" },
   { text: "+1", callback_data: "set:max_per_hour:+1" }],
];

const filtersKeyboard = (s: Settings): Button[][] => [
  [{ text: `[${s.skip_female_only ? "ON " : "OFF"}] skip women-only`,
     callback_data: "flt:skip_female_only" }],
  [{ text: `[${s.skip_pendler ? "ON " : "OFF"}] skip Pendler rooms`,
     callback_data: "flt:skip_pendler" }],
  [{ text: `max rent ${s.max_rent} (-50)`, callback_data: "flt:max_rent:-50" },
   { text: "(+50)", callback_data: "flt:max_rent:+50" }],
];

async function handleUpdate(update: any, env: Env, tg: Telegram): Promise<void> {
  const store = new Store(env.DB);
  const profile = await profileOf(env);

  const text: string = update.message?.text ?? "";
  const isCommand = text.startsWith("/");

  // Ordinary group chatter is none of our business. Only commands and button
  // presses are even considered - otherwise the bot would answer every
  // message anyone sends in the group.
  if (!update.callback_query && !isCommand) return;

  const from = update.message?.from ?? update.callback_query?.from;
  const owner = String(env.TELEGRAM_OWNER_ID || env.TELEGRAM_CHAT_ID);
  const name = (profile.about as any)?.name ?? "its owner";
  if (!from || String(from.id) !== owner) {
    const deny = `Sorry, this bot was built for ${name}'s own flat search and only answers to them.`;
    if (update.callback_query) {
      await tg.answerCallback(update.callback_query.id, deny, true);
    } else {
      // someone else typed a command at it - say so once, in that chat
      await tg.send(deny, {}, String(update.message.chat.id));
    }
    return;
  }

  if (update.callback_query) return handleButton(update.callback_query, env, tg, store, profile);

  const chat = String(update.message.chat.id);
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0];
  const reply = (t: string, o: Record<string, unknown> = {}) => tg.send(t, o, chat);

  switch (cmd) {
    case "/start":
    case "/resume": {
      const [wasPaused] = await pauseState(store);
      if (wasPaused) await resume(store);
      const note = wasPaused ? "Started.\n\n" : "";
      await reply(note + (await statusReport(env, store, profile)) +
        `\n\n/status — is it running\n/pause [2h] — stop it\n` +
        `/scan — check now\n/more [n] — send more now\n` +
        `/filters — which ads qualify\n/settings — timing\n/stats — totals`);
      return;
    }

    case "/status":
      await reply(await statusReport(env, store, profile));
      return;

    case "/help":
      await reply(
        `/start — start it (also un-pauses)\n/status — is it running\n` +
        `/pause [2h] — stop it\n/scan — check now\n/more [n] — send more now\n` +
        `/filters — which ads qualify\n/settings — timing\n` +
        `/stats — totals\n/retry — re-draft failed`);
      return;

    case "/stats": {
      const st = await store.stats();
      const body = Object.entries(st).map(([k, v]) => `${k}: ${v}`).join("\n");
      await reply(body || "Nothing seen yet.");
      return;
    }

    case "/settings": {
      if (args.length >= 2) {
        const { ok, msg } = await setSetting(store, profile, args[0], args[1]);
        await reply(msg);
        if (!ok) return;
      }
      const s = await loadSettings(store, profile);
      const [p] = await pauseState(store);
      await reply(await behaviourSummary(store, profile),
        tg.keyboard(settingsKeyboard(s, p)));
      return;
    }

    case "/filters": {
      if (args.length >= 2) {
        const { ok, msg } = await setSetting(store, profile, args[0], args[1]);
        await reply(msg);
        if (!ok) return;
      }
      const s = await loadSettings(store, profile);
      await reply(await filtersSummary(store, profile),
        tg.keyboard(filtersKeyboard(s)));
      return;
    }

    case "/pause": {
      const secs = args[0] ? parseDuration(args[0]) : null;
      if (args[0] && secs === null) {
        await reply("Try /pause, /pause 30m, /pause 2h, /pause 1d");
        return;
      }
      const msg = await pause(store, secs);
      await reply(`${msg}. Nothing is lost — queued ads stay queued. /start when you want it back.`);
      return;
    }

    case "/scan": {
      const left = await blockSecondsLeft(store);
      if (left) {
        await reply(`Still blocked by wg-gesucht — trying again in ${fmtLeft(left)}.`);
        return;
      }
      const r = await step(env, tg);
      await reply(`Checked: ${r}`);
      return;
    }

    case "/more": {
      const n = Math.min(Math.max(Number(args[0] ?? 3) || 3, 1), 10);
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(await step(env, tg));
      await reply(out.join("\n"));
      return;
    }

    case "/retry": {
      const n = await store.retryFailed();
      await clearBlock(store);
      await reply(`Cleared ${n} failed ad(s).`);
      return;
    }

    default:
      await reply("Unknown command. /help");
      return;
  }
}

async function handleButton(
  cq: any, env: Env, tg: Telegram, store: Store, profile: Profile,
): Promise<void> {
  const data: string = cq.data ?? "";
  const chat = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;

  if (data.startsWith("set:") || data.startsWith("flt:")) {
    const parts = data.split(":");
    const isSettings = parts[0] === "set";
    if (parts[1] === "noop") {
      await tg.answerCallback(cq.id);
      return;
    }
    if (parts[1] === "pause") { await pause(store, null); await tg.answerCallback(cq.id, "Paused"); }
    else if (parts[1] === "resume") { await resume(store); await tg.answerCallback(cq.id, "Running again"); }
    else {
      const cur = await loadSettings(store, profile);
      const key = parts[1] as keyof Settings;
      const val = parts.length === 3
        ? Number(cur[key]) + Number(parts[2])
        : !cur[key];
      const { msg } = await setSetting(store, profile, key, val as never);
      await tg.answerCallback(cq.id, msg);
    }
    const s = await loadSettings(store, profile);
    const [p] = await pauseState(store);
    const body = isSettings
      ? await behaviourSummary(store, profile)
      : await filtersSummary(store, profile);
    const kb = isSettings ? settingsKeyboard(s, p) : filtersKeyboard(s);
    try { await tg.editText(chat, msgId, body, kb); } catch { /* unchanged */ }
    return;
  }

  const [action, adId] = data.split(":");
  const row = await store.get(adId);
  if (!row) {
    await tg.answerCallback(cq.id, "Unknown ad.");
    return;
  }

  if (action === "no") {
    await store.setStatus(adId, "skipped");
    await tg.answerCallback(cq.id, "Skipped");
    await tg.clearKeyboard(chat, msgId);
    return;
  }

  if (action === "ok") {
    await store.setStatus(adId, "approved");
    await tg.answerCallback(cq.id, "Here you go");
    await tg.clearKeyboard(chat, msgId);
    await tg.send(`<pre>${esc(row.message ?? "")}</pre>`, {}, String(chat));
    await tg.send(`Paste it here: ${row.url}`, {}, String(chat));
    return;
  }

  if (action === "re") {
    await tg.answerCallback(cq.id, "Rewriting…");
    await tg.clearKeyboard(chat, msgId);
    const draft = await compose(
      env.OPENAI_API_KEY, env.OPENAI_MODEL, profile,
      { title: row.title, rent: row.rent, size: row.size,
        district: row.district, text: row.ad_text, flatmates: row.flatmates },
      "The previous draft was rejected. Take a noticeably different angle, " +
      "open with a different detail, and vary the rhythm.");
    await store.saveDraft(adId, draft.language, row.ad_text ?? "", draft.message);
    await push(tg, row, draft.language, draft.facts_used, draft.thin_ad, draft.message);
  }
}

// ------------------------------------------------------------- entrypoints
export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
    ctx.waitUntil(step(env, tg).then(
      (r) => console.log("step:", r),
      (e) => console.error("step failed:", e?.message ?? e)));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method !== "POST") return new Response("wg-finder", { status: 200 });

    // Telegram signs every webhook call with the secret we registered.
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
      return new Response("forbidden", { status: 403 });

    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
    try {
      await handleUpdate(await req.json(), env, tg);
    } catch (e: any) {
      console.error("update failed:", e?.message ?? e);
    }
    return new Response("ok");   // always 200 so Telegram doesn't retry
  },
};
