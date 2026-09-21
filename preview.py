#!/usr/bin/env python
"""Draft messages for a few live ads and print them. No Telegram needed.

    ./venv/bin/python preview.py            # 2 ads from all searches
    ./venv/bin/python preview.py -n 5       # 5 ads
    ./venv/bin/python preview.py --city Cottbus
    ./venv/bin/python preview.py --dry      # no OpenAI call, just show what it found
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from wgfinder.scraper import WGClient          # noqa: E402
from wgfinder.writer import Writer             # noqa: E402

CFG = yaml.safe_load((ROOT / "profile.yaml").read_text(encoding="utf-8"))

DIM, BOLD, RESET = "\033[2m", "\033[1m", "\033[0m"


def passes(ad):
    f = CFG.get("filters", {}) or {}
    t = (ad.title or "").lower()
    for bad in f.get("skip_if_title_contains") or []:
        if bad.lower() in t:
            return False, f"title: {bad}"
    r = ad.rent_eur
    if r is not None:
        if f.get("max_rent") and r > f["max_rent"]:
            return False, f"{r} EUR over max"
        if f.get("min_rent") and r < f["min_rent"]:
            return False, f"{r} EUR under min"
    return True, ""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=2, help="how many ads to draft")
    ap.add_argument("--city", help="only this search (substring of its name)")
    ap.add_argument("--dry", action="store_true", help="skip OpenAI, just list ads")
    a = ap.parse_args()

    searches = CFG["searches"]
    if a.city:
        searches = [s for s in searches if a.city.lower() in s["name"].lower()]
        if not searches:
            sys.exit(f"No search matches {a.city!r}")

    writer = None
    if not a.dry:
        key = os.getenv("OPENAI_API_KEY")
        if not key or key.startswith("sk-..."):
            sys.exit("Set OPENAI_API_KEY in .env first (or use --dry).")
        model = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
        print(f"{DIM}model: {model}{RESET}\n")
        writer = Writer(key, model, CFG)

    async with WGClient() as c:
        picked = []
        for s in searches:
            ads = await c.fetch_listing(s["url"])
            kept = 0
            for ad in ads:
                ok, why = passes(ad)
                if ok:
                    picked.append(ad)
                    kept += 1
            print(f"{DIM}{s['name'][:50]:52}{len(ads):3} found, {kept:2} pass filters{RESET}")
            if len(picked) >= a.n:
                break

        if not picked:
            sys.exit("\nNothing passed the filters right now.")

        print()
        for ad in picked[:a.n]:
            await c.fetch_ad_text(ad)
            print("=" * 74)
            print(f"{BOLD}{ad.title}{RESET}")
            print(f"{ad.rent} · {ad.size} · {ad.district}")
            if ad.flatmates:
                print(ad.flatmates)
            print(ad.url)
            print(f"{DIM}ad text: {len(ad.text)} chars{RESET}")
            if a.dry:
                print()
                continue
            print("-" * 74)
            try:
                d = await writer.compose(ad)
            except Exception as e:
                print(f"  DRAFT FAILED: {type(e).__name__}: {e}")
                continue
            print(f"{DIM}lang={d['language']}  thin_ad={d.get('thin_ad')}  "
                  f"used={', '.join(d.get('facts_used') or []) or 'none'}{RESET}")
            print(f"{DIM}summary: {d.get('ad_summary','')}{RESET}\n")
            print(d["message"])
            print(f"\n{DIM}({len(d['message'].split())} words){RESET}\n")


if __name__ == "__main__":
    asyncio.run(main())
