// Port of the Python regex extractor. No DOM: a 344KB listing page costs
// ~1.5ms this way instead of ~54ms with a real parser.

import { isBlocked as kaIsBlocked } from "./kleinanzeigen.ts";

export const BASE = "https://www.wg-gesucht.de";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
};

export interface Ad {
  ad_id: string;
  url: string;
  title: string;
  rent: string;
  size: string;
  district: string;
  image: string;
  seeking: "" | "any" | "female" | "male";
  wg_size: number;
  women: number;
  men: number;
  diverse: number;
  snippet?: string;          // listing teaser, used by the filters
  source: "wg" | "ka";       // wg-gesucht | Kleinanzeigen
  text?: string;
}

/** A site served a bot check. Carries which one, so only that source backs off. */
export class Blocked extends Error {
  source: "wg" | "ka";
  constructor(message: string, source: "wg" | "ka") {
    super(message);
    this.source = source;
  }
}

/**
 * wg-gesucht serves an "Überprüfung" page when it wants a captcha.
 *
 * Match on the TITLE only. Every normal page mentions "captcha" - their
 * cookie-consent config lists recaptcha.net, and the contact form has a
 * data-input="captcha" field - so searching the body for that word flags
 * every ad page as a challenge.
 */
export function isCaptcha(html: string): boolean {
  // real content present => definitely a normal page
  if (html.includes("liste-details-ad-") || html.includes('id="ad_description_text"'))
    return false;
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  const title = (m?.[1] ?? "").toLowerCase();
  return title.includes("überprüfung") || title.includes("uberprufung");
}

export interface CookieJar {
  read(): Promise<string | null>;
  write(cookie: string): Promise<void>;
}

/** Keep only the name=value pairs, joined for a Cookie header. */
function mergeCookies(existing: string, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k && v.length) jar.set(k, v.join("="));
  }
  for (const raw of setCookie) {
    const first = raw.split(";")[0];
    const [k, ...v] = first.trim().split("=");
    if (k && v.length) jar.set(k, v.join("="));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Fetch a page, carrying a session cookie between calls.
 *
 * Without this every request looks like a brand-new visitor, which is a
 * strong bot signal - a real browser picks up a session on first contact and
 * keeps using it. The jar lives in D1 so it survives across invocations.
 */
export async function get(url: string, jar?: CookieJar): Promise<string> {
  const cookie = jar ? await jar.read() : null;
  const headers: Record<string, string> = { ...HEADERS, Referer: `${BASE}/` };
  if (cookie) headers["Cookie"] = cookie;

  const r = await fetch(url, { headers });

  if (jar) {
    // Workers expose multiple Set-Cookie headers via getSetCookie()
    const set = typeof (r.headers as any).getSetCookie === "function"
      ? (r.headers as any).getSetCookie() as string[]
      : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie") as string] : []);
    if (set.length) await jar.write(mergeCookies(cookie ?? "", set));
  }

  const ka = url.includes("kleinanzeigen.de");
  const site = ka ? "Kleinanzeigen" : "wg-gesucht";
  if (r.status !== 200) throw new Blocked(`HTTP ${r.status} from ${site}`, ka ? "ka" : "wg");
  const html = await r.text();
  if (ka ? kaIsBlocked(html) : isCaptcha(html))
    throw new Blocked(`${site} is showing a bot check`, ka ? "ka" : "wg");
  return html;
}

const CARD_SPLIT = /<div\s+id="liste-details-ad-\d+"/;
const RX = {
  id: /data-id="(\d+)"/,
  url: /href="(\/[a-z-]*wg-zimmer[^"]+\.html)"/,
  title: /title="Anzeige ansehen:\s*([^"]*)"/,
  rent: /(\d[\d.]*)\s*(?:€|&euro;)/,
  size: /(\d+)\s*m(?:²|&sup2;)/,
  wg: /title="(\d+)er WG \((\d+)w,(\d+)m,(\d+)d,(\d+)n\)"/,
  img: /src="(https:\/\/img\.wg-gesucht\.de\/[^"]+)"/,
  seek: /\/img\/wg(eg|wg|mg)\.gif/,
  loc: /<div class="col-xs-11[^"]*">\s*<span\s*>([\s\S]*?)<\/span>/,
};
const TAGS = /<[^>]+>/g;
const WS = /\s+/g;
const SEEK: Record<string, Ad["seeking"]> = { eg: "any", wg: "female", mg: "male" };

