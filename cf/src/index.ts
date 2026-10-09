import {
  Blocked, get, parseListing, parseAdText, flatmates,
  type Ad, type CookieJar,
} from "./scraper.ts";
import {
  KA_PREFIX, parseListing as kaParseListing, parseAd as kaParseAd,
} from "./kleinanzeigen.ts";
import { check, looksFemaleOnly } from "./filters.ts";
import { Store, type AdRow } from "./store.ts";
import {
  SITE, SOURCES, behaviourSummary, blocks, clearBlock, filtersSummary, fmtLeft,
  loadSettings, pause, pauseState, resume, setSetting, startBlock,
  type Profile, type Settings, type Source,
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

const sourceOfUrl = (url: string): Source => (url.includes("kleinanzeigen.de") ? "ka" : "wg");
const sourceOfId = (id: string): Source => (id.startsWith(KA_PREFIX) ? "ka" : "wg");

/**
 * Session cookies persisted in D1 so we look like a returning visitor.
 * One jar per site - their sessions have nothing to do with each other.
 */
function cookieJar(store: Store, src: Source): CookieJar {
  const key = src === "wg" ? "cookies" : "cookies_ka";
  return { read: () => store.kvGet(key), write: (c: string) => store.kvSet(key, c) };
}

/** A site answered normally again: the next block gets reported afresh. */
async function clearOutage(store: Store, src: Source): Promise<void> {
  if ((await store.kvGet(`block_notified_${src}`)) === "1")
    await store.kvSet(`block_notified_${src}`, "0");
}

// ---------------------------------------------------------------- one step
/**
 * A single cron tick does ONE small thing, so no invocation comes near the
 * free plan's 10ms CPU budget:
 *   - if an ad is queued, fetch its description, draft it, send it
 *   - otherwise refresh the next search's listing
 * A site that is backing off is simply skipped; the other keeps working.
 */
async function step(env: Env, tg: Telegram, force = false): Promise<string> {
  const store = new Store(env.DB);
  const profile = await profileOf(env);

  const [paused] = await pauseState(store);
  if (paused) return "paused";

  const b = await blocks(store);
  if (SOURCES.every((x) => b[x] > 0))
    return `blocked (${SOURCES.map((x) => `${SITE[x]} ${fmtLeft(b[x])}`).join(", ")})`;

  const s = await loadSettings(store, profile);

  try {
    const queued = await store.nextQueued({ wg: b.wg > 0, ka: b.ka > 0 });
    if (queued) {
      // /more deliberately overrides the hourly cap
      if (!force) {
        const budget = s.max_per_hour - (await store.pushedSince(3600));
        if (budget <= 0) return "hourly cap reached";
      }
      return await draftOne(env, tg, store, profile, queued);
    }
    return await refreshOneSearch(store, profile, s, b);
  } catch (e) {
    if (e instanceof Blocked) {
      await startBlock(store, s.block_backoff_min, e.source);
      // A flagged session is what keeps a block going, so start the retry
      // with a clean one.
      await store.kvSet(e.source === "wg" ? "cookies" : "cookies_ka", "");
      // Tell the user once per outage, not on every failed retry.
      if ((await store.kvGet(`block_notified_${e.source}`)) === "1")
        return `${SITE[e.source]} still blocked`;
      await store.kvSet(`block_notified_${e.source}`, "1");
      const other = SITE[e.source === "wg" ? "ka" : "wg"];
      await tg.send(
        `<b>${SITE[e.source]} wants a bot check</b>\n\n` +
        `This is their rate limiting, not a crash, and nothing is lost — ` +
        `every ad I hadn't got to is still queued.\n\n` +
        `<b>Trying ${SITE[e.source]} again in ${s.block_backoff_min} minutes</b>, ` +
        `automatically. ${other} keeps running meanwhile.\n\nCountdown: /status`);
      return `${SITE[e.source]} blocked`;
    }
    throw e;
  }
}

async function refreshOneSearch(
  store: Store, profile: Profile, s: Settings, b: Record<Source, number>,
): Promise<string> {
  const searches = profile.searches ?? [];
  if (!searches.length) return "no searches configured";

  // Weighted checking. Each search keeps its own "last checked" time; busy
  // ones (hot: true) are due every hot_minutes, quiet ones every
  // poll_minutes. A tick fetches at most one listing - the most overdue - so
  // the cron's 2-minute rate stays the ceiling, not the crawl rate. Keyed by
  // URL, so reordering the searches in the profile doesn't reset anything.
  const nowTs = Math.floor(Date.now() / 1000);
  const checked = await store.kvPrefix("checked:");
  let pick = -1, mostOverdue = -1, soonest = Infinity;
  searches.forEach((sr, i) => {
    if (b[sourceOfUrl(sr.url)] > 0) return;                 // site backing off
    const every = (sr.hot ? s.hot_minutes : s.poll_minutes) * 60;
    const due = Number(checked["checked:" + sr.url] ?? 0) + every;
    if (due <= nowTs && nowTs - due > mostOverdue) { mostOverdue = nowTs - due; pick = i; }
    soonest = Math.min(soonest, due);
  });
  if (pick < 0) {
    if (soonest === Infinity) return "every search is backing off";
    return `idle (next check in ${Math.max(1, Math.ceil((soonest - nowTs) / 60))} min)`;
  }
  const search = searches[pick];
  const src = sourceOfUrl(search.url);
  await store.kvSet("checked:" + search.url, String(nowTs));

  const html = await get(search.url, cookieJar(store, src));
  await clearOutage(store, src);
  const ads: Ad[] = src === "ka" ? kaParseListing(html) : parseListing(html);
  const seen = await store.seenMany(ads.map((a) => a.ad_id));

  let queued = 0;
  for (const ad of ads) {
    if (seen.has(ad.ad_id)) continue;
    const [ok, why] = check(ad, s);
    if (!ok) { await store.markFiltered(ad, why); continue; }
    await store.queue(ad, flatmates(ad));
    queued++;
  }
  return `${search.name}: ${ads.length} ads, ${queued} queued`;
}

async function draftOne(
  env: Env, tg: Telegram, store: Store, profile: Profile, row: AdRow,
): Promise<string> {
  const src = sourceOfId(row.ad_id);
  const html = await get(row.url, cookieJar(store, src));
  await clearOutage(store, src);

  let text: string;
  let details: Record<string, string> = {};
  if (src === "ka") [text, details] = kaParseAd(html);
  else text = parseAdText(html);

  // The title passed, but the full description can still say women only.
  // Catch it here, before paying for a draft.
  const fem = looksFemaleOnly(text);
  if (fem) {
    await store.setStatus(row.ad_id, "filtered");
    return `${row.ad_id}: women only ('${fem}'), skipped`;
  }
  if (text.trim().length < 80) {
    await store.noteFailure(row.ad_id);
    return `${row.ad_id}: no usable ad text, requeued`;
  }

  // Kleinanzeigen only reveals the flatmate count on the detail page.
  const n = details["Anzahl Mitbewohner"] ?? "";
  const flat = /^\d+$/.test(n) ? `WG · ${n} Mitbewohner` : row.flatmates;
  const ready: AdRow = { ...row, flatmates: flat };

  // A failure here must count as an attempt. Otherwise the ad stays queued
  // and every 2-minute tick re-fetches the same detail page - an outage at
  // OpenAI would turn into 30 requests an hour against one listing.
  let draft;
  try {
    draft = await compose(env.OPENAI_API_KEY, env.OPENAI_MODEL, profile, {
      title: row.title, rent: row.rent, size: row.size,
      district: row.district, text, flatmates: flat, details,
    });
  } catch (e) {
    await store.noteFailure(row.ad_id);
    throw e;
  }

  // Deliver FIRST, then mark it done. Marking first meant a failed send
  // looked like a success: the ad showed as 'pending' with a pushed_at
  // timestamp while nothing ever reached Telegram.
  try {
    await push(tg, ready, draft.language, draft.facts_used, draft.thin_ad, draft.message);
  } catch (e: any) {
    // keep the draft so we don't pay OpenAI twice, but leave it queued
    await store.keepDraft(row.ad_id, draft.language, text, draft.message);
    console.error(`delivery failed for ${row.ad_id}:`, e?.message ?? e);
    throw new Error(`Telegram delivery failed: ${e?.message ?? e}`);
  }
  await store.saveDraft(row.ad_id, draft.language, text, draft.message, flat);
  return `sent ${row.ad_id}`;
}

/** One screen that answers "is this thing working?" */
export async function statusReport(env: Env, store: Store, profile: Profile): Promise<string> {
  const s = await loadSettings(store, profile);
  const [paused, pstate] = await pauseState(store);
  const b = await blocks(store);
  const stats = await store.stats();
  const queued = await store.countQueued();
  const sentHour = await store.pushedSince(3600);
  const last = await store.lastPushed();

  const down = SOURCES.filter((x) => b[x] > 0);
  let head: string;
  if (paused) head = `⏸ <b>Paused</b> — ${pstate}. Send /start to go again.`;
  else if (down.length === SOURCES.length)
    head = `⏳ <b>Waiting out bot checks</b> — nothing for you to do.`;
  else {
    const all = profile.searches ?? [];
    const hot = all.filter((x) => x.hot).length;
    const quiet = all.length - hot;
    const hrs = (m: number) => (m % 60 === 0 && m >= 60 ? `${m / 60} h` : `${m} min`);
    head = `✅ <b>Running</b> — ` + [
      hot ? `${hot} busy search${hot > 1 ? "es" : ""} every ${hrs(s.hot_minutes)}` : "",
      quiet ? `${quiet} quiet one${quiet > 1 ? "s" : ""} every ${hrs(s.poll_minutes)}` : "",
    ].filter(Boolean).join(", ") + ".";
  }

  // one line per site, so a block on one is visible without hiding the other
  const siteLines = SOURCES.map((x) =>
    `${SITE[x].padEnd(14)} ${b[x] > 0 ? `⏳ back in ${fmtLeft(b[x])}` : "✅ ok"}`);

  const ago = last
    ? `${fmtLeft(Math.max(0, Math.floor(Date.now() / 1000) - last))} ago`
    : "nothing sent yet";
  const seen = Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing yet";

  return [
    head,
    "",
    ...siteLines,
    "",
    `Sent this hour:  ${sentHour} of ${s.max_per_hour}`,
    `Waiting to draft: ${queued}`,
    `Last ad sent:    ${ago}`,
    `Searches:        ${(profile.searches ?? []).length}`,
    ...(stats.pending ? [`Waiting on you:  ${stats.pending}  → /review`] : []),
    "",
    `Seen so far: ${seen}`,
  ].join("\n");
}


function header(row: AdRow, lang: string, used: string[], thin: boolean): string {
  const flag = lang === "de" ? "DE" : "EN";
  const site = SITE[sourceOfId(row.ad_id)];
  const warn = thin ? " · <i>thin ad</i>" : "";
  const extra = used.length ? `\n<i>used: ${esc(used.join(", "))}</i>` : "";
  return (
    `<b>${esc(row.title || "Untitled")}</b>\n` +
    `${esc(row.rent || "?")} · ${esc(row.size || "?")} · ${esc(row.district || "?")}\n` +
    (row.flatmates ? `${esc(row.flatmates)}\n` : "") +
    `written in <b>${flag}</b> · via ${site}${warn}${extra}\n` +
    `<a href="${esc(row.url)}">open the Anzeige</a>`
  );
}

// ------------------------------------------------------------- review
// /review walks through ads that were sent but never approved or skipped.

function sentAgo(ts: number | null): string {
  if (!ts) return "";
  const m = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60));
  if (m < 60) return ` · sent ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? ` · sent ${h}h ago` : ` · sent ${Math.floor(h / 24)} days ago`;
}

/** The ad and its draft as one message (the draft stays tap-to-copy). */
function adBlock(row: AdRow): string {
  const draft = (row.message ?? "(no draft stored)").slice(0, 3200);  // 4096 cap
  return (
    `<b>${esc(row.title || "Untitled")}</b>\n` +
    `${esc(row.rent || "?")} · ${esc(row.size || "?")} · ${esc(row.district || "?")}\n` +
    (row.flatmates ? `${esc(row.flatmates)}\n` : "") +
    `via ${SITE[sourceOfId(row.ad_id)]} · <a href="${esc(row.url)}">open the Anzeige</a>\n\n` +
    `<pre>${esc(draft)}</pre>`
  );
}

async function reviewCard(store: Store, row: AdRow): Promise<string> {
  const pos = await store.pendingPosition(row.ad_id);
  const total = await store.countPending();
  return `🗂 <b>Review ${pos} of ${total}</b>${sentAgo(row.pushed_at)}\n\n` + adBlock(row);
}

const reviewKeyboard = (id: string): Button[][] => [
  [{ text: "Approve ✅", callback_data: `rv:ok:${id}` },
   { text: "Skip ⏭", callback_data: `rv:no:${id}` }],
  [{ text: "Later ⏸", callback_data: `rv:later:${id}` },
   { text: "Stop", callback_data: `rv:stop:${id}` }],
];

const reviewDone = (left: number) => left
  ? `Done for now — ${left} you put off with Later are still waiting. /review to go through them again.`
  : "✅ All caught up — nothing left to decide.";

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
  [{ text: "-5 min", callback_data: "set:hot_minutes:-5" },
   { text: `busy every ${s.hot_minutes} min`, callback_data: "set:noop" },
   { text: "+5 min", callback_data: "set:hot_minutes:+5" }],
  [{ text: "-30 min", callback_data: "set:poll_minutes:-30" },
   { text: `quiet every ${s.poll_minutes} min`, callback_data: "set:noop" },
   { text: "+30 min", callback_data: "set:poll_minutes:+30" }],
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
        `\n\n/status — is it running\n/review — decide on ads you haven't answered\n` +
        `/pause [2h] — stop it\n` +
        `/scan — check now\n/more [n] — send more now\n` +
        `/filters — which ads qualify\n/settings — timing\n/stats — totals`);
      return;
    }

    case "/review": {
      const first = await store.nextPending();
      if (!first) {
        await reply("Nothing waiting on you — every ad you were sent is approved or skipped.");
        return;
      }
      await reply(await reviewCard(store, first), tg.keyboard(reviewKeyboard(first.ad_id)));
      return;
    }

    case "/status":
      await reply(await statusReport(env, store, profile));
      return;

    case "/help":
      await reply(
        `/start — start it (also un-pauses)\n/status — is it running\n` +
        `/review — decide on ads you haven't answered\n` +
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
      const b = await blocks(store);
      if (SOURCES.every((x) => b[x] > 0)) {
        await reply("Both sites are backing off:\n" + SOURCES.map((x) =>
          `${SITE[x]} — trying again in ${fmtLeft(b[x])}`).join("\n"));
        return;
      }
      const r = await step(env, tg);
      await reply(`Checked: ${r}`);
      return;
    }

    case "/more": {
      const n = Math.min(Math.max(Number(args[0] ?? 3) || 3, 1), 10);
      await reply(`Sending up to ${n} now, ignoring the hourly cap…`);
      let sent = 0;
      const notes: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await step(env, tg, true);          // force past the cap
        if (r.startsWith("sent ")) sent++;
        else { notes.push(r); break; }                // queue empty, blocked, paused
      }
      const tail = notes.length ? `\n${notes[0]}` : "";
      await reply(`Sent ${sent} ad${sent === 1 ? "" : "s"}.${tail}`);
      return;
    }

    case "/retry": {
      const n = await store.retryFailed();
      for (const x of SOURCES) await clearBlock(store, x);
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

  if (data.startsWith("rv:")) {
    // ad ids never contain ":" (wg-gesucht digits, Kleinanzeigen "ka-" + digits)
    const [, act, adId] = data.split(":");
    if (act === "stop") {
      await tg.answerCallback(cq.id, "Review stopped");
      await tg.editText(chat, msgId,
        `Review stopped — ${await store.countPending()} still waiting on you. /review to continue.`, []);
      return;
    }
    const row = await store.get(adId);
    if (!row) {
      await tg.answerCallback(cq.id, "Unknown ad.");
      return;
    }
    if (act === "ok") await store.setStatus(adId, "approved");
    if (act === "no") await store.setStatus(adId, "skipped");

    const next = await store.nextPending(adId);
    const toast = act === "ok" ? "Approved ✅" : act === "no" ? "Skipped" : "Later";
    await tg.answerCallback(cq.id, next ? toast : `${toast} — that was the last one`);

    if (act === "ok") {
      // Keep the approved draft right here to copy; the next ad gets its own card.
      await tg.editText(chat, msgId, adBlock(row) + "\n\n<b>Approved ✅</b>", []);
      if (next)
        await tg.send(await reviewCard(store, next), tg.keyboard(reviewKeyboard(next.ad_id)), String(chat));
      return;
    }
    // Skip / Later: turn this same message into the next ad - nothing new posted.
    if (next) await tg.editText(chat, msgId, await reviewCard(store, next), reviewKeyboard(next.ad_id));
    else await tg.editText(chat, msgId, reviewDone(await store.countPending()), []);
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
    await tg.answerCallback(cq.id, "Approved ✅");
    // Stamp the draft in place rather than posting anything new: it is
    // already a tap-to-copy block, and the ad link is in the card above.
    // Prefer the text as shown; Telegram omits it on messages it considers
    // inaccessible (very old ones), so fall back to the stored draft.
    const shown: string = cq.message?.text ?? row.message ?? "";
    try {
      // an empty keyboard removes the buttons in the same call
      await tg.editText(chat, msgId, `<pre>${esc(shown)}</pre>\n\n<b>Approved ✅</b>`, []);
    } catch (e: any) {
      console.error(`approve edit failed for ${adId}:`, e?.message ?? e);
    }
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
