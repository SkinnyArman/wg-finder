// Free and cheap finds around Cottbus - adult bikes, a 140×200 bed, a
// Kommode, and anything free that's useful for a student's room - rated by
// AI, straight to Telegram.
//
// Kept apart from the WG search on purpose:
//   - its own cron (odd minutes), which never lands on the WG job's
//     even-minute ticks, so each invocation has its own CPU budget
//   - its own backoff and cookie jar, so Kleinanzeigen rate-limiting these
//     searches never pauses the WG search
//   - its own settings and on/off per item, open to everyone in the group
//
// Each tick stays small: one listing check (the most overdue search of the
// items that are on), then reading + rating at most two new ads. Parsing all
// of that is ~2.5ms of CPU, well inside the free plan's budget, and it
// spreads the requests to Kleinanzeigen out instead of bursting them.
//
// Storage keys still say "bikes" - that's where this started, and renaming
// them would reset live state for nothing.

import { Blocked, get, type CookieJar } from "./scraper.ts";
import { parseListing, parseAd } from "./kleinanzeigen.ts";
import { assessItem, screenFree, type ItemKey } from "./findai.ts";
import { aiFailed, aiWorked } from "./aikey.ts";
import {
  blockSecondsLeft, dueOutageNotice, endOutage, fmtLeft, noteBlock, outageHours,
} from "./settings.ts";
import type { Store } from "./store.ts";
import { esc, inTopic, type Button, type Telegram } from "./telegram.ts";

export type { ItemKey };
export const FINDS_CRON = "5,15,25,35,45,55 * * * *";
export const RADIUS_KM = 30;
const ASSESS_PER_TICK = 2;
// Telegram allows about 20 messages a minute into a group.
const SEND_PER_TICK = 6;
const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [60, 120, 240, 360];   // consecutive blocks -> minutes
const LOCK_SECONDS = 300;                  // a tick takes ~20s; a dead one frees it

export interface FindsEnv {
  DB: D1Database;
  OPENAI_API_KEY: string;
  FINDS_MODEL?: string;
  // the group's forum topic for each item (wrangler.toml); none: General
  TOPIC_BIKE?: string;
  TOPIC_BED?: string;
  TOPIC_KOMMODE?: string;
  TOPIC_FREE?: string;
}

const topicOf = (env: FindsEnv, item: ItemKey): number | undefined =>
  Number(env[`TOPIC_${item.toUpperCase()}` as "TOPIC_BIKE"]) || undefined;

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lower = (title: string) =>
  // join hyphenated compounds: "Spike-Reifen" -> "spikereifen"
  title.toLowerCase().replace(/([\p{L}\d])-(?=[\p{L}\d])/gu, "$1");
const words = (t: string) => t.split(/[^\p{L}\d]+/u).filter(Boolean);
const SEARCHING = /\b(suche|gesucht)\b/;

// ================================================================ bikes
// The obvious cases are decided without AI, and that's most of them:
//   1. the searches only ask for the seller's categories Damen, Herren and
//      Weiteres - kids' bikes and accessories are never fetched
//   2. the title: sellers still file saddles, rims and shirts under Damen or
//      Herren, so part words, kids' markers and accessories are rejected here
//   3. the ad page's own "Art" field must not say Kinder or Zubehör
// What's left gets one AI call - the one it would get anyway for its rating -
// and that call also confirms it's a whole adult bike.
//
// Titles are judged up to the first "mit"/"inkl"/comma: "Damenrad mit Korb"
// is a bike. German compounds put the thing itself last ("Fahrradhelm" is a
// helmet), so part words also count at the end of a longer word, and a
// "Fahrrad…" compound (Fahrradlenker, Fahrradnavi) is always a thing for a
// bike, never the bike.

