"""Reads wg-gesucht.de over plain HTTP. No login, no browser.

Ad descriptions are public, so there is nothing to log in for: we only read
listings and ad text. The contact form is never touched (it is also
Disallow-ed in their robots.txt) - you paste the message yourself.
"""
import asyncio
import logging
import random
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from html import unescape as _unescape

from bs4 import BeautifulSoup

log = logging.getLogger("scraper")


class Blocked(Exception):
    """wg-gesucht served its 'Überprüfung' captcha wall instead of a page."""


def _is_captcha(html: str) -> bool:
    low = html.lower()
    return ("<title>überprüfung" in low
            or "überprüfung</title>" in low
            or ("captcha" in low and "wgg_card" not in low and "offer_list_item" not in low))

BASE = "https://www.wg-gesucht.de"
DEBUG_DIR = Path(__file__).resolve().parent.parent / "debug"

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/141.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
}


@dataclass
class Ad:
    ad_id: str
    url: str
    title: str = ""
    rent: str = ""
    district: str = ""
    size: str = ""
    image: str = ""
    seeking: str = ""       # 'any' | 'female' | 'male'
    wg_size: int = 0        # "5er WG" -> 5
    women: int = 0
    men: int = 0
    diverse: int = 0
    text: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def flatmates(self) -> str:
        """e.g. '5er WG \u00b7 \U0001f469\u00d72 \U0001f468\u00d72'. Empty when the ad gives no info."""
        if not self.wg_size:
            return ""
        head = f"{self.wg_size}er WG"
        bits = []
        if self.women:
            bits.append(f"\U0001f469\u00d7{self.women}")
        if self.men:
            bits.append(f"\U0001f468\u00d7{self.men}")
        if self.diverse:
            bits.append(f"\U0001f9d1\u00d7{self.diverse}")
        want = {"female": " \u2014 wants a woman",
                "male": " \u2014 wants a man"}.get(self.seeking, "")
        body = f"{head} \u00b7 {' '.join(bits)}" if bits else f"{head} (no info)"
        return body + want

    @property
    def rent_eur(self) -> int | None:
        m = re.search(r"(\d[\d.]*)", self.rent.replace("\u20ac", "").strip())
        if not m:
            return None
        try:
            return int(m.group(1).replace(".", ""))
        except ValueError:
            return None


class WGClient:
    """Polite reader: real browser headers, pauses, backoff on rate limits."""

    def __init__(self, min_delay: float = 8.0, max_delay: float = 18.0):
        self.min_delay, self.max_delay = min_delay, max_delay
        self._c: httpx.AsyncClient | None = None

    async def __aenter__(self):
        self._c = httpx.AsyncClient(
            headers=HEADERS, follow_redirects=True, timeout=30.0,
            http2=False, limits=httpx.Limits(max_connections=2))
        return self

    async def __aexit__(self, *exc):
        if self._c:
            await self._c.aclose()

    async def _get(self, url: str, *, tries: int = 3) -> str | None:
        for attempt in range(tries):
            await asyncio.sleep(random.uniform(self.min_delay, self.max_delay))
            try:
                r = await self._c.get(url)
            except httpx.HTTPError as e:
                log.warning("request error %s (%s)", e, url)
                continue
            if r.status_code == 200:
                if _is_captcha(r.text):
                    self._dump(r.text, "captcha")
                    raise Blocked(
                        "wg-gesucht is showing its verification captcha. "
                        "Too many requests - back off and try later.")
                return r.text
            # 404 here is usually a soft rate-limit, not a dead page
            wait = 20 * (attempt + 1)
            log.warning("HTTP %s on %s - backing off %ss", r.status_code, url, wait)
            await asyncio.sleep(wait)
        return None

    async def fetch_listing(self, url: str) -> list[Ad]:
        html = await self._get(url)
        if html is None:
            return []
        ads = parse_listing(html)
        if not ads and not _genuinely_empty(html):
            self._dump(html, "empty-listing")
            log.warning("No ads parsed from %s - HTML dumped to debug/", url)
        return ads

    async def fetch_ad_text(self, ad: Ad) -> Ad:
        html = await self._get(ad.url)
        if html is None:
            return ad
        ad.text = parse_ad_text(html)
        ad.meta.update(parse_ad_meta(html))
        if not ad.text:
            self._dump(html, f"no-text-{ad.ad_id}")
            log.warning("no description extracted for %s - not drafting", ad.ad_id)
        return ad

    def _dump(self, html: str, tag: str):
        DEBUG_DIR.mkdir(exist_ok=True)
        try:
            (DEBUG_DIR / f"{tag}.html").write_text(html, encoding="utf-8")
        except Exception:
            pass


