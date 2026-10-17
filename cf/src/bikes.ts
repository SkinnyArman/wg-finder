// Free and cheap bikes around Cottbus, rated by AI, straight to Telegram.
//
// Kept apart from the WG search on purpose:
//   - its own cron (odd minutes), which never lands on the WG job's
//     even-minute ticks, so each invocation has its own CPU budget
//   - its own backoff and cookie jar, so Kleinanzeigen rate-limiting the bike
//     search never pauses the WG search
//   - its own settings and on/off, open to everyone in the group
//
// Each tick stays small: the listing check when it's due (every 30 min),
// then reading + rating at most two new ads. Parsing all of that is ~2.5ms
// of CPU, well inside the free plan's budget, and it spreads the requests to
// Kleinanzeigen out instead of bursting them.

import { Blocked, get, type CookieJar } from "./scraper.ts";
import { parseListing, parseAd } from "./kleinanzeigen.ts";
import { assessBike } from "./bikeai.ts";
import { blockSecondsLeft, fmtLeft } from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, type Button, type Telegram } from "./telegram.ts";

export const BIKES_CRON = "5,15,25,35,45,55 * * * *";
export const RADIUS_KM = 30;
const LIST_EVERY_MIN = 30;
const ASSESS_PER_TICK = 2;
// Telegram allows about 20 messages a minute into a group.
const SEND_PER_TICK = 6;
const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [60, 120, 240, 360];   // consecutive blocks -> minutes
const LOCK_SECONDS = 300;                  // a tick takes ~20s; a dead one frees it