const NOT_BIKE = /hoverboard|scooter|segway|tretroller|\broller\b|skateboard|inliner|heimtrainer|hometrainer|ergometer|spinning|kinderwagen|buggy/;
const KIDS = /kinder|kids|mädchen|maedchen|jungen(fahr)?rad|kleinkind|lauflern|\bab \d+ jahr|\b(12|14|16|18)\s*(zoll|"|”|er)(?![\p{L}\d])/u;
// a balance bike, or a wheel - neither is wanted
const LAUFRAD = /laufrad\b|laufräder\b/;

// Sold on their own, never a bike: "Drahtreifen", "Alu-Pedale", "Fahrradhelm"
const PART = [
  "reifen", "schlauch", "mantel", "felge", "felgen", "kassette", "ritzel", "kette",
  "pedal", "pedale", "teile", "hinterrad", "vorderrad", "laufradsatz", "bremse",
  "bremsen", "bremsbeläge", "hebel", "schaltwerk", "umwerfer", "kurbel", "nabe",
  "nabenmotor", "akku", "ladegerät", "werkzeug", "helm", "pumpe", "kindersitz",
  "kindersitze", "fahrradsitz", "sitzbezug", "anhänger", "halterung", "tacho",
  "computer", "handschuhe", "trikot", "hose", "schuhe", "brille", "schutz",
  "schützer", "flaschenhalter", "cape", "hupe", "griffe", "vorbau", "kupplung",
  "aufhängung", "shirt", "display", "fernbedienung", "steuergerät", "controller",
];
// Often listed as a bike's features ("Damenrad 28 Zoll Gepäckträger Korb"):
// only a part when no bike word comes before it.
const FEATURE = [
  "schloss", "träger", "ständer", "klingel", "halter", "stützrad", "stützräder",
  "beleuchtung", "lampe", "rücklicht", "frontlicht", "scheinwerfer", "spiegel",
  "schutzblech", "schutzbleche", "tasche", "taschen", "korb", "sattel", "lenker",
  "gabel", "rahmen", "dynamo",
];
// whole words only - as word endings these would hit "Besitz", "vielleicht"
const PART_WORD = new Set([
  "motor", "navi", "lift", "helmet", "lock", "pump", "tire", "tires", "tyre",
  "tube", "pedals", "saddle", "chain", "cassette", "brake", "brakes", "pads",
  "rack", "bag", "bottle", "grips", "mudguard", "fender", "bell", "horn",
  // e-bike electronics sold on their own
  "kiox", "nyon", "intuvia", "purion", "cobi",
]);
// a frame to build a bike on, not a bike
const FRAME_ONLY = /rahmen\s+(für|zum)\s+(den\s+|einen\s+)?(neu)?aufbau|nur\s+(der\s+|den\s+)?rahmen|rahmenset/;
const FEATURE_WORD = new Set(["licht", "sitz", "light", "lights"]);

const BIKE = /(rad|räder|bike|bikes|mtb|bmx|pedelec|cruiser|fixie|singlespeed|tandem)$/;
const NOT_A_WHOLE_BIKE = /(stütz|hinter|vorder|zahn|ketten|schwung)r(ad|äder)$/;
const isBike = (w: string) => BIKE.test(w) && !NOT_A_WHOLE_BIKE.test(w);
// "fahrradlenker", "fahrradnavi" - but "fahrrad" / "fahrräder" themselves are bikes
const FAHRRAD_THING = (w: string) => /^fahrr(ad|äder)./.test(w) && !/^fahrr(ad|äder)s?$/.test(w);

/**
 * Why an ad clearly isn't an adult bike, or null when it is one or when the
 * title alone can't tell ("Cervelo ZFS-5") - the AI call settles those.
 */
export function rejectReason(title: string): string | null {
  const t = lower(title);
  if (NOT_BIKE.test(t)) return "not a bike";
  if (SEARCHING.test(t)) return "someone searching";
  if (KIDS.test(t)) return "kids' bike";
  if (LAUFRAD.test(t)) return "balance bike or wheel";
  if (FRAME_ONLY.test(t)) return "frame only";
  const head = t.split(/\s+(?:mit|inkl\.?|inklusive|samt|sowie|und|plus)\s+|\s*[+&,/|]\s*|\s+-\s+/)[0];
  let bikes = 0;
  for (const w of words(head)) {
    const part = PART_WORD.has(w) || PART.some((p) => w.endsWith(p)) ? `part (${w})`
      : FAHRRAD_THING(w) ? `accessory (${w})` : "";
    // "28" Damen-Cityrad City-Fahrrad Damenrad Vorderrad…": a bike named
    // over and over with a part in its feature list - let the AI look
    if (part) return bikes >= 2 ? null : part;
    if (!bikes && (FEATURE_WORD.has(w) || FEATURE.some((p) => w.endsWith(p))))
      return `accessory (${w})`;
    if (isBike(w)) bikes++;
  }
  return null;
}

/** The title itself names a bike ("Damenrad", "Mountain Bike") - not just a brand. */
export function namesBike(title: string): boolean {
  return words(lower(title)).some((w) => isBike(w) && !FAHRRAD_THING(w));
}

// ================================================================ bed 140×200
// The search asks for the seller's category "Betten" only. Then the title:
// a stated size other than 140 wide, kids'/bunk/pet beds, and mattresses,
// slatted bases or bedding sold on their own are clear misses. A title that
// says 140 and names a bed is a clear hit; anything else ("IKEA Hemnes Bett",
// "Doppelbett") goes to the AI, which reads the full description for the size.

const BED_SIZE = /(?<![\d.,])(\d{2,3})\s*(?:x|×|\*)\s*(?:19|20|21|22)0(?!\d)/g;
const METRE = /\b([0-2])[,.](\d0?)\s*(?:m\b|meter|x)/g;
const SAYS_140 = /(?<![\d.,])140(?:\s*(?:x|×|\*|cm|er|breit)|\b)|\b1[,.]40?\s*(?:m\b|meter|x)/;
const BED_KIDS = /kinder|baby|beistellbett|reisebett|laufstall|hochbett|etagenbett|stockbett|puppen/;
const BED_PET = /hunde|katzen|tierbett/;
const BEDDING = /bettwäsche|bettdecke|bettbezug|kissen|topper|laken|tagesdecke|bettkasten|kopfteil|tagesbett/;
const IKEA_BEDS = /\b(malm|hemnes|brimnes|tarva|songesand|slattum|nordli|idanäs|gjöra|neiden|sagstua)\b/;
const isBedWord = (w: string) =>
  w.endsWith("bett") || w.endsWith("betten") || /^bett(gestell|rahmen|gerüst)/.test(w) || w === "bed" || w.startsWith("boxspring");

function bedWidth(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(BED_SIZE)) out.push(Number(m[1]));
  for (const m of t.matchAll(METRE)) out.push(Number(m[1]) * 100 + Number(m[2].padEnd(2, "0")));
  return out;
}

