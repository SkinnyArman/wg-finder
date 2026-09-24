"""Which ads are worth an OpenAI call. Shared by every source.

Mirrored exactly in cf/src/filters.ts - change both together.

The title is a strong signal, so it gets the broad word lists. The snippet /
description is prose where a word like "weiblich" may just describe a current
flatmate, so it only gets unambiguous phrases.
"""
import re

# women-only rooms
FEMALE_TITLE = ("weiblich", "female", "frauen", "studentin", "women",
                "mitbewohnerin gesucht", "girls", "nur für frauen")
FEMALE_TEXT = ("nur frauen", "nur für frauen", "nur weibliche", "nur an frauen",
               "weibliche mitbewohnerin", "suchen eine mitbewohnerin",
               "suche eine mitbewohnerin", "nur studentinnen", "female only",
               "only female", "women only", "only women", "for female",
               "nette weibliche")

# weekday-commuter rooms
PENDLER = ("pendler", "wochenend", "zwischenmiete", "nur unter der woche",
           "mo-do", "mo - do", "monday to thursday", "weekdays only", "commuter")

# holiday lets and worker housing, often priced per night
NOISE_TITLE = ("monteur", "ferienwohnung", "ferien-wohnung", "ferienzimmer",
               "fewo", "gästewohnung", "gästezimmer", "gaestewohnung",
               "handwerker", "boardinghouse", "urlaub", "arbeiterunterkunft",
               "/nacht", "pro nacht", "€/nacht", "per night")
NOISE_TEXT = ("monteur", "ferienwohnung", "fewo", "gästewohnung",
              "pro nacht", "/nacht", "€/nacht", "per night")

# a "rent" under this is almost certainly a nightly rate
NIGHTLY_FLOOR = 100
_NIGHTLY_PRICE = re.compile(r"nacht|night|/\s*tag|pro tag", re.I)


def _hit(text: str, words) -> str:
    for w in words:
        if w in text:
            return w
    return ""


def rent_eur(rent: str) -> int | None:
    m = re.search(r"(\d[\d.]*)", (rent or "").replace("€", ""))
    if not m:
        return None
    try:
        return int(m.group(1).replace(".", ""))
    except ValueError:
        return None


def check(*, title: str, snippet: str = "", rent: str = "", seeking: str = "",
          settings: dict) -> tuple[bool, str]:
    """(passes, reason-if-not). `settings` is the merged filter settings."""
    t = (title or "").lower()
    x = (snippet or "").lower()

    for bad in settings.get("skip_if_title_contains") or []:
        if bad.lower() in t:
            return False, f"title contains '{bad}'"
    req = settings.get("require_title_contains") or []
    if req and not any(r.lower() in t for r in req):
        return False, "missing required keyword"

    if settings.get("skip_female_only", True):
        if seeking == "female":
            return False, "WG wants a woman"
        w = _hit(t, FEMALE_TITLE) or _hit(x, FEMALE_TEXT)
        if w:
            return False, f"women only ('{w}')"

    if settings.get("skip_pendler", True):
        w = _hit(t, PENDLER) or _hit(x, PENDLER)
        if w:
            return False, f"Pendler room ('{w}')"

    w = _hit(t, NOISE_TITLE) or _hit(x, NOISE_TEXT)
    if w:
        return False, f"holiday/worker let ('{w}')"

    if _NIGHTLY_PRICE.search(rent or ""):
        return False, "priced per night"
    eur = rent_eur(rent)
    if eur is not None:
        if eur < NIGHTLY_FLOOR:
            return False, f"{eur} EUR looks like a nightly rate"
        if settings.get("max_rent") and eur > settings["max_rent"]:
            return False, f"{eur} EUR over max"
        if settings.get("min_rent") and eur < settings["min_rent"]:
            return False, f"{eur} EUR under min"
    return True, ""


def looks_female_only(description: str) -> str:
    """Last check on the full ad text, before paying for a draft."""
    return _hit((description or "").lower(), FEMALE_TEXT)