const ENT: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'",
  "&apos;": "'", "&euro;": "€", "&sup2;": "²", "&nbsp;": " ", "&szlig;": "ß",
  "&auml;": "ä", "&ouml;": "ö", "&uuml;": "ü",
  "&Auml;": "Ä", "&Ouml;": "Ö", "&Uuml;": "Ü",
};
export function unescapeHtml(s: string): string {
  return s
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENT[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function one(rx: RegExp, blk: string, grp = 1): string {
  const m = rx.exec(blk);
  return m ? m[grp] ?? "" : "";
}

export function parseListing(html: string): Ad[] {
  const out: Ad[] = [];
  const blocks = html.split(CARD_SPLIT).slice(1);
  for (let blk of blocks) {
    blk = blk.slice(0, 9000);
    const adId = one(RX.id, blk);
    const href = one(RX.url, blk);
    if (!adId || !href) continue;

    const wg = RX.wg.exec(blk);
    const rent = one(RX.rent, blk);
    const size = one(RX.size, blk);

    let district = "";
    const loc = RX.loc.exec(blk);
    if (loc) {
      const parts = loc[1]
        .replace(TAGS, " ")
        .replace(WS, " ")
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      district = parts.slice(1, 3).join(" · ");
    }

    let image = one(RX.img, blk);
    if (image.includes("placeholder") || image.includes("dummy")) image = "";

    out.push({
      ad_id: adId,
      url: href.startsWith("http") ? href : `${BASE}/${href.replace(/^\//, "")}`,
      title: unescapeHtml(one(RX.title, blk)),
      rent: rent ? `${rent} €` : "",
      size: size ? `${size} m²` : "",
      district: unescapeHtml(district),
      image: image ? image.replace(/\.(small|thumb)\./, ".sized.") : "",
      seeking: SEEK[one(RX.seek, blk)] ?? "",
      wg_size: wg ? Number(wg[1]) : 0,
      women: wg ? Number(wg[2]) : 0,
      men: wg ? Number(wg[3]) : 0,
      diverse: wg ? Number(wg[4]) : 0,
      source: "wg",
    });
  }
  return out;
}

const DESC = /<div id="ad_description_text">([\s\S]*?)<\/div>\s*<\/div>/;
const SCRIPTY = /<(script|style)\b[\s\S]*?<\/\1>/gi;

export function parseAdText(html: string): string {
  const m = DESC.exec(html);
  if (!m) return "";
  const body = m[1]
    .replace(SCRIPTY, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n");
  return unescapeHtml(body.replace(TAGS, ""))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** "5er WG · 👩×2 👨×2 — wants a woman" */
export function flatmates(ad: Ad): string {
  if (!ad.wg_size) return "";
  const head = `${ad.wg_size}er WG`;
  const bits: string[] = [];
  if (ad.women) bits.push(`👩×${ad.women}`);
  if (ad.men) bits.push(`👨×${ad.men}`);
  if (ad.diverse) bits.push(`🧑×${ad.diverse}`);
  const want =
    ad.seeking === "female" ? " — wants a woman"
    : ad.seeking === "male" ? " — wants a man" : "";
  return (bits.length ? `${head} · ${bits.join(" ")}` : `${head} (no info)`) + want;
}

export function rentEur(ad: Ad): number | null {
  const m = /(\d[\d.]*)/.exec(ad.rent.replace("€", "").trim());
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}