export function bedRejectReason(title: string): string | null {
  const t = lower(title);
  if (SEARCHING.test(t)) return "someone searching";
  if (BED_PET.test(t)) return "pet bed";
  if (BED_KIDS.test(t)) return "kids' or bunk bed";
  const sizes = bedWidth(t);
  if (sizes.length && !sizes.includes(140) && !SAYS_140.test(t)) return `size ${sizes[0]} wide`;
  const named = words(t).some(isBedWord) || IKEA_BEDS.test(t);
  if (!named && /matratze/.test(t)) return "mattress only";
  if (!named && /lattenrost/.test(t)) return "slatted base only";
  if (BEDDING.test(t) && !named) return "bedding";
  return null;
}

/** Says 140 and names a bed: may go out unrated if the AI is down. */
export const namesBed = (title: string) => {
  const t = lower(title);
  return SAYS_140.test(t) && (words(t).some(isBedWord) || IKEA_BEDS.test(t));
};

// ================================================================ Kommode
// A keyword search ("kommode", any furniture category). Clear misses by
// title: changing tables, toys and miniatures, handles, inserts for
// wardrobes. Lookalikes (nightstands, shoe cabinets, sideboards) go to the
// AI, which decides from the full description.

const KOMMODE_NOT = /wickel|puppen|miniatur|spielzeug|griffe|knöpfe|beschläge|\bfür (?:ikea )?pax\b|paxeinsatz|einsatz für/;
const KOMMODE_LIKE = /kommode|schubladenschrank|schubladen/;
const KOMMODE_UNSURE = /nachttisch|nachtschrank|beistell|tisch\b|sideboard|lowboard|regal|vitrine|schuhschrank|eimerschrank|aufsatz/;

export function kommodeRejectReason(title: string): string | null {
  const t = lower(title);
  if (SEARCHING.test(t)) return "someone searching";
  const bad = KOMMODE_NOT.exec(t);
  return bad ? `not a Kommode (${bad[0].trim()})` : null;
}

export const namesKommode = (title: string) => {
  const t = lower(title);
  return KOMMODE_LIKE.test(t) && !KOMMODE_UNSURE.test(t) && !KOMMODE_NOT.test(t);
};

// ================================================================ free stuff
// The free category ("Zu verschenken") is mostly junk with the odd gem. Three
// tiers keep the AI bill small:
//   - junk by title is dropped here (stones, clothes, kids' things, sofas…)
//   - a title naming something on the wishlist goes straight to a full rating
//   - everything vague ("Verschiedenes zu verschenken") is screened in one
//     batched AI call per check, titles and previews only; just the ones that
//     pass get their page read and rated
// Free beds, Kommoden and bikes go to their own items and topics instead.

// Whole words only - as word endings these hit good ads: "Versand" ends in
// "sand", "Preis" in "reis", "Massivholz" in "holz", "Schallplatten" in "platten".
const FREE_JUNK_WORD = new Set([
  "kleid", "anzug", "socken", "bh", "jeans", "mütze", "schal", "dirndl",
  "kaktus", "ableger", "samen", "baum", "bäume", "topper", "pool", "boot", "trockner", "herd",
  "kind", "lego", "katze", "katzen", "hund", "hunde", "kaninchen", "meerschweinchen", "aquarium",
  "terrarium", "kratzbaum", "kies", "sand", "erde", "holz", "platten", "paletten",
  "beton", "bild", "bilder", "rad", "fahrrad", "fahrräder", "auto", "kfz", "rollator", "rollstuhl",
  "hochstuhl", "wickeltisch", "stillkissen", "sammelbecher", "zeitschriften", "zeitungen", "katalog",
  "flohmarkt", "haushaltsauflösung", "wohnungsauflösung", "basar", "figur", "figuren",
]);
// Compound endings that are junk whatever comes before ("Kinderschuhe", "Zimmerpflanze")
const FREE_JUNK_END = [
  "kleidung", "kleider", "hose", "hosen", "jacke", "jacken", "mantel", "pullover", "pulli", "shirt",
  "bluse", "schuhe", "stiefel", "sneaker", "unterwäsche", "jogginganzug",
  "pflanze", "pflanzen", "blumen", "setzlinge",
  "matratze", "matratzen", "sofa", "couch", "wohnlandschaft", "kleiderschrank", "schrankwand",
  "wohnwand", "küche", "küchenzeile", "waschmaschine", "kühlschrank", "gefrierschrank",
  "gefriertruhe", "spülmaschine", "geschirrspüler", "klavier", "trampolin", "wohnwagen",
  "spielzeug", "puppe", "puppen", "kinderwagen", "buggy", "laufstall", "schnuller", "windeln",
  "umstandsmode", "futter", "brennholz", "feuerholz", "holzreste", "schotter", "findling", "schutt",
  "folie", "fliesen", "dachziegel", "spanplatten", "reifen", "zaun", "rasenmäher", "gartenmöbel",
  "gartenschlauch", "deko", "dekoration", "kranz", "stein", "steine",
];
const FREE_JUNK_RX = /\b(suche|gesucht|tausche)\b|weihnacht|ostern|advent|kinder|baby|\bgr(öße|\.)?\s?\d{2}\b/;
// clearly something a new student can use: straight to a full rating
const FREE_WANT_WORD = new Set(["reis", "tee", "maus", "buch", "tisch", "decke", "decken", "obst"]);
const FREE_WANT_END = [
  "schreibtisch", "bürostuhl", "stuhl", "stühle", "regal", "kleiderstange", "nachttisch",
  "garderobe", "spiegel", "sessel", "hocker",
  "bettdecke", "kissen", "bettwäsche", "handtuch", "handtücher", "vorhang", "vorhänge", "gardine",
  "gardinen", "teppich",
  "topf", "töpfe", "pfanne", "pfannen", "geschirr", "teller", "tassen", "becher", "gläser", "besteck",
  "messer", "schneidebrett", "wasserkocher", "toaster", "kaffeemaschine", "kaffeevollautomat",
  "mikrowelle", "mixer", "reiskocher", "sandwichmaker", "waffeleisen", "schüssel", "schüsseln",
  "vorratsdosen",
  "staubsauger", "wäscheständer", "bügeleisen", "bügelbrett", "wäschekorb", "kleiderbügel",
  "mülleimer", "steckdosenleiste", "mehrfachsteckdose", "verlängerungskabel", "ventilator",
  "heizlüfter", "lampe", "lampen", "lampenschirm", "leuchte", "monitor", "bildschirm", "tastatur", "drucker",
  "lautsprecher", "kopfhörer", "laptop", "notebook", "tablet", "handy", "smartphone", "ipad",
  "kamera", "konsole", "playstation", "xbox", "nintendo", "fernseher", "radio", "router",
  "bücher", "lehrbuch", "wörterbuch", "brettspiel", "brettspiele", "gitarre", "keyboard",
  "ukulele", "yogamatte", "hanteln", "zelt", "schlafsack", "rucksack", "koffer",
  "lebensmittel", "nudeln", "konserven", "gemüse", "kaffee",
];
const isWant = (w: string) => FREE_WANT_WORD.has(w) || FREE_WANT_END.some((x) => w.endsWith(x));
// bikes and bike gear have their own topic: "Fahrradschloss", "Fahrradhelm"
const isJunk = (w: string) =>
  FREE_JUNK_WORD.has(w) || FAHRRAD_THING(w) || (FREE_JUNK_END.some((x) => w.endsWith(x)) && !isWant(w));

