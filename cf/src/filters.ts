// Which ads are worth an OpenAI call. Shared by every source.
// Port of wgfinder/filters.py - change both together.
//
// The title is a strong signal, so it gets the broad word lists. The
// snippet / description is prose where a word like "weiblich" may just
// describe a current flatmate, so it only gets unambiguous phrases.

export const FEMALE_TITLE = ["weiblich", "female", "frauen", "studentin", "women",
  "mitbewohnerin gesucht", "girls", "nur für frauen"];
export const FEMALE_TEXT = ["nur frauen", "nur für frauen", "nur weibliche", "nur an frauen",
  "weibliche mitbewohnerin", "suchen eine mitbewohnerin", "suche eine mitbewohnerin",
  "nur studentinnen", "female only", "only female", "women only", "only women",
  "for female", "nette weibliche"];

export const PENDLER = ["pendler", "wochenend", "zwischenmiete", "nur unter der woche",
  "mo-do", "mo - do", "monday to thursday", "weekdays only", "commuter"];

export const NOISE_TITLE = ["monteur", "ferienwohnung", "ferien-wohnung", "ferienzimmer",
  "fewo", "gästewohnung", "gästezimmer", "gaestewohnung", "handwerker", "boardinghouse",
  "urlaub", "arbeiterunterkunft", "/nacht", "pro nacht", "€/nacht", "per night"];
export const NOISE_TEXT = ["monteur", "ferienwohnung", "fewo", "gästewohnung",
  "pro nacht", "/nacht", "€/nacht", "per night"];

export const NIGHTLY_FLOOR = 100;
const NIGHTLY_PRICE = /nacht|night|\/\s*tag|pro tag/i;

const hit = (text: string, words: string[]) => words.find((w) => text.includes(w)) ?? "";

export function rentEur(rent: string): number | null {
  const m = /(\d[\d.]*)/.exec((rent || "").replace("€", ""));
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface FilterSettings {
  max_rent?: number;
  min_rent?: number;
  skip_female_only?: boolean;
  skip_pendler?: boolean;
  skip_if_title_contains?: string[];
  require_title_contains?: string[];
}

export function check(
  a: { title: string; snippet?: string; rent?: string; seeking?: string },
  s: FilterSettings,
): [boolean, string] {
  const t = (a.title || "").toLowerCase();
  const x = (a.snippet || "").toLowerCase();

  for (const bad of s.skip_if_title_contains ?? [])
    if (t.includes(bad.toLowerCase())) return [false, `title contains '${bad}'`];
  const req = s.require_title_contains ?? [];
  if (req.length && !req.some((r) => t.includes(r.toLowerCase())))
    return [false, "missing required keyword"];

  if (s.skip_female_only ?? true) {
    if (a.seeking === "female") return [false, "WG wants a woman"];
    const w = hit(t, FEMALE_TITLE) || hit(x, FEMALE_TEXT);
    if (w) return [false, `women only ('${w}')`];
  }

  if (s.skip_pendler ?? true) {
    const w = hit(t, PENDLER) || hit(x, PENDLER);
    if (w) return [false, `Pendler room ('${w}')`];
  }

  const w = hit(t, NOISE_TITLE) || hit(x, NOISE_TEXT);
  if (w) return [false, `holiday/worker let ('${w}')`];

  if (NIGHTLY_PRICE.test(a.rent || "")) return [false, "priced per night"];
  const eur = rentEur(a.rent || "");
  if (eur !== null) {
    if (eur < NIGHTLY_FLOOR) return [false, `${eur} EUR looks like a nightly rate`];
    if (s.max_rent && eur > s.max_rent) return [false, `${eur} EUR over max`];
    if (s.min_rent && eur < s.min_rent) return [false, `${eur} EUR under min`];
  }
  return [true, ""];
}

/** Last check on the full ad text, before paying for a draft. */
export const looksFemaleOnly = (description: string) =>
  hit((description || "").toLowerCase(), FEMALE_TEXT);
