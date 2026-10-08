"""Reads an Anzeige, detects its language, writes a reply in that language."""
import json
import logging
from datetime import date

from openai import AsyncOpenAI, BadRequestError

log = logging.getLogger("writer")

SYSTEM = """You write WG-Gesucht applications for one person. One ad, one message.

STEP 1 - LANGUAGE
Decide the language of the ad's free-text description (ignore site navigation
and boilerplate). German ad -> write in German. English ad -> write in English.
If the ad contains BOTH German and English (many Cottbus ads post the same
text twice), write in GERMAN. German always wins - the poster is German-
speaking and the English is there for convenience.

STEP 2 - PICK THE FACTS
The profile has three tiers:
  - ALWAYS: these must all appear, but woven into sentences, never listed.
  - IF_RELEVANT: each has a `when`. Include ONLY if the ad genuinely matches.
  - CONTEXTUAL: each has a `when`. Include ONLY on a clear match.
Most messages should use ZERO or ONE contextual fact. Using four reads as a
list of hobbies and fails.

STEP 3 - STRUCTURE (follow this order)

Paragraph 1 - INTRODUCE HIMSELF FIRST: ONE OR TWO SENTENCES, AT MOST ~35 WORDS.
  A greeting, then straight into who he is: name, age, moving to Cottbus to
  start at the university, his work and that rent is covered. Fold the
  habit and language facts in as short clauses ("Nichtraucher, keine
  Haustiere", "habe das telc-C1-Zertifikat") - never one sentence per fact.
  His temperament and respect for house rules do NOT go here.
  This is an introduction, not a form being filled in.
  NEVER open with a detached observation about the room. NEVER open with
  "The quiet, practical room sounds ideal" or similar floating commentary -
  there is no subject in that sentence and it reads as confusing.
  NEVER open with "I saw your ad" / "Ich habe eure Anzeige gesehen".

Paragraph 2 - WHY THIS FLAT: THE LONGEST PARAGRAPH, AT LEAST ~40 WORDS.
  Now bring in the ad. Name TWO concrete things from it (the balcony, that
  they cook together, the cat, the Altbau, that they want someone social)
  and say something real about why they appeal. "The room and location
  sound great" is generic and fails. His temperament and respect for house
  rules go here as ONE clause tied to what they wrote - e.g. they say
  they're often out, so a quiet flatmate who still joins for a kitchen chat
  fits. Any if_relevant / contextual fact also goes here, if one fits.

Paragraph 3 - PRACTICALITIES AND CLOSE.
  Move-in date (ONCE - never state a date twice, never give two different
  dates), then a concrete way to meet, using TODAY from the input: before
  he arrives, a video call now and an in-person viewing from his arrival
  date; once he has arrived, that he is in Cottbus and can come by any time.
  If a WhatsApp number is given, end with it as the easiest way to reach
  him. Sign off.

STEP 4 - HOW IT MUST SOUND
- Warm and relaxed, like a friendly person writing to people he would like
  to live with. Not a job application.
- NEVER recite personality traits as a list. "I'm calm and easy-going, while
  still being friendly and approachable, and I value respecting house rules
  and everyone's privacy" is exactly the failure to avoid. Show the trait in
  one natural clause instead, or fold it into something concrete. Being quiet
  on weeknights, doing his dishes, not being the one who throws parties.
- Vary sentence length. Put a short sentence after a long one. Do not write
  four sentences of identical shape in a row.
- No groups of three adjectives. One specific word beats three vague ones.
- No puffery, no "I hope this message finds you well", no "I would be
  delighted", no "please do not hesitate".
- Contractions are good. "I'm", "I'd", "ich bin".
- German: use "du/ihr" if the ad does, otherwise "Sie". Match their register.
  A Hausverwaltung, landlord or company is ALWAYS "Sie" with "Guten Tag",
  even if the ad itself is chatty - never "ihr" or "Hallo" to a company.
- Obey every rule in `never` without exception.
- Stay inside the length in STYLE: paragraph 1 at most ~35 words, paragraph
  2 the longest, paragraph 3 at most ~30 words. When cutting, keep the
  paragraph about their flat - it is what gets a reply - and trim the facts
  about him.
- If the ad is too bare to react to, set thin_ad true and write SHORTER.
  Never pad with adjectives.

Return STRICT JSON:
{"language":"de|en",
 "ad_summary":"<=25 words in English - what this room is",
 "facts_used":["short labels of the if_relevant/contextual facts you used"],
 "thin_ad":true|false,
 "message":"the full message, ready to paste"}
"""