export function freeRejectReason(title: string): string | null {
  const t = lower(title);
  if (FREE_JUNK_RX.test(t)) return "not for a student's room";
  const bad = words(t).find(isJunk);
  return bad ? `not for a student's room (${bad})` : null;
}

/** Names something on the wishlist: worth a full rating without screening. */
export const namesFree = (title: string) => !freeRejectReason(title) && words(lower(title)).some(isWant);

/** A free ad that's really a bed, a Kommode or a bike belongs to that item. */
export function routeFree(title: string): ItemKey | null {
  const t = lower(title);
  if (words(t).some(isBedWord) && !bedRejectReason(title)) return "bed";
  if (KOMMODE_LIKE.test(t) && !kommodeRejectReason(title)) return "kommode";
  if (namesBike(title) && !rejectReason(title)) return "bike";
  return null;
}

// ================================================================ the items
interface Search { id: string; every: number; url: (max: number) => string }
export interface Item {
  key: ItemKey;
  emoji: string;
  label: string;          // on the /finds card
  kv: string;             // settings keys: <kv>_on, <kv>_max_price, <kv>_floor
  priced: boolean;        // has a price cap; free stuff has a rating floor instead
  defaultMax: number;
  defaultFloor: number;   // only post from this rating up
  step: number;           // € (or ⭐ for free stuff) per tap on the card
  searches: Search[];
  reject: (title: string) => string | null;   // clearly not it, by title
  named: (title: string) => boolean;          // clearly it - may go out unrated without AI
  page?: (details: Record<string, string>) => string | null;  // the ad page disagrees
}

const fahrrad = (art: string) => (max: number) =>
  `https://www.kleinanzeigen.de/s-fahrraeder/${art}/cottbus/anzeige:angebote/` +
  `preis::${max}/c217l7743r${RADIUS_KM}+fahrraeder.art_s:${art}`;

// All: offers only, up to max € ("Zu verschenken" counts as 0 €), RADIUS_KM
// around Cottbus (l7743), newest first. Far fewer than a page (25) of new
// ads appear between two checks, so page 1 is enough.
export const ITEMS: Item[] = [
  {
    key: "bike", emoji: "🚲", label: "Bikes", kv: "bikes", priced: true, defaultMax: 30, defaultFloor: 0, step: 5,
    // "Weiteres" is mostly parts, so it isn't worth the requests as often
    searches: [
      { id: "damen", every: 30, url: fahrrad("damen") },
      { id: "herren", every: 30, url: fahrrad("herren") },
      { id: "weiteres", every: 120, url: fahrrad("weiteres") },
    ],
    reject: rejectReason, named: namesBike,
    page: (d) => (d["Art"] === "Zubehör" || d["Art"] === "Kinder" ? `Art: ${d["Art"]}` : null),
  },
  {
    key: "bed", emoji: "🛏", label: "Bed 140×200", kv: "bed", priced: true, defaultMax: 100, defaultFloor: 0, step: 10,
    searches: [{
      id: "bed", every: 60,
      url: (max) => `https://www.kleinanzeigen.de/s-schlafzimmer/betten/cottbus/anzeige:angebote/` +
        `preis::${max}/c81l7743r${RADIUS_KM}+schlafzimmer.art_s:betten`,
    }],
    reject: bedRejectReason, named: namesBed,
    page: (d) => (d["Art"] && d["Art"] !== "Betten" ? `Art: ${d["Art"]}` : null),
  },
  {
    key: "kommode", emoji: "🗄", label: "Kommode", kv: "kommode", priced: true, defaultMax: 35, defaultFloor: 0, step: 5,
    searches: [{
      id: "kommode", every: 60,
      url: (max) => `https://www.kleinanzeigen.de/s-haus-garten/cottbus/anzeige:angebote/` +
        `preis::${max}/kommode/k0c80l7743r${RADIUS_KM}`,
    }],
    reject: kommodeRejectReason, named: namesKommode,
  },
  {
    // a lot comes in and most of it is junk: only the well-rated ones go out
    key: "free", emoji: "🎁", label: "Free stuff", kv: "free", priced: false, defaultMax: 0, defaultFloor: 6, step: 1,
    searches: [{
      id: "free", every: 30,
      url: () => `https://www.kleinanzeigen.de/s-zu-verschenken/cottbus/anzeige:angebote/c192l7743r${RADIUS_KM}`,
    }],
    reject: freeRejectReason, named: namesFree,
  },
];
const ITEM = Object.fromEntries(ITEMS.map((i) => [i.key, i])) as Record<ItemKey, Item>;
const itemOf = (row: { item?: string | null }) => ITEM[(row.item as ItemKey) || "bike"] ?? ITEM.bike;

