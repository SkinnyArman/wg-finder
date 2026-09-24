// Kleinanzeigen parsing. Port of wgfinder/kleinanzeigen.py - keep in step.
//
// Card markup is Tailwind utility classes, which change freely, so fields
// are anchored on each card's JSON-LD blob and on content patterns rather
// than class names wherever possible. Use the offers-only search URL
// (".../anzeige:angebote/...") - the plain one mixes in requests from
// people who are themselves looking for a room.

import { unescapeHtml, type Ad } from "./scraper.ts";

export const KA_BASE = "https://www.kleinanzeigen.de";
export const KA_PREFIX = "ka-";

const CARD_SPLIT = /<article class="[^"]*" data-adid=/;
const ID = /^"(\d+)"/;
const HREF = /data-href="([^"]+)"/;
const LDJSON = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;
const TITLE_A = /<a [^>]*href="\/s-anzeige\/[^"]+"[^>]*>([^<]+)<\/a>/;
const SNIPPET_P = /<p class="[^"]*mb-xsmall[^"]*">([\s\S]*?)<\/p>/;
const IMG = /<img [^>]*src="(https:\/\/img\.kleinanzeigen\.de\/[^"]+)"/;
const LOC = /<\/svg><span>([^<]+)<\/span>(?:<span[^>]*>\(([^)]+)\)<\/span>)?/;
const PRICE = /<p class="[^"]*text-title3[^"]*">([\s\S]*?)<\/p>/;
const SIZE = /(\d+(?:,\d+)?)\s*m²/;
const ROOMS = /(\d+(?:,\d+)?)\s*Zi\./;

const txt = (s: string) =>
  unescapeHtml(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parseListing(html: string): Ad[] {
  const out: Ad[] = [];
  for (const raw of html.split(CARD_SPLIT).slice(1)) {
    const blk = raw.split("</article>", 1)[0];
    const m = ID.exec(blk);
    const href = HREF.exec(blk);
    if (!m || !href) continue;

    let title = "", snippet = "", image = "";
    const ld = LDJSON.exec(blk);
    if (ld) {
      try {
        const d = JSON.parse(ld[1]);
        title = d.title ?? "";
        snippet = d.description ?? "";
        image = d.contentUrl ?? "";
      } catch { /* malformed blob: fall through to markup */ }
    }
    // Cards without a photo carry no JSON-LD. The title link is always
    // there, so prefer it.
    const ta = TITLE_A.exec(blk);
    if (ta) title = ta[1];
    if (!snippet) { const sp = SNIPPET_P.exec(blk); snippet = sp ? txt(sp[1]) : ""; }
    if (!image) { const im = IMG.exec(blk); image = im ? im[1] : ""; }

    const loc = LOC.exec(blk);
    const place = loc ? unescapeHtml(loc[1]).trim() : "";
    const distance = loc && loc[2] ? loc[2].trim() : "";
    const price = PRICE.exec(blk);
    const size = SIZE.exec(blk);

    out.push({
      ad_id: KA_PREFIX + m[1],
      url: KA_BASE + href[1],
      title: unescapeHtml(title).trim(),
      snippet: unescapeHtml(snippet).trim(),
      rent: price ? txt(price[1]) : "",
      size: size ? `${size[1]} m²` : "",
      district: place + (distance ? ` · ${distance}` : ""),
      image,
      seeking: "",
      wg_size: 0, women: 0, men: 0, diverse: 0,
      source: "ka",
    });
  }
  return out;
}

const DESC = /id="viewad-description-text"[^>]*>([\s\S]*?)<\/p>/;
const DETAIL =
  /<li class="addetailslist--detail">\s*([^<]+?)\s*<span[^>]*>\s*([\s\S]*?)\s*<\/span>/g;

/** [description, {"Verfügbar ab": "November 2026", ...}] */
export function parseAd(html: string): [string, Record<string, string>] {
  let text = "";
  const m = DESC.exec(html);
  if (m) {
    const body = m[1].replace(/<br\s*\/?>/gi, "\n");
    text = unescapeHtml(body.replace(/<[^>]+>/g, ""))
      .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }
  const details: Record<string, string> = {};
  for (const d of html.matchAll(DETAIL)) details[unescapeHtml(d[1]).trim()] = txt(d[2]);
  return [text, details];
}

/** Akamai Bot Manager challenge, as opposed to a genuinely empty result. */
export function isBlocked(html: string): boolean {
  if (html.includes("data-adid=") || html.includes('id="viewad-description-text"'))
    return false;
  const low = html.toLowerCase();
  return (
    low.includes("access denied") ||
    (low.includes("_abck") && html.length < 20000) ||
    low.includes("bitte bestätigen sie") ||
    low.includes("sec-if-cpt") ||
    html.length < 3000
  );
}