def _genuinely_empty(html: str) -> bool:
    """A town with no rooms, vs. our parser having broken.

    wg-gesucht prints no "no results" text - it just renders zero cards. So we
    check the search scaffolding (filter panel) rendered: if it did, the page
    is fine and the town is simply empty.
    """
    scaffolding = ("radial_distance", "sort_order", "Stadtteile")
    return sum(m in html for m in scaffolding) >= 2


# ================= fast path =================
# Building a full DOM for a 344 KB listing page costs ~54 ms of CPU just to
# read ten small fields per card. Targeted regexes do the same job ~20x
# cheaper. BeautifulSoup stays as a fallback: if the markup shifts and the
# regexes find nothing, we fall back rather than silently returning no ads.

_CARD_SPLIT = re.compile(r"<div\s+id=\"liste-details-ad-\d+\"")
_RX = {
    "id":    re.compile(r'data-id="(\d+)"'),
    "url":   re.compile(r'href="(/[a-z-]*wg-zimmer[^"]+\.html)"'),
    "title": re.compile(r'title="Anzeige ansehen:\s*([^"]*)"'),
    "rent":  re.compile(r"(\d[\d.]*)\s*(?:\u20ac|&euro;)"),
    "size":  re.compile(r"(\d+)\s*m(?:\u00b2|&sup2;)"),
    "wg":    re.compile(r'title="(\d+)er WG \((\d+)w,(\d+)m,(\d+)d,(\d+)n\)"'),
    "img":   re.compile(r'src="(https://img\.wg-gesucht\.de/[^"]+)"'),
    "seek":  re.compile(r"/img/wg(eg|wg|mg)\.gif"),
    "loc":   re.compile(r'<div class="col-xs-11[^"]*">\s*<span\s*>(.*?)</span>', re.S),
}
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_SEEK = {"eg": "any", "wg": "female", "mg": "male"}


def _one(rx: re.Pattern, blk: str, grp: int = 1, default: str = "") -> str:
    m = rx.search(blk)
    return m.group(grp) if m else default


def _fast_listing(html: str) -> list[Ad]:
    ads: list[Ad] = []
    for blk in _CARD_SPLIT.split(html)[1:]:
        blk = blk[:9000]                 # a card never runs longer than this
        ad_id = _one(_RX["id"], blk)
        if not ad_id:
            continue
        href = _one(_RX["url"], blk)
        if not href:
            continue

        wg = _RX["wg"].search(blk)
        rent = _one(_RX["rent"], blk)
        size = _one(_RX["size"], blk)

        district = ""
        loc = _RX["loc"].search(blk)
        if loc:
            parts = [x.strip() for x in
                     _WS.sub(" ", _TAGS.sub(" ", loc.group(1))).split("|")]
            parts = [x for x in parts if x]
            district = " \u00b7 ".join(parts[1:3])

        img = _one(_RX["img"], blk)
        if "placeholder" in img or "dummy" in img:
            img = ""

        ads.append(Ad(
            ad_id=ad_id,
            url=href if href.startswith("http") else f"{BASE}/{href.lstrip('/')}",
            title=_unescape(_one(_RX["title"], blk)),
            rent=f"{rent} \u20ac" if rent else "",
            size=f"{size} m\u00b2" if size else "",
            district=district,
            image=re.sub(r"\.(small|thumb)\.", ".sized.", img) if img else "",
            seeking=_SEEK.get(_one(_RX["seek"], blk), ""),
            wg_size=int(wg.group(1)) if wg else 0,
            women=int(wg.group(2)) if wg else 0,
            men=int(wg.group(3)) if wg else 0,
            diverse=int(wg.group(4)) if wg else 0,
        ))
    return ads


_DESC = re.compile(r'<div id="ad_description_text">(.*?)</div>\s*</div>', re.S)
_SCRIPTY = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)


def _fast_ad_text(html: str) -> str:
    m = _DESC.search(html)
    if not m:
        return ""
    body = _SCRIPTY.sub(" ", m.group(1))
    body = re.sub(r"<br\s*/?>|</p>|</div>", "\n", body, flags=re.I)
    text = _unescape(_TAGS.sub("", body))
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


# ================= HTML parsing (kept pure so it's testable) =================

def parse_listing(html: str) -> list[Ad]:
    ads = _fast_listing(html)
    if ads:
        return ads
    log.debug("regex listing parse found nothing; falling back to BeautifulSoup")
    return _bs_listing(html)