export interface BikeEnv {
  DB: D1Database;
  OPENAI_API_KEY: string;
  BIKES_MODEL?: string;
}

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fahrräder & Zubehör (c217), offers only, up to max € ("Zu verschenken"
// counts as 0 €), RADIUS_KM around Cottbus (l7743), newest first. Far fewer
// than a page (25) of new ads appear in 30 minutes, so page 1 is enough.
export const searchUrl = (maxPrice: number) =>
  "https://www.kleinanzeigen.de/s-fahrraeder/cottbus/anzeige:angebote/" +
  `preis::${maxPrice}/c217l7743r${RADIUS_KM}`;

// ---------------------------------------------------------------- settings
export interface BikeSettings { on: boolean; max_price: number; min_score: number }

const BOUNDS = { max_price: [0, 300], min_score: [0, 10] } as const;

export async function loadBikeSettings(store: Store): Promise<BikeSettings> {
  const num = async (k: string, d: number) => {
    const raw = await store.kvGet(k);
    const v = Number(raw);
    return raw === null || !Number.isFinite(v) ? d : v;
  };
  return {
    on: (await store.kvGet("bikes_on")) !== "0",
    max_price: await num("bikes_max_price", 30),
    min_score: await num("bikes_min_score", 0),
  };
}

export async function setBikeSetting(
  store: Store, key: "max_price" | "min_score", value: number,
): Promise<string> {
  const [lo, hi] = BOUNDS[key];
  const v = Math.min(hi, Math.max(lo, Math.round(value)));
  await store.kvSet(`bikes_${key}`, String(v));
  return key === "max_price"
    ? `Max price is now ${v} €`
    : v ? `Only bikes rated ${v}/10 or better` : "Every bike gets posted, whatever its rating";
}

export const setBikes = (store: Store, on: boolean) => store.kvSet("bikes_on", on ? "1" : "0");

// ---------------------------------------------------------------- filter
// A cheap first pass on the title, so the AI only reads plausible bikes. The
// category mixes whole bikes with parts and accessories. Judge the title up
// to the first "mit"/"inkl"/comma: "Kinderfahrrad mit Stützrädern" is a bike,
// "2 Stützräder für Kinderfahrrad" is not. German compounds put the thing
// itself last ("Fahrradhelm" is a helmet), so these words also count at the
// end of a longer word. Anything unsure goes on to the AI.

const NOT_BIKE = /hoverboard|scooter|segway|tretroller|\broller\b|skateboard|inliner|heimtrainer|hometrainer|ergometer|spinning|kinderwagen|buggy/;
const SEARCHING = /\b(suche|gesucht)\b/;

// Sold on their own, never a bike: "Drahtreifen", "Alu-Pedale", "Fahrradhelm"
const PART = [
  "reifen", "schlauch", "mantel", "felge", "felgen", "kassette", "ritzel", "kette",
  "pedal", "pedale", "teile", "hinterrad", "vorderrad", "laufradsatz", "bremse",
  "bremsen", "bremsbeläge", "hebel", "schaltwerk", "umwerfer", "kurbel", "nabe",
  "nabenmotor", "akku", "ladegerät", "werkzeug", "helm", "pumpe", "kindersitz",
  "kindersitze", "fahrradsitz", "sitzbezug", "anhänger", "halterung", "tacho",
  "computer", "handschuhe", "trikot", "hose", "schuhe", "brille", "schutz",
  "schützer", "flaschenhalter", "cape", "hupe", "griffe",
];
// Often listed as a bike's features ("Damenrad 28 Zoll Gepäckträger Korb"):
// only a part when no bike word comes before it.
const FEATURE = [
  "schloss", "träger", "ständer", "klingel", "halter", "stützrad", "stützräder",
  "beleuchtung", "lampe", "rücklicht", "frontlicht", "scheinwerfer", "spiegel",
  "schutzblech", "schutzbleche", "tasche", "taschen", "korb", "sattel", "lenker",
  "gabel",
];
// whole words only - as word endings these would hit "Besitz", "vielleicht"
const PART_WORD = new Set([
  "motor", "helmet", "lock", "pump", "tire", "tires", "tyre", "tube", "pedals",
  "saddle", "chain", "cassette", "brake", "brakes", "pads", "rack", "bag",
  "bottle", "grips", "mudguard", "fender", "bell", "horn",
]);
const FEATURE_WORD = new Set(["licht", "sitz", "light", "lights"]);

const BIKE = /(rad|räder|bike|bikes|mtb|bmx|pedelec|cruiser|fixie|singlespeed)$/;
const NOT_A_WHOLE_BIKE = /(stütz|hinter|vorder|zahn|ketten|schwung)r(ad|äder)$/;
const isBike = (w: string) => BIKE.test(w) && !NOT_A_WHOLE_BIKE.test(w);

/** Why an ad clearly isn't a bike, or null if it might be one. */
export function rejectReason(title: string): string | null {
  // join hyphenated compounds: "Spike-Reifen" -> "spikereifen"
  const t = title.toLowerCase().replace(/([\p{L}\d])-(?=[\p{L}\d])/gu, "$1");
  if (NOT_BIKE.test(t)) return "not a bike";
  if (SEARCHING.test(t)) return "someone searching";
  const head = t.split(/\s+(?:mit|inkl\.?|inklusive|samt|sowie|und|plus)\s+|\s*[+&,/|]\s*|\s+-\s+/)[0];
  let bikeSeen = false;
  for (const w of head.split(/[^\p{L}\d]+/u)) {
    if (!w) continue;
    if (PART_WORD.has(w) || PART.some((p) => w.endsWith(p))) return `part (${w})`;
    if (!bikeSeen && (FEATURE_WORD.has(w) || FEATURE.some((p) => w.endsWith(p))))
      return `accessory (${w})`;
    if (isBike(w)) bikeSeen = true;
  }
  return null;
}

/** 0 for "Zu verschenken", the euro amount otherwise, null if none shown. */
export function priceEur(text: string): number | null {
  if (/verschenken/i.test(text)) return 0;
  const m = /(\d[\d.]*)\s*€/.exec(text);
  return m ? Number(m[1].replace(/\./g, "")) : null;
}

const distanceKm = (place: string): number | null => {
  const m = /(\d+)\s*km/.exec(place);
  return m ? Number(m[1]) : null;
};

/** Card thumbnails are tiny; ask for the size the ad page itself uses. */
const bigImage = (url: string) => url.replace(/rule=\$_\d+\.AUTO/, "rule=$_59.AUTO");

// ---------------------------------------------------------------- storage
const COLUMNS: Record<string, string> = {
  ad_id: "TEXT PRIMARY KEY", url: "TEXT NOT NULL", title: "TEXT", price: "TEXT",
  place: "TEXT", image: "TEXT", snippet: "TEXT",
  status: "TEXT NOT NULL",    // new -> ready -> sent | skipped | gone | failed
  why: "TEXT", attempts: "INTEGER NOT NULL DEFAULT 0",
  first_seen: "INTEGER NOT NULL", sent_at: "INTEGER",
  score: "INTEGER", kind: "TEXT", notes: "TEXT",
  rating_why: "TEXT",         // the score explained in one line
};
const tableReady = new WeakSet<D1Database>();

/** Created (or widened) on first use, so no manual migration is needed. */
async function ensureTable(db: D1Database): Promise<void> {
  if (tableReady.has(db)) return;
  const cols = Object.entries(COLUMNS).map(([k, t]) => `${k} ${t}`).join(", ");
  await db.prepare(`CREATE TABLE IF NOT EXISTS bikes (${cols})`).run();
  const { results } = await db.prepare("PRAGMA table_info(bikes)").all<{ name: string }>();
  const have = new Set((results ?? []).map((r) => r.name));
  for (const [k, t] of Object.entries(COLUMNS))
    if (!have.has(k)) await db.prepare(`ALTER TABLE bikes ADD COLUMN ${k} ${t.replace(" NOT NULL", "")}`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS bikes_status ON bikes(status)").run();
  tableReady.add(db);
}

interface BikeRow {
  ad_id: string; url: string; title: string; price: string; place: string;
  image: string; snippet: string; status: string; attempts: number;
  score: number | null; kind: string | null; notes: string | null;
  rating_why: string | null;
}

const jar = (store: Store): CookieJar => ({
  read: () => store.kvGet("cookies_bikes"),
  write: (c: string) => store.kvSet("cookies_bikes", c),
});

/**
 * One bike run at a time. Two can overlap - a "Check now" tap landing on a
 * cron tick, or Cloudflare firing old and new triggers while a cron change
 * rolls out - and both would rate and post the same ads. Taken atomically:
 * the upsert only overwrites a lock that has expired.
 */
async function takeLock(db: D1Database): Promise<boolean> {
  const t = now();
  const r = await db.prepare(
    `INSERT INTO kv (k, v) VALUES ('bikes_lock', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?`)
    .bind(String(t), t - LOCK_SECONDS).run();
  return (r.meta.changes ?? 0) > 0;
}

const setRow = (db: D1Database, id: string, fields: Record<string, unknown>) => {
  const keys = Object.keys(fields);
  return db.prepare(`UPDATE bikes SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE ad_id=?`)
    .bind(...keys.map((k) => fields[k]), id).run();
};

// ---------------------------------------------------------------- one tick
export async function bikeStep(
  env: BikeEnv, store: Store, tg: Telegram, forceList = false,
): Promise<string> {
  const db = env.DB;
  const s = await loadBikeSettings(store);
  if (!s.on) return "bikes: off";

  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  if (until > now()) return `bikes: backing off, ${fmtLeft(until - now())} left`;
  // While Kleinanzeigen is limiting the WG search, more requests from here
  // would only stretch that block out. Sit it out; the WG search isn't touched.
  const ka = await blockSecondsLeft(store, "ka");
  if (ka > 0) return `bikes: waiting, Kleinanzeigen is limiting the WG search (${fmtLeft(ka)})`;

  if (!(await takeLock(db))) return "bikes: another run is still going";
  try {
    await ensureTable(db);
    const did: string[] = [];
    try {
      const last = Number((await store.kvGet("bikes_checked")) ?? 0);
      if (forceList || now() - last >= (LIST_EVERY_MIN - 2) * 60)
        did.push(await checkListing(db, store, s));
      did.push(await assessSome(env, store, s));
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      return await backOff(store, tg, e.message);
    }
    if ((await store.kvGet("bikes_backoff")) !== "0") await store.kvSet("bikes_backoff", "0");
    if ((await store.kvGet("bikes_block_notified")) === "1") await store.kvSet("bikes_block_notified", "0");

    const sent = await sendReady(db, tg, s);
    if (did.length > 1 && did[1] === "nothing to rate") did.pop();
    return `bikes: ${did.join(", ")}${sent ? `, ${sent} sent` : ""}`;
  } finally {
    await store.kvSet("bikes_lock", "0");
  }
}

async function checkListing(db: D1Database, store: Store, s: BikeSettings): Promise<string> {
  const html = await get(searchUrl(s.max_price), jar(store));
  // only once it worked: after a block the next tick should look again
  await store.kvSet("bikes_checked", String(now()));
  const ads = parseListing(html);
  if (!ads.length) return "listing empty";

  const marks = ads.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT ad_id FROM bikes WHERE ad_id IN (${marks})`)
    .bind(...ads.map((a) => a.ad_id)).all<{ ad_id: string }>();
  const known = new Set((results ?? []).map((r) => r.ad_id));

  // The page is newest first; store oldest first so rowid order is the
  // order they were posted in, and alerts go out in that order too.
  let fresh = 0, maybe = 0;
  for (const ad of [...ads].reverse()) {
    if (known.has(ad.ad_id)) continue;
    fresh++;
    const price = priceEur(ad.rent);
    const km = distanceKm(ad.district);
    const why =
      price !== null && price > s.max_price ? `price ${ad.rent}`
      // a thin result page gets padded with ads from far away
      : km !== null && km > RADIUS_KM + 5 ? `too far (${km} km)`
      : rejectReason(ad.title);
    if (!why) maybe++;
    await db.prepare(
      `INSERT OR IGNORE INTO bikes
         (ad_id,url,title,price,place,image,snippet,status,why,first_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(ad.ad_id, ad.url, ad.title, ad.rent, ad.district, ad.image,
            ad.snippet ?? "", why ? "skipped" : "new", why, now()).run();
  }
  return `listing ${ads.length} ads, ${fresh} new, ${maybe} to rate`;
}

/** Read the full ad and let the AI decide and rate, for up to two new ads. */
async function assessSome(env: BikeEnv, store: Store, s: BikeSettings): Promise<string> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bikes WHERE status='new' ORDER BY first_seen, rowid LIMIT ?`)
    .bind(ASSESS_PER_TICK).all<BikeRow>();
  const rows = results ?? [];
  if (!rows.length) return "nothing to rate";

  const out: string[] = [];
  for (const [i, row] of rows.entries()) {
    // max price lowered since it was listed
    const price = priceEur(row.price);
    if (price !== null && price > s.max_price) {
      await setRow(db, row.ad_id, { status: "skipped", why: `price ${row.price}` });
      continue;
    }
    if (i) await sleep(1500 + Math.random() * 2000);    // don't fire pages back to back

    // Blocked propagates: the tick backs off as a whole
    const html = await get(row.url, jar(store));
    const [text, details] = parseAd(html);
    // a deleted ad redirects to a search page
    if (!text && html.includes("data-adid=")) {
      await setRow(db, row.ad_id, { status: "gone", why: "ad deleted" });
      out.push("1 gone");
      continue;
    }
    if (details["Art"] === "Zubehör") {
      await setRow(db, row.ad_id, { status: "skipped", why: "accessory (Art: Zubehör)" });
      out.push("1 accessory");
      continue;
    }

    try {
      const a = await assessBike(env.OPENAI_API_KEY, env.BIKES_MODEL || "gpt-5.6-luna", {
        title: row.title, price: row.price, place: row.place, details, text,
      });
      if (!a.is_bike) {
        await setRow(db, row.ad_id, { status: "skipped", why: `ai: ${a.reason || "not a bike"}` });
        out.push("1 not a bike");
        continue;
      }
      await setRow(db, row.ad_id, {
        status: "ready", score: a.score || null, kind: a.kind, notes: JSON.stringify(a.notes),
        rating_why: a.why,
      });
      out.push(`rated ${a.score}/10`);
    } catch (e: any) {
      // A free bike shouldn't be lost to an OpenAI outage: after a few tries
      // it goes out unrated.
      const tries = row.attempts + 1;
      await setRow(db, row.ad_id, tries >= MAX_ATTEMPTS
        ? { attempts: tries, status: "ready", why: "not rated: AI unavailable" }
        : { attempts: tries });
      console.error(`bike rating failed for ${row.ad_id}:`, e?.message ?? e);
      out.push("rating failed");
    }
  }
  return out.join(", ") || "nothing to rate";
}

async function backOff(store: Store, tg: Telegram, why: string): Promise<string> {
  const n = Number((await store.kvGet("bikes_backoff")) ?? 0);
  const mins = BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length - 1)];
  await store.kvSet("bikes_backoff", String(n + 1));
  await store.kvSet("bikes_blocked_until", String(now() + mins * 60));
  // A flagged session keeps a block going; retry with a clean one. This is
  // the bike search's own jar - the WG search's session is left alone.
  await store.kvSet("cookies_bikes", "");
  if ((await store.kvGet("bikes_block_notified")) !== "1") {
    await store.kvSet("bikes_block_notified", "1");
    await tg.send(
      `🚲 <b>Kleinanzeigen is rate-limiting the bike search</b>\n\n` +
      `Trying again in ${mins} minutes, automatically. Nothing is lost, and ` +
      `the WG search keeps its own schedule.`);
  }
  return `bikes: blocked (${why}), retry in ${mins} min`;
}

async function sendReady(db: D1Database, tg: Telegram, s: BikeSettings): Promise<number> {
  const { results } = await db.prepare(
    `SELECT * FROM bikes WHERE status='ready' ORDER BY first_seen, rowid LIMIT ?`)
    .bind(SEND_PER_TICK).all<BikeRow>();
  let sent = 0;
  for (const row of results ?? []) {
    // settings may have changed since it was rated
    if (s.min_score && row.score !== null && row.score < s.min_score) {
      await setRow(db, row.ad_id, { status: "skipped", why: `rated ${row.score}/10` });
      continue;
    }
    try {
      await deliver(tg, row);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // flood control: stop here, the rest stays queued for the next tick
      if (msg.includes(" 429")) break;
      const tries = row.attempts + 1;
      await setRow(db, row.ad_id, tries >= MAX_ATTEMPTS
        ? { attempts: tries, status: "failed" } : { attempts: tries });
      console.error(`bike alert failed for ${row.ad_id}:`, msg);
      continue;
    }
    await setRow(db, row.ad_id, { status: "sent", sent_at: now() });
    sent++;
  }
  return sent;
}

function caption(row: BikeRow): string {
  const free = priceEur(row.price) === 0;
  const notes: string[] = row.notes ? JSON.parse(row.notes) : [];
  const rating = row.score
    ? `⭐ <b>${row.score}/10</b>${row.kind ? ` · ${esc(row.kind)}` : ""}`
    : "⭐ not rated (AI unavailable)";
  const snip = row.snippet.length > 140 ? row.snippet.slice(0, 140).trimEnd() + "…" : row.snippet;
  return (
    `🚲 <b>${esc(row.title || "Fahrrad")}</b>\n` +
    (free ? "🆓 <b>Zu verschenken</b>" : `<b>${esc(row.price || "price?")}</b>`) +
    ` · ${esc(row.place || "?")}\n` +
    `${rating}\n` +
    (row.rating_why ? `<i>${esc(row.rating_why)}</i>\n` : "") +
    (notes.length ? notes.map((n) => `• ${esc(n)}`).join("\n") + "\n"
      : snip && !row.score ? `<i>${esc(snip)}</i>\n` : "") +
    `<a href="${esc(row.url)}">open on Kleinanzeigen</a>`
  );
}

async function deliver(tg: Telegram, row: BikeRow): Promise<void> {
  const text = caption(row);
  if (row.image) {
    try {
      await tg.sendPhoto(bigImage(row.image), text);
      return;
    } catch (e: any) {
      if (String(e?.message ?? e).includes(" 429")) throw e;
      // a photo Telegram can't fetch shouldn't cost the alert
    }
  }
  await tg.send(text);
}

// ---------------------------------------------------------------- status
export async function bikesStatus(db: D1Database, store: Store): Promise<string> {
  await ensureTable(db);
  const s = await loadBikeSettings(store);
  const checked = Number((await store.kvGet("bikes_checked")) ?? 0);
  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  const count = async (where: string, ...args: unknown[]) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM bikes WHERE ${where}`)
      .bind(...args).first<{ n: number }>())?.n ?? 0;

  const day = await count("status='sent' AND sent_at > ?", now() - 86400);
  const total = await count("status='sent'");
  const skipped = await count("status='skipped'");
  const queued = await count("status IN ('new','ready')");
  const ago = checked ? `${fmtLeft(Math.max(0, now() - checked))} ago` : "not yet";

  return [
    `🚲 <b>Bike alerts: ${s.on ? "✅ on" : "⏸ off"}</b>`,
    `Kleinanzeigen, ${RADIUS_KM} km around Cottbus, up to <b>${s.max_price} €</b> or free.`,
    `Every bike is read and rated out of 10 by AI before it's posted.`,
    "",
    `Min rating:   ${s.min_score ? `${s.min_score}/10` : "none, all bikes"}`,
    `Last check:   ${ago} (every ${LIST_EVERY_MIN} min)`,
    ...(until > now() ? [`Backing off:  ${fmtLeft(until - now())} left`] : []),
    `Posted (24h): ${day}`,
    `Posted total: ${total}`,
    `Filtered out: ${skipped} (parts, accessories, too pricey)`,
    ...(queued ? [`Being rated:  ${queued}`] : []),
    "",
    `<i>Anyone in this group can change these.</i>`,
  ].join("\n");
}