def _profile_block(profile: dict) -> str:
    a = profile.get("about", {}) or {}
    s = profile.get("style", {}) or {}
    L: list[str] = ["=== APPLICANT ==="]
    L.append(f"name: {a.get('name')}, age: {a.get('age')}, pronouns: {a.get('pronouns')}")

    L.append("\n--- ALWAYS include all of these ---")
    for f in a.get("always") or []:
        L.append(f"  * {f}")

    L.append("\n--- IF_RELEVANT (only when the condition matches) ---")
    for it in a.get("if_relevant") or []:
        L.append(f"  * {it['fact']}\n      include when: {' '.join(it['when'].split())}")

    L.append("\n--- CONTEXTUAL (only on a clear match; usually omit) ---")
    for it in a.get("contextual") or []:
        L.append(f"  * {it['fact']}\n      include when: {' '.join(it['when'].split())}")

    L.append("\n--- NEVER (hard rules) ---")
    for f in a.get("never") or []:
        L.append(f"  ! {' '.join(f.split())}")

    if a.get("whatsapp"):
        L.append(f"\n--- WHATSAPP ---\nEnd the message with: reachable on WhatsApp at {a['whatsapp']}")
    if a.get("move_in_rule"):
        L.append(f"\n--- MOVE-IN RULE ---\n{' '.join(a['move_in_rule'].split())}")

    L.append("\n=== STYLE ===")
    L.append(f"length: {s.get('length', '140-200 words')}")
    L.append(f"tone: {' '.join((s.get('tone') or 'warm and natural').split())}")
    for item in s.get("always_include") or []:
        L.append(f"MUST include: {item}")
    for item in s.get("never_include") or []:
        L.append(f"MUST NOT include: {item}")
    if s.get("sign_off"):
        L.append(f"sign off as: {s['sign_off']}")
    return "\n".join(L)


def _details_block(ad) -> str:
    """Structured facts some sites give (Kleinanzeigen: 'Verfügbar ab' etc.).
    'Verfügbar ab' matters most - the move-in rule reads it."""
    det = (getattr(ad, "meta", None) or {}).get("details") or {}
    if not det:
        return ""
    return "Listing facts:\n" + "\n".join(f"  {k}: {v}" for k, v in det.items())


class Writer:
    def __init__(self, api_key: str, model: str, profile: dict):
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model
        self.profile = profile

    async def compose(self, ad, *, retry_note: str = "") -> dict:
        ad_text = (ad.text or "").strip()
        if len(ad_text) > 6000:
            ad_text = ad_text[:6000] + "\n[...truncated]"

        # Built line by line: textwrap.dedent can't strip the indent once the
        # multi-line profile block is interpolated, so the ad section used to
        # go out indented by 12 spaces. Mirrors cf/src/writer.ts.
        user = (
            f"{_profile_block(self.profile)}\n\n"
            f"TODAY: {date.today().isoformat()}\n\n"
            "=== THE ANZEIGE ===\n"
            f"Title: {ad.title}\nRent: {ad.rent}\nSize: {ad.size}\n"
            f"Area: {ad.district}\n"
            f"Flat: {getattr(ad, 'flatmates', '') or 'not stated'}\n"
            f"{_details_block(ad)}\n"
            f"Description:\n{ad_text or '(no description text could be extracted)'}\n"
        )
        if retry_note:
            user += f"\n=== REWRITE REQUEST ===\n{retry_note}\n"

        kwargs = dict(
            model=self.model,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": SYSTEM},
                      {"role": "user", "content": user}],
        )
        # Older models want a high temperature for variety; the gpt-5.6 family
        # only accepts the default and 400s on anything else. Try, then retry
        # without it rather than making the user care which is which.
        try:
            resp = await self.client.chat.completions.create(
                **kwargs, temperature=0.9)
        except BadRequestError as e:
            if "temperature" not in str(e):
                raise
            log.debug("model rejects custom temperature; using default")
            resp = await self.client.chat.completions.create(**kwargs)
        raw = resp.choices[0].message.content
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            log.error("Model returned non-JSON: %s", raw[:400])
            raise
        data.setdefault("language", "de")
        data.setdefault("ad_summary", ad.title)
        data.setdefault("thin_ad", False)
        data.setdefault("facts_used", [])
        return data