/** "bike", "bikes", "fahrrad", "bed", "bett", "kommode", "dresser" → item */
export function parseItem(word: string): ItemKey | null {
  const w = word.toLowerCase();
  if (/^(bikes?|fahrr(ad|äder)|rad)$/.test(w)) return "bike";
  if (/^(beds?|bett(en)?)$/.test(w)) return "bed";
  if (/^(kommoden?|dressers?|drawers?)$/.test(w)) return "kommode";
  if (/^(free|gratis|umsonst|verschenken)$/.test(w)) return "free";
  return null;
}

// ---------------------------------------------------------------- settings
export interface FindSettings {
  min_score: number;
  items: Record<ItemKey, { on: boolean; max: number; floor: number }>;
}

export async function loadFindSettings(store: Store): Promise<FindSettings> {
  const num = async (k: string, d: number) => {
    const raw = await store.kvGet(k);
    const v = Number(raw);
    return raw === null || !Number.isFinite(v) ? d : v;
  };
  const items = {} as FindSettings["items"];
  for (const i of ITEMS)
    items[i.key] = {
      on: (await store.kvGet(`${i.kv}_on`)) !== "0",
      max: await num(`${i.kv}_max_price`, i.defaultMax),
      floor: await num(`${i.kv}_floor`, i.defaultFloor),
    };
  return { min_score: await num("bikes_min_score", 0), items };
}

/**
 * Max price for an item, the minimum rating ("min") for all of them, or for
 * free stuff - which has no price - its own minimum rating.
 */
export async function setFindSetting(store: Store, key: ItemKey | "min", value: number): Promise<string> {
  if (key !== "min" && !ITEM[key].priced) {
    const v = Math.min(10, Math.max(0, Math.round(value)));
    await store.kvSet(`${ITEM[key].kv}_floor`, String(v));
    return `${ITEM[key].emoji} ${ITEM[key].label}: only ⭐ ${v}/10 or better`;
  }
  if (key === "min") {
    const v = Math.min(10, Math.max(0, Math.round(value)));
    await store.kvSet("bikes_min_score", String(v));
    return v ? `Only finds rated ${v}/10 or better` : "Everything gets posted, whatever its rating";
  }
  const v = Math.min(500, Math.max(0, Math.round(value)));
  await store.kvSet(`${ITEM[key].kv}_max_price`, String(v));
  return `${ITEM[key].emoji} ${ITEM[key].label}: up to ${v} €`;
}

export async function setItemOn(store: Store, key: ItemKey, on: boolean): Promise<string> {
  await store.kvSet(`${ITEM[key].kv}_on`, on ? "1" : "0");
  return `${ITEM[key].emoji} ${ITEM[key].label}: ${on ? "on" : "paused"}`;
}

// ---------------------------------------------------------------- helpers
/** 0 for "Zu verschenken", the euro amount otherwise, null if none shown. */
export function priceEur(text: string): number | null {
  if (/verschenken/i.test(text)) return 0;
  const m = /(\d[\d.]*)\s*€/.exec(text);
  return m ? Number(m[1].replace(/\./g, "")) : null;
}

/**
 * When each card on a listing says it was posted, by ad id. Only today's and
 * yesterday's count as fresh; anything older seen for the first time is a
 * backlog (a search's very first page) or a paid ad pinned to the top.
 */
function cardDates(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const blk of html.split(/<article class="[^"]*" data-adid=/).slice(1)) {
    const id = /^"(\d+)"/.exec(blk)?.[1];
    const d = /(Heute|Gestern|\d{2}\.\d{2}\.\d{4})/.exec(blk.split("</article>", 1)[0])?.[1];
    if (id && d) out.set("ka-" + id, d);
  }
  return out;
}

const isStale = (posted: string | undefined): boolean => {
  const m = posted && /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(posted);
  if (!m) return false;                              // Heute, Gestern, or unknown
  const at = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Date.now() - at > 2 * 86400_000;
};

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
  item: "TEXT",               // bike | bed | kommode (empty: bike, from before)
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

interface FindRow {
  ad_id: string; url: string; title: string; price: string; place: string;
  image: string; snippet: string; status: string; attempts: number;
  score: number | null; kind: string | null; notes: string | null;
  rating_why: string | null; item: string | null;
}

const jar = (store: Store): CookieJar => ({
  read: () => store.kvGet("cookies_bikes"),
  write: (c: string) => store.kvSet("cookies_bikes", c),
});