def _bs_listing(html: str) -> list[Ad]:
    soup = BeautifulSoup(html, "html.parser")
    ads: list[Ad] = []
    seen: set[str] = set()

    cards = soup.select("div.wgg_card.offer_list_item") or soup.select("div[id^='liste-details-ad-']")
    for card in cards:
        ad_id = card.get("data-id") or ""
        link = card.select_one("h2.truncate_title a, h3.truncate_title a") or card.select_one("a[href*='.html']")
        if not link:
            continue
        href = link.get("href", "")
        if not ad_id:
            m = re.search(r"\.(\d+)\.html", href)
            ad_id = m.group(1) if m else href
        if not ad_id or ad_id in seen:
            continue
        seen.add(ad_id)

        # Title: the anchor's own text, else its title="Anzeige ansehen: ..." attr
        title = link.get_text(" ", strip=True)
        if not title:
            title = re.sub(r"^Anzeige ansehen:\s*", "", link.get("title", "")).strip()

        # "6er WG | Berlin Friedrichshain | Revaler Straße"
        wg_type = district = street = ""
        loc = card.select_one(".col-xs-11 span")
        if loc:
            parts = [re.sub(r"\s+", " ", p).strip()
                     for p in loc.get_text(" ", strip=True).split("|")]
            parts = [p for p in parts if p]
            if len(parts) >= 1:
                wg_type = parts[0]
            if len(parts) >= 2:
                district = parts[1]
            if len(parts) >= 3:
                street = parts[2]

        # Rent lives in its own column; fall back to a scan of the card.
        rent = ""
        price_el = card.select_one(".col-xs-3 b, .card_price b, b.noprint")
        if price_el:
            rent = price_el.get_text(" ", strip=True)
        if "\u20ac" not in rent:
            m = re.search(r"(\d[\d.]*)\s*\u20ac", card.get_text(" ", strip=True))
            rent = m.group(0) if m else rent

        # Size in m2, if shown
        size = ""
        m = re.search(r"(\d+)\s*m\u00b2", card.get_text(" ", strip=True))
        if m:
            size = m.group(0)

        # title="5er WG (1w,2m,0d,1n)"  -> size + gender split
        wg_size = women = men = diverse = 0
        gm = re.search(r'title="(\d+)er WG \((\d+)w,(\d+)m,(\d+)d,(\d+)n\)"', str(card))
        if gm:
            wg_size, women, men, diverse = (int(gm.group(i)) for i in (1, 2, 3, 4))
        elif wg_type:
            n = re.match(r"(\d+)er", wg_type)
            if n:
                wg_size = int(n.group(1))

        # thumbnail -> higher-res variant for Telegram
        image = ""
        img = card.select_one("img.img-responsive, .card_image img")
        if img:
            src = img.get("src") or img.get("data-src") or ""
            if "img.wg-gesucht.de" in src:
                image = re.sub(r"\.(small|thumb)\.", ".sized.", src)

        # which gender the WG is looking for (icon alt text)
        seeking = ""
        for im in card.select("img.vis"):
            alt = (im.get("alt") or "").lower()
            src = im.get("src") or ""
            if "gesucht" not in alt:
                continue
            if "wgeg" in src or ("mitbewohnerin oder" in alt):
                seeking = "any"
            elif "wgwg" in src or alt.startswith("mitbewohnerin gesucht"):
                seeking = "female"
            elif "wgmg" in src:
                seeking = "male"
            break

        ads.append(Ad(
            ad_id=ad_id,
            image=image,
            seeking=seeking,
            wg_size=wg_size, women=women, men=men, diverse=diverse,
            url=href if href.startswith("http") else f"{BASE}/{href.lstrip('/')}",
            title=title,
            rent=rent,
            district=" \u00b7 ".join(x for x in (district, street) if x),
            size=size,
            meta={"wg_type": wg_type},
        ))
    return ads


def parse_ad_text(html: str) -> str:
    text = _fast_ad_text(html)
    if text:
        return text
    return _bs_ad_text(html)


def _bs_ad_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    chunks: list[str] = []
    for sel in ("#ad_description_text", "div.freitext", "#freitext_0",
                "div[id^='freitext_']", ".wordWrap"):
        for el in soup.select(sel):
            t = el.get_text("\n", strip=True)
            if t and t not in chunks:
                chunks.append(t)
        if chunks:
            break
    return "\n\n".join(chunks).strip()


def parse_ad_meta(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    meta: dict = {}
    h1 = soup.select_one("h1")
    if h1:
        meta["headline"] = h1.get_text(" ", strip=True)
    for el in soup.select(".headline-detailed-view-title, .key_fact_value, .section_panel_value"):
        t = el.get_text(" ", strip=True)
        if t:
            meta.setdefault("facts", []).append(t)
    return meta
