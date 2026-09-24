"""Kleinanzeigen (kleinanzeigen.de) listing and ad parsing.

Same approach as the wg-gesucht fast path: targeted regexes, no DOM. The
card markup is Tailwind utility classes, which change freely, so fields are
anchored on the JSON-LD blob each card carries and on content patterns
(m², €, "(6 km)") rather than on class names wherever possible.

Use the offers-only search URL (".../anzeige:angebote/...") - the plain one
mixes in requests from people who are themselves looking for a room.
"""
import json
import re
from html import unescape

KA_BASE = "https://www.kleinanzeigen.de"
KA_PREFIX = "ka-"          # keeps ids distinct from wg-gesucht's

_CARD_SPLIT = re.compile(r'<article class="[^"]*" data-adid=')
_ID = re.compile(r'^"(\d+)"')
_HREF = re.compile(r'data-href="([^"]+)"')
_LDJSON = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
_TITLE_A = re.compile(r'<a [^>]*href="/s-anzeige/[^"]+"[^>]*>([^<]+)</a>')
_SNIPPET_P = re.compile(r'<p class="[^"]*mb-xsmall[^"]*">(.*?)</p>', re.S)
_IMG = re.compile(r'<img [^>]*src="(https://img\.kleinanzeigen\.de/[^"]+)"')
_LOC = re.compile(r"</svg><span>([^<]+)</span>(?:<span[^>]*>\(([^)]+)\)</span>)?")
_PRICE = re.compile(r'<p class="[^"]*text-title3[^"]*">(.*?)</p>', re.S)
_SIZE = re.compile(r"(\d+(?:,\d+)?)\s*m²")
_ROOMS = re.compile(r"(\d+(?:,\d+)?)\s*Zi\.")
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _txt(s: str) -> str:
    return _WS.sub(" ", unescape(_TAGS.sub(" ", s))).strip()


def parse_listing(html: str) -> list[dict]:
    """Return plain dicts; the caller turns them into its own Ad type."""
    out: list[dict] = []
    for blk in _CARD_SPLIT.split(html)[1:]:
        blk = blk.split("</article>", 1)[0]
        m = _ID.search(blk)
        href = _HREF.search(blk)
        if not m or not href:
            continue

        title = snippet = image = ""
        ld = _LDJSON.search(blk)
        if ld:
            try:
                d = json.loads(ld.group(1))
                title = d.get("title", "") or ""
                snippet = d.get("description", "") or ""
                image = d.get("contentUrl", "") or ""
            except json.JSONDecodeError:
                pass

        # Cards without a photo carry no JSON-LD, so fall back to the markup.
        # The title link is always there; prefer it.
        ta = _TITLE_A.search(blk)
        if ta:
            title = ta.group(1)
        if not snippet:
            sp = _SNIPPET_P.search(blk)
            snippet = _txt(sp.group(1)) if sp else ""
        if not image:
            im = _IMG.search(blk)
            image = im.group(1) if im else ""

        loc = _LOC.search(blk)
        place = unescape(loc.group(1)).strip() if loc else ""
        distance = loc.group(2).strip() if loc and loc.group(2) else ""

        price = _PRICE.search(blk)
        rent = _txt(price.group(1)) if price else ""

        size = _SIZE.search(blk)
        rooms = _ROOMS.search(blk)

        out.append({
            "ad_id": KA_PREFIX + m.group(1),
            "url": KA_BASE + href.group(1),
            "title": unescape(title).strip(),
            "snippet": unescape(snippet).strip(),
            "rent": rent,
            "size": f"{size.group(1)} m²" if size else "",
            "rooms": rooms.group(1) if rooms else "",
            "district": place + (f" · {distance}" if distance else ""),
            "image": image,
            "commercial": "Von Privat" not in blk,
        })
    return out


_DESC = re.compile(r'id="viewad-description-text"[^>]*>(.*?)</p>', re.S)
_DETAIL = re.compile(
    r'<li class="addetailslist--detail">\s*([^<]+?)\s*<span[^>]*>\s*(.*?)\s*</span>', re.S)


def parse_ad(html: str) -> tuple[str, dict]:
    """(description, {"Verfügbar ab": "November 2026", ...})"""
    text = ""
    m = _DESC.search(html)
    if m:
        body = re.sub(r"<br\s*/?>", "\n", m.group(1), flags=re.I)
        text = unescape(_TAGS.sub("", body))
        text = "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())
    details = {unescape(k).strip(): _txt(v) for k, v in _DETAIL.findall(html)}
    return text, details


def is_blocked(html: str) -> bool:
    """Kleinanzeigen sits behind Akamai Bot Manager. A challenge comes back
    as a near-empty page without the site's normal markers - treat that as a
    block rather than as 'no ads', the mistake we made with wg-gesucht."""
    if "data-adid=" in html or 'id="viewad-description-text"' in html:
        return False
    low = html.lower()
    return ("access denied" in low
            or ("_abck" in low and len(html) < 20000)
            or "bitte bestätigen sie" in low
            or "sec-if-cpt" in low
            or len(html) < 3000)