/**
 * One run at a time. Two can overlap - a "Check now" tap landing on a cron
 * tick, or Cloudflare firing old and new triggers while a cron change rolls
 * out - and both would rate and post the same ads. Taken atomically: the
 * upsert only overwrites a lock that has expired.
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
export async function findsStep(
  env: FindsEnv, store: Store, tg: Telegram, forceList = false,
): Promise<string> {
  const db = env.DB;
  const s = await loadFindSettings(store);
  const live = ITEMS.filter((i) => s.items[i.key].on);
  if (!live.length) return "finds: all paused";

  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  if (until > now()) return `finds: backing off, ${fmtLeft(until - now())} left`;
  // While Kleinanzeigen is limiting the WG search, more requests from here
  // would only stretch that block out. Sit it out; the WG search isn't touched.
  const ka = await blockSecondsLeft(store, "ka");
  if (ka > 0) return `finds: waiting, Kleinanzeigen is limiting the WG search (${fmtLeft(ka)})`;

  if (!(await takeLock(db))) return "finds: another run is still going";
  try {
    await ensureTable(db);
    const did: string[] = [];
    try {
      // the most overdue search, if one is due ("Check now": the most overdue anyway)
      const checked = await store.kvPrefix("bikes_checked:");
      const [item, search, overdue] = live
        .flatMap((i) => i.searches.map((sr) =>
          [i, sr, now() - Number(checked["bikes_checked:" + sr.id] ?? 0) - (sr.every - 2) * 60] as const))
        .reduce((x, y) => (y[2] > x[2] ? y : x));
      if (forceList || overdue >= 0)
        did.push(await checkListing(db, store, s, item, search));
      const screened = await screenSome(env, store, tg);
      if (screened) did.push(screened);
      did.push(await assessSome(env, store, s, tg));
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      return await backOff(store, tg, e.message);
    }
    await endOutage(store, "bikes");

    const sent = await sendReady(env, tg, s);
    if (did.length > 1 && did.at(-1) === "nothing to rate") did.pop();
    return `finds: ${did.join(", ")}${sent ? `, ${sent} sent` : ""}`;
  } finally {
    await store.kvSet("bikes_lock", "0");
  }
}

async function checkListing(
  db: D1Database, store: Store, s: FindSettings, item: Item, search: Search,
): Promise<string> {
  const html = await get(search.url(s.items[item.key].max), jar(store));
  // only once it worked: after a block the next tick should look again
  await store.kvSet("bikes_checked:" + search.id, String(now()));
  const ads = parseListing(html);
  if (!ads.length) return `${search.id} listing empty`;
  const posted = cardDates(html);

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
    // a free ad that's really a bed, Kommode or bike joins that item
    const routed = item.key === "free" ? routeFree(ad.title) : null;
    const it = routed ? ITEM[routed] : item;
    const why =
      routed && !s.items[routed].on ? "paused"
      : it.priced && price !== null && price > s.items[it.key].max ? `price ${ad.rent}`
      // a thin result page gets padded with ads from far away
      : km !== null && km > RADIUS_KM + 5 ? `too far (${km} km)`
      // no flood of old ads when a search starts, no pinned "TOP" ads
      : isStale(posted.get(ad.ad_id)) ? `old ad (${posted.get(ad.ad_id)})`
      : it.reject(ad.title);
    if (!why) maybe++;
    // vague free ads wait for the batched screen; wishlist titles skip it
    const status = why ? "skipped" : it.key === "free" && !namesFree(ad.title) ? "screen" : "new";
    await db.prepare(
      `INSERT OR IGNORE INTO bikes
         (ad_id,url,title,price,place,image,snippet,status,why,first_seen,item)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(ad.ad_id, ad.url, ad.title, ad.rent, ad.district, ad.image,
            ad.snippet ?? "", status, why, now(), it.key).run();
  }
  return `${search.id} ${ads.length} ads, ${fresh} new, ${maybe} to rate`;
}

/**
 * The vague free ads, all in one cheap AI call on title + preview. Passing
 * (5/10 and up) means a full read and rating; the rest are dropped unread.
 */