export const bikesKeyboard = (s: BikeSettings): Button[][] => [
  [{ text: "−5 €", callback_data: "bk:price:-5" },
   { text: `max ${s.max_price} €`, callback_data: "bk:noop" },
   { text: "+5 €", callback_data: "bk:price:+5" }],
  [{ text: "−1", callback_data: "bk:min:-1" },
   { text: s.min_score ? `min ⭐ ${s.min_score}/10` : "min ⭐ none", callback_data: "bk:noop" },
   { text: "+1", callback_data: "bk:min:+1" }],
  [{ text: s.on ? "⏸ Pause bike alerts" : "▶️ Resume bike alerts", callback_data: s.on ? "bk:off" : "bk:on" },
   { text: "🔄 Check now", callback_data: "bk:now" }],
];

/** One line for /status. */
export async function bikesLine(store: Store): Promise<string> {
  const s = await loadBikeSettings(store);
  if (!s.on) return "Bike alerts:     ⏸ off  → /bikes";
  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  if (until > now()) return `Bike alerts:     ⏳ back in ${fmtLeft(until - now())}`;
  const checked = Number((await store.kvGet("bikes_checked")) ?? 0);
  return `Bike alerts:     ✅ on, ≤ ${s.max_price} €` +
    (checked ? `, checked ${fmtLeft(Math.max(0, now() - checked))} ago` : "");
}