async function screenSome(env: FindsEnv, store: Store, tg: Telegram): Promise<string> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bikes WHERE status='screen' ORDER BY first_seen, rowid LIMIT 12`).all<FindRow>();
  const rows = results ?? [];
  if (!rows.length) return "";
  try {
    const verdicts = await screenFree(env.OPENAI_API_KEY, env.FINDS_MODEL || "gpt-5.6-luna",
      rows.map((r) => ({ id: r.ad_id, title: r.title, snippet: r.snippet })));
    await aiWorked(store);
    let pass = 0;
    for (const r of rows) {
      const v = verdicts.get(r.ad_id);
      if (v && v.score >= 5) { pass++; await setRow(db, r.ad_id, { status: "new" }); }
      else await setRow(db, r.ad_id, { status: "skipped", why: `screen: ${v ? `${v.score}/10 ${v.reason}` : "no verdict"}` });
    }
    return `screened ${rows.length} free, ${pass} worth a look`;
  } catch (e: any) {
    await aiFailed(store, tg, e);
    // a few tries, then give up on them: vague and unchecked isn't worth posting
    for (const r of rows)
      await setRow(db, r.ad_id, r.attempts + 1 >= MAX_ATTEMPTS
        ? { attempts: r.attempts + 1, status: "skipped", why: "unsure, and no AI to ask" }
        : { attempts: r.attempts + 1 });
    console.error("free screen failed:", e?.message ?? e);
    return "screen failed";
  }
}

/** Read the full ad; the AI confirms it's what we want and rates it. Two per tick. */
async function assessSome(
  env: FindsEnv, store: Store, s: FindSettings, tg: Telegram,
): Promise<string> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bikes WHERE status='new' ORDER BY first_seen, rowid LIMIT ?`)
    .bind(ASSESS_PER_TICK).all<FindRow>();
  const rows = results ?? [];
  if (!rows.length) return "nothing to rate";

  const out: string[] = [];
  for (const row of rows) {
    const item = itemOf(row);
    // paused, or its max price lowered, since it was listed
    const price = priceEur(row.price);
    if (!s.items[item.key].on || (item.priced && price !== null && price > s.items[item.key].max)) {
      await setRow(db, row.ad_id, { status: "skipped", why: s.items[item.key].on ? `price ${row.price}` : "paused" });
      continue;
    }
    // never two requests back to back - not even right after the listing
    await sleep(2000 + Math.random() * 2500);

    // Blocked propagates: the tick backs off as a whole
    const html = await get(row.url, jar(store));
    const [text, details] = parseAd(html);
    // a deleted ad redirects to a search page
    if (!text && html.includes("data-adid=")) {
      await setRow(db, row.ad_id, { status: "gone", why: "ad deleted" });
      out.push("1 gone");
      continue;
    }
    // the seller's category on the page itself has to agree
    const pageWhy = item.page?.(details);
    if (pageWhy) {
      await setRow(db, row.ad_id, { status: "skipped", why: pageWhy });
      out.push(`1 ${pageWhy}`);
      continue;
    }

    try {
      const a = await assessItem(env.OPENAI_API_KEY, env.FINDS_MODEL || "gpt-5.6-luna", item.key, {
        title: row.title, price: row.price, place: row.place, details, text,
      });
      await aiWorked(store);
      if (!a.is_match) {
        await setRow(db, row.ad_id, { status: "skipped", why: `ai: ${a.reason || "not it"}` });
        out.push(`1 not a ${item.key}`);
        continue;
      }
      await setRow(db, row.ad_id, {
        status: "ready", score: a.score || null, kind: a.kind, notes: JSON.stringify(a.notes),
        rating_why: a.why,
      });
      out.push(`${item.key} rated ${a.score}/10`);
    } catch (e: any) {
      await aiFailed(store, tg, e);
      // Out of tries. A free find shouldn't be lost to an OpenAI outage, so a
      // title that clearly names the thing still goes out, unrated. One that
      // doesn't ("Kiox 300 Display") needed the AI to tell - it's dropped.
      const tries = row.attempts + 1;
      await setRow(db, row.ad_id, tries < MAX_ATTEMPTS ? { attempts: tries }
        : item.named(row.title) ? { attempts: tries, status: "ready", why: "not rated: AI unavailable" }
        : { attempts: tries, status: "skipped", why: "unsure, and no AI to ask" });
      console.error(`rating failed for ${row.ad_id}:`, e?.message ?? e);
      out.push("rating failed");
    }
  }
  return out.join(", ") || "nothing to rate";
}

async function backOff(store: Store, tg: Telegram, why: string): Promise<string> {
  const o = await noteBlock(store, "bikes");
  const mins = BACKOFF_MIN[Math.min(o.streak - 1, BACKOFF_MIN.length - 1)];
  await store.kvSet("bikes_blocked_until", String(now() + mins * 60));
  // A flagged session keeps a block going; retry with a clean one. This is
  // this job's own jar - the WG search's session is left alone.
  await store.kvSet("cookies_bikes", "");
  // Routine: silent, /finds shows the countdown. Only a long one gets a word.
  if (await dueOutageNotice(store, "bikes", o))
    await tg.send(
      `🔎 <b>Kleinanzeigen has been blocking the bike and furniture searches for ` +
      `${outageHours(o)} hours</b>\n\n` +
      `They keep retrying by themselves (next try in ${mins} min). Nothing is ` +
      `lost, and the room search isn't affected.`);
  return `finds: blocked (${why}), retry in ${mins} min`;
}

async function sendReady(env: FindsEnv, tg: Telegram, s: FindSettings): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bikes WHERE status='ready' ORDER BY first_seen, rowid LIMIT ?`)
    .bind(SEND_PER_TICK).all<FindRow>();
  let sent = 0;
  for (const row of results ?? []) {
    // settings may have changed since it was rated
    if (!s.items[itemOf(row).key].on) {
      await setRow(db, row.ad_id, { status: "skipped", why: "paused" });
      continue;
    }
    const floor = Math.max(s.min_score, s.items[itemOf(row).key].floor);
    if (floor && row.score !== null && row.score < floor) {
      await setRow(db, row.ad_id, { status: "skipped", why: `rated ${row.score}/10` });
      continue;
    }
    try {
      await deliver(tg, row, topicOf(env, itemOf(row).key));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // flood control: stop here, the rest stays queued for the next tick
      if (msg.includes(" 429")) break;
      const tries = row.attempts + 1;
      await setRow(db, row.ad_id, tries >= MAX_ATTEMPTS
        ? { attempts: tries, status: "failed" } : { attempts: tries });
      console.error(`alert failed for ${row.ad_id}:`, msg);
      continue;
    }
    await setRow(db, row.ad_id, { status: "sent", sent_at: now() });
    sent++;
  }
  return sent;
}

function caption(row: FindRow): string {
  const item = itemOf(row);
  const free = priceEur(row.price) === 0;
  const notes: string[] = row.notes ? JSON.parse(row.notes) : [];
  const rating = row.score
    ? `⭐ <b>${row.score}/10</b>${row.kind ? ` · ${esc(row.kind)}` : ""}`
    : "⭐ not rated (AI unavailable)";
  const snip = row.snippet.length > 140 ? row.snippet.slice(0, 140).trimEnd() + "…" : row.snippet;
  return (
    `${item.emoji} <b>${esc(row.title || item.label)}</b>\n` +
    (free ? "🆓 <b>Free</b>" : `<b>${esc(row.price || "price?")}</b>`) +
    ` · ${esc(row.place || "?")}\n` +
    `${rating}\n` +
    (row.rating_why ? `<i>${esc(row.rating_why)}</i>\n` : "") +
    (notes.length ? notes.map((n) => `• ${esc(n)}`).join("\n") + "\n"
      : snip && !row.score ? `<i>${esc(snip)}</i>\n` : "") +
    `<a href="${esc(row.url)}">open on Kleinanzeigen</a>`
  );
}

async function deliver(tg: Telegram, row: FindRow, topic?: number): Promise<void> {
  const text = caption(row);
  if (row.image) {
    try {
      await tg.sendPhoto(bigImage(row.image), text, undefined, inTopic(topic));
      return;
    } catch (e: any) {
      if (String(e?.message ?? e).includes(" 429")) throw e;
      // a photo Telegram can't fetch shouldn't cost the alert
    }
  }
  await tg.send(text, inTopic(topic));
}

// ---------------------------------------------------------------- status
const lastChecked = async (store: Store) =>
  Math.max(0, ...Object.values(await store.kvPrefix("bikes_checked:")).map(Number));

const WHAT: Record<ItemKey, string> = {
  bike: "adult bikes, no kids' bikes or parts",
  bed: "frame, with or without slats",
  kommode: "chest of drawers",
  free: "anything a new student can use",
};

export async function findsStatus(db: D1Database, store: Store): Promise<string> {
  await ensureTable(db);
  const s = await loadFindSettings(store);
  const checked = await lastChecked(store);
  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  const count = async (where: string, ...args: unknown[]) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM bikes WHERE ${where}`)
      .bind(...args).first<{ n: number }>())?.n ?? 0;

  const day: string[] = [];
  for (const i of ITEMS)
    day.push(`${i.emoji} ${await count("status='sent' AND sent_at > ? AND coalesce(item,'bike') = ?", now() - 86400, i.key)}`);
  const total = await count("status='sent'");
  const skipped = await count("status='skipped'");
  const queued = await count("status IN ('screen','new','ready')");
  const ago = checked ? `${fmtLeft(Math.max(0, now() - checked))} ago` : "not yet";

  return [
    `🔎 <b>Finds on Kleinanzeigen</b>, ${RADIUS_KM} km around Cottbus`,
    "",
    ...ITEMS.map((i) => {
      const it = s.items[i.key];
      return `${i.emoji} <b>${i.label}</b> (${WHAT[i.key]}): ` +
        (!it.on ? "⏸ paused" : i.priced ? `up to <b>${it.max} €</b> or free` : `free, rated <b>${it.floor}/10</b> or better`);
    }),
    "",
    `Each one is read and rated out of 10 by AI before it's posted.`,
    `Min rating:   ${s.min_score ? `${s.min_score}/10` : "none, post everything"}`,
    `Last check:   ${ago}`,
    ...(until > now() ? [`Backing off:  ${fmtLeft(until - now())} left`] : []),
    `Posted (24h): ${day.join(" · ")}`,
    `Posted total: ${total}`,
    `Filtered out: ${skipped}`,
    ...(queued ? [`Being rated:  ${queued}`] : []),
    "",
    `<i>Anyone in this group can change these.</i>`,
  ].join("\n");
}

export const findsKeyboard = (s: FindSettings): Button[][] => [
  ...ITEMS.map((i) => {
    const it = s.items[i.key];
    const what = !it.on ? "paused" : i.priced ? `≤ ${it.max} €` : `⭐ ≥ ${it.floor}`;
    return [
      { text: `${i.emoji} −${i.step}`, callback_data: `bk:price:${i.key}:-${i.step}` },
      { text: what, callback_data: "bk:noop" },
      { text: `+${i.step}`, callback_data: `bk:price:${i.key}:+${i.step}` },
      { text: it.on ? "⏸" : "▶️", callback_data: `bk:${it.on ? "off" : "on"}:${i.key}` },
    ];
  }),
  [{ text: "⭐ −1", callback_data: "bk:min:-1" },
   { text: s.min_score ? `min ${s.min_score}/10` : "min rating: none", callback_data: "bk:noop" },
   { text: "+1", callback_data: "bk:min:+1" }],
  [{ text: "🔄 Check now", callback_data: "bk:now" }],
];

/** One line for /status. */
export async function findsLine(store: Store): Promise<string> {
  const s = await loadFindSettings(store);
  const on = ITEMS.filter((i) => s.items[i.key].on);
  if (!on.length) return "Finds:           ⏸ all paused  → /finds";
  const until = Number((await store.kvGet("bikes_blocked_until")) ?? 0);
  if (until > now()) return `Finds:           ⏳ back in ${fmtLeft(until - now())}`;
  const checked = await lastChecked(store);
  return `Finds:           ✅ ${on.map((i) => `${i.emoji} ${i.priced ? `≤ ${s.items[i.key].max} €` : `⭐ ≥ ${s.items[i.key].floor}`}`).join(" · ")}` +
    (checked ? `, checked ${fmtLeft(Math.max(0, now() - checked))} ago` : "");
}
