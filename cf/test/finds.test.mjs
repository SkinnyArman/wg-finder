// Offline tests for the finds job - bikes, bed, Kommode (src/finds.ts,
// findai.ts, aikey.ts) - and its wiring in index.ts. Run: npm test   (Node >= 22.6: node:sqlite + .ts imports)
//
// D1 is node:sqlite; Kleinanzeigen is synthetic listing pages in its card
// markup; OpenAI and Telegram are recorders. No network, no real ads.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const SRC = new URL("../src/", import.meta.url).pathname;
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// ---------------------------------------------------------------- fixtures
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
const card = ([id, title, price, place, km, date]) =>
  `<article class="aditem" data-adid="${id}" data-href="/s-anzeige/${slug(title)}/${id}-217-7743">` +
  `<img class="i" src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/aa/${id}?rule=$_2.AUTO">` +
  `<div><svg></svg><span>${place}</span><span class="k">(${km} km)</span></div>` +
  `<div><svg></svg><span>${date}</span></div>` +
  `<h3><a class="t" href="/s-anzeige/${slug(title)}/${id}-217-7743">${title}</a></h3>` +
  `<p class="mb-xsmall">Beschreibung</p><p class="text-title3 font-bold">${price}</p></article>`;
const page = (cards) => `<html><h1>Ergebnisse</h1>${cards.map(card).join("")}</html>`;

// [id, title, price, place, km, posted] - newest first, like Kleinanzeigen
const DAMEN = page([
  [101, "28 Damenrad", "20 € VB", "03048 Cottbus", 3, "Heute, 10:12"],
  [102, "Vorkriegsfahrrad", "30 €", "03130 Spremberg", 20, "Heute, 09:40"],            // AI: only parts
  [103, "26 er Damenrad", "30 € VB", "03050 Cottbus", 3, "Gestern, 18:05"],             // AI: 4/10
  [104, "Syncros M3.0 Lady Sattel *Neu*", "12 €", "01968 Senftenberg", 30, "Gestern, 17:00"],
  [105, "Bosch Smart System Kiox 300 Display (Neu)", "25 €", "03046 Cottbus", 1, "Gestern, 12:00"],
  [106, "Mifa DDR Klapprad Klappfahrrad Minirad Rahmen für Neuaufbau", "20 €", "03046 Cottbus", 1, "Gestern, 11:00"],
  [107, "Live Farbe Schwarz mit Rot schwarzem Schloss", "Zu verschenken", "01968 Hörlitz", 30, "Gestern, 10:00"],
  [108, "Kinderfahrrad 20 Zoll", "15 €", "03044 Cottbus", 2, "Gestern, 09:00"],
  [109, "Damen Fahrrad 28er", "30 €", "03149 Forst (Lausitz)", 21, "07.09.2026"],
  [110, "Diamant Damen Fahrrad 26 Zoll", "25 € VB", "02957 Krauschwitz", 30, "03.09.2026"],
]);
const HERREN = page([
  [201, "Giant Cityrad, 57 cm Rahmen, 3x8 Gangschaltung", "20 €", "03054 Cottbus", 8, "Heute, 08:20"],
  [202, "Cratoni MTB Helm", "20 €", "03044 Cottbus", 2, "Heute, 08:00"],
  [203, "Rennrad Hose long", "10 €", "03185 Teichland", 10, "Gestern, 20:00"],
  [204, "Flat Bar 780mm - Rose Hobo", "15 €", "03042 Cottbus", 6, "Gestern, 19:00"],    // AI: handlebar
  [205, "Herrenrad Everest", "25 €", "03042 Cottbus", 6, "Gestern, 15:00"],
  [206, "Herrenrad Pegasus", "30 €", "03042 Cottbus", 6, "13.10.2026"],
]);
const WEITERES = page([
  [301, "Rocky Mountain Bike 26 Zoll blau-silber", "40 € VB", "03058 Neuhausen/Spree", 11, "Heute, 07:00"],
  [302, "Hoverboard schwarz inkl. Ladegerät und Tasche", "25 € VB", "03222 Lübbenau (Spreewald)", 27, "Heute, 06:00"],
  [303, "Zwei zerlegbare Fahrräder 28\"", "1 € VB", "03185 Peitz", 14, "Gestern, 16:00"],
  [304, "26\" Hinterrad RENAK Rücktrittnabe", "40 €", "03185 Peitz", 14, "Gestern, 14:00"],
  [305, "Speedbike 28 Zoll Fahrrad", "25 €", "03185 Peitz", 14, "01.09.2026"],
]);
const BETTEN = page([
  [401, "IKEA Brimnes Bett 140x200 cm mit 4 Schubladen", "90 €", "03044 Cottbus", 2, "Heute, 11:00"],
  [402, "Bettgestell 160x200 Massivholz", "50 €", "03046 Cottbus", 1, "Heute, 10:00"],
  [403, "Lattenrost MatraFlex 140x200", "30 €", "03046 Cottbus", 1, "Gestern, 21:00"],
  [404, "Doppelbett Holz mit Lattenrost", "80 €", "03050 Cottbus", 3, "Gestern, 20:00"],    // AI: size unstated
  [405, "Hochbett 90x200 weiß", "40 €", "03042 Cottbus", 6, "Gestern, 19:00"],
  [406, "Hundebett XXL", "15 €", "03044 Cottbus", 2, "Gestern, 18:00"],
  [407, "Boxspringbett 140 x 200 grau", "150 €", "03048 Cottbus", 3, "Gestern, 17:00"],
  [408, "Bett 90 x 200 mit Matratze", "40 €", "03054 Cottbus", 8, "Gestern, 16:00"],
  [409, "Matratze 140x200 Kaltschaum", "35 €", "03099 Kolkwitz", 9, "Gestern, 15:00"],
  [410, "IKEA Malm Bett 140x200", "60 €", "03046 Cottbus", 1, "10.10.2026"],
]);
const KOMMODEN = page([
  [501, "IKEA Malm Kommode 3 Schubladen weiß", "30 €", "03046 Cottbus", 1, "Heute, 12:00"],
  [502, "Wickelkommode mit Auflage", "25 €", "03044 Cottbus", 2, "Heute, 11:30"],
  [503, "Kommode Hemnes/ Nachttisch", "15 €", "03116 Drebkau", 10, "Gestern, 10:00"],        // AI: nightstand
  [504, "Massive Kommode zu verschenken", "Zu verschenken", "03130 Spremberg", 20, "Gestern, 09:00"],
  [505, "Kommode Eiche 4 Schubladen", "40 €", "03046 Cottbus", 1, "Gestern, 08:00"],
  [506, "Ikea Kommode für Pax", "Zu verschenken", "03149 Forst (Lausitz)", 21, "Gestern, 07:00"],
  [507, "Kommode weiß", "30 €", "03044 Cottbus", 2, "05.10.2026"],
]);
const FREE = page([
  [601, "Verschiedenes zum Verschenken", "Zu verschenken", "03050 Cottbus", 3, "Heute, 12:33"],        // vague → screen
  [602, "Lampenschirm zu verschenken", "Zu verschenken", "03046 Cottbus", 1, "Heute, 06:58"],          // rated 5: held back
  [603, "diverse Teller, Tassen, Kannen zu verschenken", "Zu verschenken", "03229 Luckaitztal", 25, "Heute, 01:09"],
  [604, "12t Granit-Stein zu verschenken", "Zu verschenken", "03130 Spremberg", 20, "Gestern, 16:51"],
  [605, "Nike Jogginganzug zu verschenken", "Zu verschenken", "03046 Cottbus", 1, "Heute, 06:53"],
  [606, "nur noch Doppelbett mit Lattenroste zu verschenken", "Zu verschenken", "03042 Cottbus", 6, "Gestern, 18:00"],
  [607, "Monitor 24 Zoll", "Zu verschenken", "03046 Cottbus", 1, "Heute, 05:00"],
  [608, "Klebetapete", "Zu verschenken", "03046 Cottbus", 1, "Gestern, 18:30"],                         // vague → screened out
  [609, "Pflanzen zu verschenken", "Zu verschenken", "03226 Vetschau", 19, "Heute, 06:45"],
  [610, "Einbauküche gebraucht zu verschenken", "Zu verschenken", "02979 Elsterheide", 30, "Gestern, 10:57"],
  [611, "Fahrradschloss", "Zu verschenken", "03046 Cottbus", 1, "Gestern, 09:00"],
  [612, "Schallplatten Sammlung Rock", "Zu verschenken", "03048 Cottbus", 3, "Gestern, 08:00"],          // vague → passes
  [613, "Kaffeemaschine", "Zu verschenken", "03048 Cottbus", 3, "05.10.2026"],
]);
const PAGES = { damen: DAMEN, herren: HERREN, weiteres: WEITERES, betten: BETTEN };
// the seller's category on each ad page; Kommoden come from a keyword search: none
const ART = {};
for (const [html, art] of [[BETTEN, "Betten"], [KOMMODEN, null], [FREE, null]])
  for (const m of html.matchAll(/data-href="\/s-anzeige\/([^/]+)\//g)) ART[m[1]] = art;
const adPage = (art, text = "Gebraucht, guter Zustand, alles funktioniert. Nur Abholung, bitte bis Ende der Woche melden.") =>
  `<html><p id="viewad-description-text" class="x">${text}</p><ul>` +
  (art ? `<li class="addetailslist--detail">Art<span class="a">${art}</span></li>` : "") +
  `<li class="addetailslist--detail">Zustand<span class="a">In Ordnung</span></li></ul></html>`;

// ---------------------------------------------------------------- D1 shim
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
function makeDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA.replace(/-- bike alerts[\s\S]*$/, ""));   // bikes.ts creates its own table
  return { prepare: (sql) => new Stmt(db, sql), raw: db };
}

// ---------------------------------------------------------------- network
const net = { wgKa: "ok", ka: "ok", detailBlock: false, tgFailAfter: Infinity, ai: "ok",
              aiTitles: [], aiItems: [], screens: [], kaHits: [], tgCalls: [], gone: new Set(), art: {} };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("kleinanzeigen.de")) {
    net.kaHits.push({ url, cookie: init.headers?.Cookie ?? "" });
    if (net.ka === "block") return new Response("Access denied", { status: 403 });
    if (url.includes("/s-anzeige/")) {
      if (net.detailBlock) return new Response("Access denied", { status: 403 });
      const s = url.split("/s-anzeige/")[1].split("/")[0];
      if (net.gone.has(s)) return new Response(DAMEN, { status: 200 });     // deleted ad: a search page
      return new Response(adPage(s in net.art ? net.art[s] : s in ART ? ART[s] : "Damen"), { status: 200 });
    }
    if (url.includes("/s-auf-zeit-wg/")) {                                   // the WG search's own listing
      if (net.wgKa === "block") return new Response("Access denied", { status: 403 });
      return new Response(DAMEN, { status: 200 });
    }
    if (url.includes("/kommode/k0c80l7743r30")) return new Response(KOMMODEN, { status: 200 });
    if (url.includes("/s-zu-verschenken/")) return new Response(FREE, { status: 200 });
    const art = /art_s:(\w+)/.exec(url)?.[1];
    assert.ok(PAGES[art], "listing for an unexpected search: " + url);
    return new Response(PAGES[art], { status: 200, headers: { "set-cookie": "sess=abc; Path=/" } });
  }
  if (url.includes("api.openai.com/v1/models/"))
    return new Response("{}", { status: net.ai === "401" ? 401 : 200 });
  if (url.includes("api.openai.com")) {
    const body = JSON.parse(init.body);
    const title = /Title: (.*)/.exec(body.messages[1].content)?.[1] ?? "";
    const sys = body.messages[0].content;
    if (/You screen free giveaway ads/.test(sys)) {                        // the batched screen
      net.screens.push(body.messages[1].content);
      if (net.ai === "down") return new Response('{"error":"overloaded"}', { status: 503 });
      if (net.ai === "401") return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
      const ads = [...body.messages[1].content.matchAll(/id: (\S+)\ntitle: (.*)/g)].map(([, id, title]) =>
        ({ id, score: /Verschiedenes/.test(title) ? 6 : /Schallplatten/.test(title) ? 5 : 1, reason: "test" }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ads }) } }] }));
    }
    if (!/listings from Kleinanzeigen around Cottbus/.test(sys))          // a WG draft, not a find
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(
        { language: "de", ad_summary: "", facts_used: [], thin_ad: false, message: "Hallo, ich bin Arman!" }) } }] }));
    const item = /adult bike listings/.test(sys) ? "bike" : /bed \(140×200\)/.test(sys) ? "bed"
      : /free giveaway listings/.test(sys) ? "free" : "kommode";
    net.aiTitles.push(title); net.aiItems.push(item);
    if (net.ai === "down") return new Response('{"error":"overloaded"}', { status: 503 });
    if (net.ai === "401") return new Response('{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}', { status: 401 });
    assert.equal(body.model, "gpt-5.6-luna");
    const v = /Live Farbe|Flat Bar/.test(title) ? { is_match: false, reason: "handlebar or junk, no bike" }
      : /Vorkrieg/.test(title) ? { is_match: false, reason: "pedals and parts only" }
      : /Nachttisch/.test(title) ? { is_match: false, reason: "small nightstand" }
      : item === "bed" ? { is_match: true, kind: /Doppelbett/.test(title) ? "Wooden double bed" : "IKEA Brimnes bed 140×200",
          score: /Doppelbett/.test(title) ? 6 : 7,       // 6: over the cap for an unstated size
          why: "Cheap and close, slats included",
          notes: /Doppelbett/.test(title) ? ["Size not stated - ask"] : ["4 drawers underneath"] }
      : item === "free" ? { is_match: true, kind: /Teller/.test(title) ? "Kitchen set: plates, cups" : "Useful bits",
          score: /Teller/.test(title) ? 8 : /Monitor/.test(title) ? 7 : /Lampenschirm/.test(title) ? 5 : 6,
          why: "Free and close, easy to carry", notes: ["Complete set"] }
      : item === "kommode" ? { is_match: true, kind: "IKEA Malm, 3 drawers", score: /Massive/.test(title) ? 6 : 7,
          why: "Good condition, needs a car to collect", notes: ["80 × 78 × 48 cm"] }
      : { is_match: true, kind: "Women's city bike 28\"", score: /26 er Damenrad/.test(title) ? 4 : 7,
          why: "Looks well kept, docked for the pickup distance",
          notes: ["Rideable", "Pickup only", "26 km from Cottbus"] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(v) } }] }));
  }
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (body.message_thread_id === 999)
      return new Response('{"ok":false,"description":"Bad Request: message thread not found"}', { status: 400 });
    const posted = net.tgCalls.filter((c) => c.method === "sendPhoto" || c.method === "sendMessage").length;
    if ((method === "sendPhoto" || method === "sendMessage") && posted >= net.tgFailAfter)
      return new Response('{"ok":false,"description":"Too Many Requests"}', { status: 429 });
    net.tgCalls.push({ method, body });
    return new Response('{"ok":true,"result":{}}');
  }
  throw new Error("unexpected fetch " + url);
};
// no real waiting between requests in tests
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 1), ...a);
const quiet = console.error; console.error = () => {};

const B = await import(SRC + "finds.ts");
const { parseListing } = await import(SRC + "kleinanzeigen.ts");
const { Store } = await import(SRC + "store.ts");
const { Telegram } = await import(SRC + "telegram.ts");
const worker = (await import(SRC + "index.ts")).default;

// ---------------------------------------------------------------- helpers
let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ✓", name); };
const posts = () => net.tgCalls.filter((c) => c.method === "sendPhoto" || c.method === "sendMessage");
const captions = () => posts().map((p) => p.body.caption ?? p.body.text ?? "");
const env = (DB) => ({ DB, OPENAI_API_KEY: "k", FINDS_MODEL: "gpt-5.6-luna", OPENAI_MODEL: "m",
  TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "-100", TELEGRAM_OWNER_ID: "1000001", WEBHOOK_SECRET: "s" });
const tg = new Telegram("T", "-100");
const fresh = () => { const DB = makeDB(); return [DB, new Store(DB), env(DB)]; };
const status = (DB) => Object.fromEntries(DB.raw.prepare(
  "SELECT status, COUNT(*) n FROM bikes GROUP BY status").all().map((x) => [x.status, x.n]));
const why = (DB, title) => DB.raw.prepare("SELECT why FROM bikes WHERE title = ?").get(title)?.why;
const drain = async (E, st, max = 40) => {
  const out = [];
  for (let i = 0; i < max; i++) {
    const r = await B.findsStep(E, st, tg);
    out.push(r);
    if (r === "finds: nothing to rate") break;
  }
  return out;
};
const reset = () => { net.tgCalls = []; net.aiTitles = []; net.aiItems = []; net.screens = []; net.kaHits = []; };
const listings = () => net.kaHits.filter((h) => !h.url.includes("/s-anzeige/"));

// ---------------------------------------------------------------- 1. rules
console.log("\n1. title rules (no AI)");
await ok("kids' bikes, parts and accessories are rejected", () => {
  for (const t of ["Syncros M3.0 Lady Sattel *Neu*", "Fahrrad Mantel 26x1.75 26er Nylon F-259-11",
    "Fahrrad Lenker STYX Lenkervorbau schwarz", "Original-Ladegerät", "2x Dynamo DDR Ruhla 6V 3W , gerne auch einzeln",
    "28 Zoll Laufrad mit Nabendynamo", "Alulaufrad Citec", "Fahrradräder 26-28 Zoll", "Cratoni MTB Helm",
    "Rennrad Drahtreifenfelgen Schlauchreifenfelgen Laufräder Bahnrad", "neue Schutzbleche für ein Fahrrad, 4 Stück",
    "Herren Rennrad Hose kurz", "Rennrad unterzieh shirt", "Kinderfahrrad 20\" + Fahrradhelm", "Kinderlaufrad, robust",
    "Kleinkindsitz Babboe", "Hoverboard schwarz inkl. Ladegerät und Tasche", "Verkaufe einen guten Roller. 12-Zoll.",
    "DDR Fahrrad Seitenständer Klappständer Fahrradständer 26\"", "FAHRRAD NAVI NEUWERTIG",
    "Fahrrad Lift Deckenaufhängung", "City Cruiser Fahrradlenker", "Fahrrad-Anhängerkupplung",
    "DDR Diamant Rennrad Fahrradrahmen +2 Gabeln", "Puky Laufrad hellblau für Kinder",
    "Rooster Big Daddy BMX Fahrrad 20 Zoll Kinder", "Amigo Jungenfahrrad 20 Zoll schwarz",
    "Dino Bikes Mädchenfahrrad ab 3 Jahren zum Aufsteigen", "KINDERFAHRRAD 14 ZOLL, MÄDCHENFAHRRAD"])
    assert.ok(B.rejectReason(t), t);
});
await ok("the two that slipped through on Oct 21/22 are now rejected by rules", () => {
  assert.equal(B.rejectReason("Bosch Smart System Kiox 300 Display (Neu)"), "part (kiox)");
  assert.equal(B.rejectReason("Mifa DDR Klapprad Klappfahrrad Minirad Rahmen für Neuaufbau"), "frame only");
  assert.ok(B.rejectReason("Nyon Display für Bosch E-Bike"));
  assert.ok(B.rejectReason("Fahrrad nur Rahmen 28 Zoll"));
});
await ok("real bikes pass, including ones that mention their frame", () => {
  for (const t of ["28 Damenrad", "26 er Damenrad", "Blaues Damenrad 28 Zoll mit defektem Fahrradkorb",
    "Giant Cityrad, 57 cm Rahmen, 3x8 Gangschaltung", "Damenrad 52er Rahmen", "Herrenrad Alu-Rahmen 28 Zoll",
    "Fahrrad, blau, guter Zustand, außer Reifen", "Fahrrad DDR Herrenfahrrad fahrbereit Licht 26 Zoll Oldtimer 3Gang",
    "Rocky Mountain Bike 26 Zoll blau-silber", "Minirad 20 Zoll", "Speedbike 28 Zoll Fahrrad",
    "treckinrad 28 zoll", "Damenfahrrad 28 Zoll Gepäckträger Korb", "Herren Jungen Fahrrad 26er"])
    assert.equal(B.rejectReason(t), null, t);
});
await ok("titles rules can't settle go to the AI rather than being guessed", () => {
  for (const t of ["Cervelo ZFS-5, XO AXS, Größe M", "Live Farbe Schwarz mit Rot schwarzem Schloss",
    "28\" Damen-Cityrad City-Fahrrad Damenfahrrad Damenrad Vorderrad Nabendynamo"])
    assert.equal(B.rejectReason(t), null, t);
  assert.equal(B.namesBike("Cervelo ZFS-5, XO AXS"), false);
  assert.equal(B.namesBike("26 Zoll Fahrrad + Zubehör"), true);
});

console.log("\n1b. bed and Kommode rules (no AI)");
await ok("beds: wrong size, kids'/bunk/pet beds, mattress or slats alone → no", () => {
  const no = {
    "Bettgestell 160x200 Massivholz": "size 160 wide", "Bett 90 x 200 mit Matratze": "size 90 wide",
    "Doppelbett 1,80 m Eiche": "size 180 wide", "Hochbett 90x200 weiß": "kids' or bunk bed",
    "Kinderbett 70x140": "kids' or bunk bed", "Hundebett XXL": "pet bed",
    "Matratze 140x200 Kaltschaum": "mattress only", "Lattenrost MatraFlex 140x200": "slatted base only",
    "Bettwäsche 140x200 Satin": "bedding", "Suche Bett 140x200": "someone searching",
  };
  for (const [t, why] of Object.entries(no)) assert.equal(B.bedRejectReason(t), why, t);
});
await ok("beds: 140 wide is a clear yes; no size stated → the AI reads the ad", () => {
  for (const t of ["IKEA Brimnes Bett 140x200 cm mit 4 Schubladen", "Boxspringbett 140 x 200 grau",
    "Bett 1,40 m mit Lattenrost", "Ikea Lyksele Bett / Couch 140x200", "Polsterbett 140er grau"]) {
    assert.equal(B.bedRejectReason(t), null, t); assert.ok(B.namesBed(t), t);
  }
  for (const t of ["Doppelbett Holz mit Lattenrost", "IKEA Hemnes Bett", "Bett mit Lehne", "Bettgestell OHNE Lattenrost"]) {
    assert.equal(B.bedRejectReason(t), null, t); assert.ok(!B.namesBed(t), t);
  }
});
await ok("Kommode: changing tables, wardrobe inserts, handles → no; lookalikes → the AI", () => {
  for (const t of ["Wickelkommode mit Auflage", "Ikea Kommode für Pax", "Kommode Griffe Messing 6 Stück",
    "Puppenhaus Miniatur Kommode", "Suche Kommode"])
    assert.ok(B.kommodeRejectReason(t), t);
  for (const t of ["IKEA Malm Kommode 3 Schubladen weiß", "Massive Kommode zu verschenken",
    "IKEA Brimnes Kommode Schubladenschrank weiß", "Weiße Kommode mit 3 Schubladen – gebraucht"]) {
    assert.equal(B.kommodeRejectReason(t), null, t); assert.ok(B.namesKommode(t), t);
  }
  for (const t of ["Kommode Hemnes/ Nachttisch", "Antik Schrank Kommode Beistellschrank", "Kommode/Sideboard"]) {
    assert.equal(B.kommodeRejectReason(t), null, t); assert.ok(!B.namesKommode(t), t);
  }
});

console.log("\n1c. free-stuff rules (no AI)");
await ok("junk dropped by title: stones, clothes, plants, sofas, kitchens, kids', bike gear", () => {
  for (const t of ["12t Granit-Stein zu verschenken", "Nike Jogginganzug zu verschenken", "2 Paar Damenstiefel Gr. 40",
    "Pflanzen zu verschenken", "Robuste Zimmerpflanzen zu verschenken (Pilea u.a.)", "Eckcouch zu verschenke",
    "Einbauküche gebraucht zu verschenken", "fürs Kinderzimmer", "Katzenspielzeug", "Fahrradschloss",
    "Split/Schotter 16/32 Selbstabholung", "Bauschutt abzugeben", "Matratze 90x200", "Bild zu verschenken"])
    assert.ok(B.freeRejectReason(t), t);
});
await ok("…but not by an unlucky word ending: Versand, Preis, Massivholz, Schallplatten", () => {
  for (const t of ["Schreibtisch Massivholz, Versand möglich", "Reiskocher, Preis: geschenkt", "Schallplatten Sammlung Rock"])
    assert.equal(B.freeRejectReason(t), null, t);
});
await ok("wishlist titles skip the screen; free beds, Kommoden, bikes go to their own items", () => {
  for (const t of ["diverse Teller, Tassen, Kannen", "Monitor 24 Zoll", "kaffeemaschine", "Lampenschirm zu verschenken",
    "Garderobe zu verschenken", "lebensmittel", "Schreibtisch Massivholz, Versand möglich"])
    assert.ok(B.namesFree(t), t);
  for (const t of ["Verschiedenes zum Verschenken", "zum Verschenken", "Schrank zu verschenken"]) assert.ok(!B.namesFree(t), t);
  assert.equal(B.routeFree("nur noch Doppelbett mit Lattenroste zu verschenken"), "bed");
  assert.equal(B.routeFree("Massive Kommode zu verschenken"), "kommode");
  assert.equal(B.routeFree("Damenrad 28 Zoll zu verschenken"), "bike");
  assert.equal(B.routeFree("Monitor 24 Zoll"), null);
});

// ---------------------------------------------------------------- 2. flow
console.log("\n2. searches → rules → AI → posts (bikes ≤ 30 €, bed ≤ 100 €, Kommode ≤ 35 €)");
{
  const [DB, st, E] = fresh(); reset();
  const t = [];
  for (let i = 0; i < 6; i++) t.push(await B.findsStep(E, st, tg));
  t.forEach((x, i) => console.log(`   tick ${i + 1}: ${x}`));
  const which = (h) => /art_s:(\w+)/.exec(h.url)?.[1] ?? (h.url.includes("/kommode/") ? "kommode"
    : h.url.includes("/s-zu-verschenken/") ? "free" : "?");
  await ok("six ticks, one listing each: Damen, Herren, free, beds, Kommoden, then the 2-hourly Weiteres", () => {
    assert.deepEqual(listings().map(which), ["damen", "herren", "free", "betten", "kommode", "weiteres"]);
  });
  await ok("each search carries its own item's price cap", () => {
    const url = (w) => listings().find((h) => which(h) === w).url;
    assert.ok(url("damen").includes("preis::30/") && url("weiteres").includes("preis::30/"));
    assert.ok(url("betten").includes("preis::100/"));
    assert.ok(url("kommode").includes("preis::35/kommode/"));
  });
  const rest = await drain(E, st);
  await ok("then idle ticks only read and rate - no more listing requests", () => {
    assert.equal(listings().length, 6);
    assert.equal(rest.at(-1), "finds: nothing to rate");
  });
  const by = (item) => net.aiTitles.filter((_, i) => net.aiItems[i] === item).sort();
  await ok("the AI saw only what the rules let through, with the right item's prompt", () => {
    assert.deepEqual(by("bike"), ["26 er Damenrad", "28 Damenrad", "Flat Bar 780mm - Rose Hobo",
      "Giant Cityrad, 57 cm Rahmen, 3x8 Gangschaltung", "Herrenrad Everest",
      "Live Farbe Schwarz mit Rot schwarzem Schloss", "Vorkriegsfahrrad", "Zwei zerlegbare Fahrräder 28\""]);
    assert.deepEqual(by("bed"), ["Doppelbett Holz mit Lattenrost", "IKEA Brimnes Bett 140x200 cm mit 4 Schubladen",
      "nur noch Doppelbett mit Lattenroste zu verschenken"]);
    assert.deepEqual(by("free"), ["Lampenschirm zu verschenken", "Monitor 24 Zoll", "Schallplatten Sammlung Rock",
      "Verschiedenes zum Verschenken", "diverse Teller, Tassen, Kannen zu verschenken"]);
    assert.deepEqual(by("kommode"), ["IKEA Malm Kommode 3 Schubladen weiß", "Kommode Hemnes/ Nachttisch", "Massive Kommode zu verschenken"]);
  });
  await ok("free: the 3 vague titles took ONE screening call; 2 passed", () => {
    assert.equal(net.screens.length, 1);
    assert.equal(net.screens[0].match(/^id: /gm).length, 3);
    assert.equal(why(DB, "Klebetapete"), "screen: 1/10 test");
  });
  await ok("posted: 5 bikes 🚲, 3 beds 🛏 (one from the free category), 2 Kommoden 🗄, 4 free 🎁", () => {
    const n = (e) => captions().filter((c) => c.startsWith(e)).length;
    assert.deepEqual([n("🚲"), n("🛏"), n("🗄"), n("🎁")], [5, 3, 2, 4]);
    assert.equal(why(DB, "Vorkriegsfahrrad"), "ai: pedals and parts only");
    assert.equal(why(DB, "Kommode Hemnes/ Nachttisch"), "ai: small nightstand");
    assert.ok(!captions().some((c) => /Vorkrieg|Flat Bar|Live Farbe|Nachttisch/.test(c)));
  });
  await ok("rules settled the rest without AI", () => {
    assert.equal(why(DB, "Bosch Smart System Kiox 300 Display (Neu)"), "part (kiox)");
    assert.equal(why(DB, "Mifa DDR Klapprad Klappfahrrad Minirad Rahmen für Neuaufbau"), "frame only");
    assert.equal(why(DB, "Kinderfahrrad 20 Zoll"), "kids' bike");
    assert.equal(why(DB, "Rocky Mountain Bike 26 Zoll blau-silber"), "price 40 € VB");
    assert.equal(why(DB, "Herrenrad Pegasus"), "old ad (13.10.2026)");
    assert.equal(why(DB, "Bettgestell 160x200 Massivholz"), "size 160 wide");
    assert.equal(why(DB, "Matratze 140x200 Kaltschaum"), "mattress only");
    assert.equal(why(DB, "Boxspringbett 140 x 200 grau"), "price 150 €");
    assert.equal(why(DB, "IKEA Malm Bett 140x200"), "old ad (10.10.2026)");
    assert.equal(why(DB, "Wickelkommode mit Auflage"), "not a Kommode (wickel)");
    assert.equal(why(DB, "Kommode Eiche 4 Schubladen"), "price 40 €");
  });
  await ok("message: price, place, rating, why, notes (distance note dropped), link", () => {
    const c = captions().find((x) => x.includes("Giant Cityrad"));
    console.log("   sample:\n     " + c.split("\n").join("\n     "));
    assert.match(c, /<b>20 €<\/b> · 03054 Cottbus · 8 km\n⭐ <b>7\/10<\/b> · Women's city bike 28"\n<i>Looks well kept, docked for the pickup distance<\/i>\n• Rideable\n• Pickup only\n<a /);
  });
  await ok("a bed with no size stated is capped at 5/10 even when the model says more", () =>
    assert.equal(DB.raw.prepare("SELECT score FROM bikes WHERE title='Doppelbett Holz mit Lattenrost'").get().score, 5));
  await ok("free stuff: says Free, needs 6/10 (the 5/10 lampshade is held back)", () => {
    const c = captions().find((x) => x.includes("Teller"));
    console.log("   free sample:\n     " + c.split("\n").join("\n     "));
    assert.match(c, /^🎁 <b>diverse Teller, Tassen, Kannen zu verschenken<\/b>\n🆓 <b>Free<\/b> · 03229 Luckaitztal · 25 km\n⭐ <b>8\/10<\/b>/);
    assert.equal(why(DB, "Lampenschirm zu verschenken"), "rated 5/10");
    assert.equal(why(DB, "12t Granit-Stein zu verschenken"), "not for a student's room (granitstein)");
    assert.equal(why(DB, "Kaffeemaschine"), "old ad (05.10.2026)");
  });
  await ok("bed and Kommode alerts look the same, with their own emoji; free shows as free", () => {
    const bed = captions().find((x) => x.includes("Doppelbett Holz"));
    const kom = captions().find((x) => x.includes("Massive Kommode"));
    console.log("   bed sample:\n     " + bed.split("\n").join("\n     "));
    assert.match(bed, /^🛏 <b>Doppelbett Holz mit Lattenrost<\/b>\n<b>80 €<\/b>[\s\S]*⭐ <b>5\/10<\/b> · Wooden double bed[\s\S]*• Size not stated - ask/);
    assert.match(kom, /^🗄 <b>Massive Kommode zu verschenken<\/b>\n🆓 <b>Free<\/b> · 03130 Spremberg · 20 km\n⭐ <b>6\/10<\/b>/);
  });
}

// ---------------------------------------------------------------- 3. ad page + AI
console.log("\n3. the ad page, and when the AI fails");
{
  const [DB, st, E] = fresh(); reset();
  net.art["28-damenrad"] = "Kinder"; net.art["26-er-damenrad"] = "Zubehör";
  await B.findsStep(E, st, tg); await drain(E, st);
  await ok("page says Art: Kinder / Zubehör → skipped, no AI call", () => {
    assert.equal(why(DB, "28 Damenrad"), "Art: Kinder");
    assert.equal(why(DB, "26 er Damenrad"), "Art: Zubehör");
    assert.ok(!net.aiTitles.includes("28 Damenrad") && !net.aiTitles.includes("26 er Damenrad"));
  });
  net.art = {};
}
{
  const [DB, st, E] = fresh(); reset();
  net.gone.add("giant-cityrad-57-cm-rahmen-3x8-gangschaltung");
  await drain(E, st);
  await ok("deleted ad (redirects to a search) → gone, no AI call", () => {
    assert.equal(DB.raw.prepare("SELECT status FROM bikes WHERE title LIKE 'Giant%'").get().status, "gone");
    assert.ok(!net.aiTitles.some((x) => x.startsWith("Giant")));
  });
  net.gone.clear();
}
{
  const [DB, st, E] = fresh(); reset(); net.ai = "down";
  await drain(E, st, 60);
  await ok("OpenAI down (503): named bikes go out unrated after 3 tries; no key alert", () => {
    assert.ok(posts().length > 0);
    assert.ok(captions().every((c) => /not rated \(AI unavailable\)/.test(c)));
    assert.ok(!captions().some((c) => /rejected the API key/.test(c)));
  });
  await ok("…and titles only the AI could judge are dropped, not posted unrated", () => {
    assert.equal(why(DB, "Live Farbe Schwarz mit Rot schwarzem Schloss"), "unsure, and no AI to ask");
    assert.equal(why(DB, "Flat Bar 780mm - Rose Hobo"), "unsure, and no AI to ask");
    assert.equal(why(DB, "Doppelbett Holz mit Lattenrost"), "unsure, and no AI to ask");
    assert.equal(why(DB, "Kommode Hemnes/ Nachttisch"), "unsure, and no AI to ask");
    assert.equal(why(DB, "Verschiedenes zum Verschenken"), "unsure, and no AI to ask");
    assert.ok(captions().some((c) => c.startsWith("🛏 <b>IKEA Brimnes")) && captions().some((c) => c.startsWith("🗄 <b>IKEA Malm")));
  });
  net.ai = "ok";
}
{
  const [DB, st, E] = fresh(); reset(); net.ai = "401";
  await drain(E, st, 60);
  const alerts = () => captions().filter((c) => /rejected the API key/.test(c));
  await ok("key rejected (401): ONE alert, saying how to fix it", () => {
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0], /wrangler secret put OPENAI_API_KEY/);
  });
  const add = (id, title) => DB.raw.prepare(`INSERT INTO bikes (ad_id,url,title,price,place,image,snippet,status,first_seen)
    VALUES (?,?,?,'20 €','03046 Cottbus · 1 km','','','new',?)`)
    .run(id, `https://www.kleinanzeigen.de/s-anzeige/${slug(title)}/${id}-217-1`, title, Math.floor(Date.now() / 1000));
  net.ai = "ok"; add("ka-900", "Damenrad 28");
  await B.findsStep(E, st, tg);
  await ok("the first good answer from OpenAI resets it; a later rejection alerts again", async () => {
    assert.equal(await st.kvGet("ai_key_alerted"), "0");
    net.ai = "401"; add("ka-901", "Herrenrad 26");
    await B.findsStep(E, st, tg);
    assert.equal(alerts().length, 2);
  });
  net.ai = "ok";
}
{
  const [DB, st, E] = fresh(); reset();
  await B.setFindSetting(st, "min", 5);
  await drain(E, st);
  await ok("min rating 5: the 4/10 is held back", () => {
    assert.equal(why(DB, "26 er Damenrad"), "rated 4/10");
    assert.ok(!captions().some((c) => /⭐ <b>4\/10/.test(c)));
  });
}

// ---------------------------------------------------------------- 4. blocks
console.log("\n4. bot checks: quiet, backing off, isolated from the WG search");
{
  const [DB, st, E] = fresh(); reset();
  await st.kvSet("cookies_ka", "wg=session"); await st.kvSet("blocked_until_ka", "0");
  net.ka = "block";
  let r = await B.findsStep(E, st, tg);
  await ok("listing blocked: bike-only backoff, own jar reset, and silent", async () => {
    assert.match(r, /retry in 60 min/);
    assert.equal(await st.kvGet("blocked_until_ka"), "0");
    assert.equal(await st.kvGet("cookies_ka"), "wg=session");
    assert.equal(await st.kvGet("cookies_bikes"), "");
    assert.equal(posts().length, 0);
  });
  const hits = net.kaHits.length;
  r = await B.findsStep(E, st, tg);
  await ok("while backing off: no request at all", () => {
    assert.match(r, /backing off/); assert.equal(net.kaHits.length, hits);
  });
  net.ka = "ok"; await st.kvSet("bikes_blocked_until", "0"); net.detailBlock = true;
  r = await B.findsStep(E, st, tg);
  await ok("ad page blocked next tick: longer backoff, still silent, listing kept", () => {
    assert.match(r, /retry in 120 min/);
    assert.equal(posts().length, 0);
    assert.ok(status(DB).new > 0);
  });
  const o = JSON.parse(await st.kvGet("outage:bikes"));
  await st.kvSet("outage:bikes", JSON.stringify({ ...o, since: o.since - 7 * 3600 }));
  await st.kvSet("bikes_blocked_until", "0");
  r = await B.findsStep(E, st, tg);
  await ok("7 hours into the outage: exactly one message", () => {
    assert.equal(posts().length, 1);
    assert.match(captions()[0], /blocking the bike and furniture searches for 7 hours[\s\S]*room search isn't affected/);
  });
  await st.kvSet("bikes_blocked_until", "0");
  r = await B.findsStep(E, st, tg);
  await ok("…no second one while it lasts; backoff tops out at 6 h", () => {
    assert.equal(posts().length, 1);
    assert.match(r, /retry in 360 min/);
  });
  net.detailBlock = false;
  await st.kvSet("bikes_blocked_until", "0");
  await st.kvSet("blocked_until_ka", String(Math.floor(Date.now() / 1000) + 600));
  const h2 = net.kaHits.length;
  r = await B.findsStep(E, st, tg);
  await ok("Kleinanzeigen limiting the WG search: bikes sit it out", () => {
    assert.match(r, /waiting/); assert.equal(net.kaHits.length, h2);
  });
  await st.kvSet("blocked_until_ka", "0");
  await B.findsStep(E, st, tg);
  await ok("first normal answer ends the outage: the next block starts at 60 min, silent", async () => {
    assert.equal(await st.kvGet("outage:bikes"), "");
    net.ka = "block"; await st.kvSet("bikes_blocked_until", "0");
    const before = posts().length;
    assert.match(await B.findsStep(E, st, tg, true), /retry in 60 min/);
    assert.equal(posts().length, before);
    net.ka = "ok";
  });
}
{
  const [DB, st, E] = fresh(); reset(); net.tgFailAfter = 0;
  await B.findsStep(E, st, tg);
  await ok("Telegram flood control (429): nothing marked failed, the rated bike waits", () => {
    assert.equal(posts().length, 0);
    assert.equal(status(DB).ready, 1);
  });
  net.tgFailAfter = Infinity;
  await B.findsStep(E, st, tg);
  await ok("…and goes out on the next tick", () =>
    assert.ok(captions().some((c) => c.startsWith("🚲 <b>28 Damenrad</b>"))));
}
{
  const [DB, st, E] = fresh(); reset();
  const [a, b] = await Promise.all([B.findsStep(E, st, tg), B.findsStep(E, st, tg, true)]);
  await ok("cron tick + 'Check now' at once: one runs, the other steps aside", async () => {
    assert.ok([a, b].includes("finds: another run is still going"), `${a} | ${b}`);
    const titles = captions().map((c) => c.split("\n")[0]);
    assert.equal(new Set(titles).size, titles.length);
    assert.equal(await st.kvGet("bikes_lock"), "0");
  });
}

console.log("\n4b. the WG search's own Kleinanzeigen blocks");
{
  const [DB, st, E] = fresh(); reset();
  const URL = "https://www.kleinanzeigen.de/s-auf-zeit-wg/cottbus/anzeige:angebote/c199l7743";
  await st.kvSet("profile", JSON.stringify({ about: { name: "Arman" }, style: {}, filters: {},
    searches: [{ name: "Cottbus KA", url: URL, hot: true }] }));
  const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  const logs = []; const log = console.log;
  const tick = async () => {
    console.log = (...x) => logs.push(x.join(" "));
    await st.kvSet("blocked_until_ka", "0"); await st.kvSet("checked:" + URL, "0");   // time passes
    await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: Date.UTC(2026, 9, 19, 8, 16) }, E, ctx);
    await Promise.all(waits);
    console.log = log;
    return logs.at(-1);
  };
  net.wgKa = "block";
  const r = [await tick(), await tick(), await tick()];
  await ok("blocked again and again: silent, waiting 45 → 90 → 180 min", () => {
    assert.deepEqual(r.map((x) => /retry in (\d+) min/.exec(x)[1]), ["45", "90", "180"]);
    assert.equal(posts().length, 0);
  });
  const o = JSON.parse(await st.kvGet("outage:ka"));
  await st.kvSet("outage:ka", JSON.stringify({ ...o, since: o.since - 6 * 3600 }));
  await tick(); await tick(); await tick();
  await ok("6 hours in: one message for the whole outage; backoff capped at 6 h", () => {
    assert.equal(posts().length, 1);
    assert.match(captions()[0], /Kleinanzeigen has been blocking the room search for 6 hours[\s\S]*wg-gesucht isn't affected/);
    assert.match(logs.at(-1), /retry in 360 min/);
  });
  net.wgKa = "ok";
  await tick();
  await ok("works again: outage over; the next block starts at 45 min, silent", async () => {
    assert.equal(await st.kvGet("outage:ka"), "");
    net.wgKa = "block"; net.detailBlock = true;      // next tick drafts a queued ad: its page is refused
    assert.match(await tick(), /retry in 45 min/);
    assert.equal(posts().length, 1);
    net.wgKa = "ok"; net.detailBlock = false;
  });
}

// ---------------------------------------------------------------- 4c. topics
console.log("\n4c. forum topics");
{
  const [DB, st, E0] = fresh(); reset();
  const E = { ...E0, TOPIC_WG: "597", TOPIC_BIKE: "595", TOPIC_KOMMODE: "596", TOPIC_BED: "598", TOPIC_FREE: "610" };
  for (let i = 0; i < 6; i++) await B.findsStep(E, st, tg);
  await drain(E, st);
  const threads = (emoji) => [...new Set(posts().filter((p) => (p.body.caption ?? p.body.text).startsWith(emoji))
    .map((p) => p.body.message_thread_id))];
  await ok("each item lands in its own topic: 🚲 595, 🛏 598, 🗄 596, 🎁 610 - a free bed in 🛏", () => {
    assert.deepEqual(threads("🚲"), [595]); assert.deepEqual(threads("🛏"), [598]); assert.deepEqual(threads("🗄"), [596]);
    assert.deepEqual(threads("🎁"), [610]);
    assert.ok(posts().some((p) => /Doppelbett mit Lattenroste/.test(p.body.caption ?? "") && p.body.message_thread_id === 598));
  });
  // the WG search: one listing tick queues rooms, the next drafts and posts one
  const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  const log = console.log; console.log = () => {};
  reset();
  for (let i = 0; i < 2; i++) {
    await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: Date.UTC(2026, 9, 22, 8, 16) }, E, ctx);
    await Promise.all(waits);
  }
  console.log = log;
  await ok("a WG draft (card + text to copy) lands in the WG topic, 597", () => {
    assert.ok(posts().length >= 2, JSON.stringify(net.tgCalls.map((c) => c.method)));
    assert.ok(posts().every((p) => p.body.message_thread_id === 597));
    assert.ok(posts().some((p) => /Hallo, ich bin Arman!/.test(p.body.text ?? "")));
  });
  const post = async (u) => { net.tgCalls = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(u) }), E);
    return net.tgCalls; };
  let c = await post({ message: { text: "/finds", from: { id: 555 }, chat: { id: -100 }, message_thread_id: 598, is_topic_message: true } });
  await ok("a command typed in a topic is answered in that topic", () => assert.equal(c.at(-1).body.message_thread_id, 598));
  c = await post({ message: { text: "/status", from: { id: 1000001 }, chat: { id: -100 }, message_thread_id: 597, is_topic_message: true } });
  await ok("…owner commands too (/status in the WG topic)", () => assert.equal(c[0].body.message_thread_id, 597));
  c = await post({ message: { text: "/finds", from: { id: 555 }, chat: { id: -100 } } });
  await ok("…and one typed in General stays in General", () => assert.equal(c.at(-1).body.message_thread_id, undefined));
}
{
  const [DB, st, E0] = fresh(); reset();
  const E = { ...E0, TOPIC_BIKE: "999" };                       // that topic was deleted
  await B.findsStep(E, st, tg);
  await ok("a deleted topic: the post goes to General instead of being lost", () => {
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].body.message_thread_id, undefined);
  });
}

// ---------------------------------------------------------------- 5. wiring
console.log("\n5. cron dispatch, commands, permissions, health");
{
  const [DB, st, E] = fresh(); reset();
  const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  const logs = []; const log = console.log; console.log = (...x) => logs.push(x.join(" "));
  const at = (m) => Date.UTC(2026, 9, 19, 8, m);
  await worker.scheduled({ cron: "5,15,25,35,45,55 * * * *", scheduledTime: at(15) }, E, ctx); await Promise.all(waits);
  await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: at(16) }, E, ctx); await Promise.all(waits);
  console.log = log;
  await ok("odd-minute tick → bikes; even → the WG step", () => {
    assert.ok(logs.some((l) => /^step: finds: damen 10 ads/.test(l)), logs.join(" | "));
    assert.equal(logs.filter((l) => /^step: /.test(l) && !/^step: finds:/.test(l)).length, 1, logs.join(" | "));
  });
  const post = async (u) => { net.tgCalls = []; await worker.fetch(new Request("https://w/", { method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s", "Content-Type": "application/json" }, body: JSON.stringify(u) }), E);
    return net.tgCalls; };
  const msg = (text, from, chat = -100) => post({ message: { text, from: { id: from }, chat: { id: chat } } });
  const btn = (data, from) => post({ callback_query: { id: "q", data, from: { id: from }, message: { chat: { id: -100 }, message_id: 7 } } });
  const set = async () => (await B.loadFindSettings(st)).items;
  let c = await msg("/finds", 555);
  console.log("   /finds ->\n     " + c.at(-1).body.text.split("\n").join("\n     "));
  await ok("group member: /finds card lists the three items with their caps", () => {
    const t = c.at(-1).body.text;
    assert.match(t, /🚲 <b>Bikes<\/b>[^\n]*up to <b>30 €<\/b>/);
    assert.match(t, /🛏 <b>Bed 140×200<\/b>[^\n]*up to <b>100 €<\/b>/);
    assert.match(t, /🗄 <b>Kommode<\/b>[^\n]*up to <b>35 €<\/b>/);
    const rows = c.at(-1).body.reply_markup.inline_keyboard;
    assert.deepEqual(rows.slice(0, 4).map((r) => r.map((b) => b.text)),
      [["🚲 −5", "≤ 30 €", "+5", "⏸"], ["🛏 −10", "≤ 100 €", "+10", "⏸"], ["🗄 −5", "≤ 35 €", "+5", "⏸"],
       ["🎁 −1", "⭐ ≥ 6", "+1", "⏸"]]);
    assert.match(t, /🎁 <b>Free stuff<\/b>[^\n]*free, rated <b>6\/10<\/b> or better/);
  });
  await btn("bk:price:bed:+10", 555); await btn("bk:price:kommode:-5", 555);
  await ok("buttons: bed +10 €, Kommode −5 €", async () => {
    assert.equal((await set()).bed.max, 110); assert.equal((await set()).kommode.max, 30);
  });
  await btn("bk:price:+5", 555);
  await ok("an old bike card's +5 € button still works (bikes)", async () => assert.equal((await set()).bike.max, 35));
  await btn("bk:price:free:+1", 555);
  await ok("free stuff's ± moves its rating floor, not a price", async () => {
    assert.equal((await set()).free.floor, 7); assert.equal((await set()).free.max, 0);
  });
  await msg("/finds free 6", 555);
  await msg("/finds bed 80", 555); await msg("/finds kommode 40", 555);
  await ok("/finds bed 80, /finds kommode 40", async () => {
    assert.equal((await set()).bed.max, 80); assert.equal((await set()).kommode.max, 40);
  });
  await msg("/finds kommode off", 555);
  reset(); await st.kvSet("bikes_lock", "0");
  for (const k of ["damen", "herren", "bed", "kommode", "weiteres", "free"]) await st.kvSet("bikes_checked:" + k, "0");
  for (let i = 0; i < 6; i++) await B.findsStep(E, st, tg);
  await ok("a paused item isn't searched at all", async () => {
    assert.equal((await set()).kommode.on, false);
    assert.ok(!net.kaHits.some((h) => h.url.includes("/kommode/")));
    assert.ok(net.kaHits.some((h) => h.url.includes("art_s:betten")));
  });
  await btn("bk:on:kommode", 555);
  await msg("/bikes price 25", 555);
  await ok("/bikes keeps its old meaning: price and on/off for bikes only", async () => {
    assert.equal((await set()).bike.max, 25);
    await msg("/bikes off", 555);
    const it = await set();
    assert.deepEqual([it.bike.on, it.bed.on, it.kommode.on], [false, true, true]);
    await msg("/bikes on", 555);
  });
  c = await msg("/finds off", 555, 555);
  await ok("stranger in a private chat: refused", async () => {
    assert.match(c[0].body.text, /only answers to them/);
    assert.equal((await set()).bed.on, true);
  });
  c = await msg("/status", 1000001);
  await ok("owner /status has the finds line", () =>
    assert.match(c[0].body.text, /Finds: {11}✅ 🚲 ≤ 25 € · 🛏 ≤ 80 € · 🗄 ≤ 40 € · 🎁 ⭐ ≥ 6, checked/));
  const health = async (q) => worker.fetch(new Request("https://w/health" + q), E);
  await ok("/health?ai asks OpenAI whether the deployed key works", async () => {
    assert.deepEqual(await (await health("?ai")).json(), { ok: true, openai: "ok" });
    net.ai = "401";
    assert.deepEqual(await (await health("?ai")).json(), { ok: true, openai: "rejected (401)" });
    net.ai = "ok";
    assert.equal(await (await health("")).text(), "ok");
  });
}

// ---------------------------------------------------------------- 6. live data
console.log("\n6. existing data");
{
  const [DB, st, E] = fresh();
  DB.raw.exec(`CREATE TABLE bikes (ad_id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, price TEXT,
    place TEXT, image TEXT, snippet TEXT, status TEXT NOT NULL, why TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL, sent_at INTEGER, score INTEGER, kind TEXT, notes TEXT)`);
  DB.raw.exec(`INSERT INTO bikes (ad_id,url,title,status,first_seen) VALUES ('ka-1','u','old','sent',1)`);
  await ok("an older table gains the new columns; old rows are kept", async () => {
    assert.match(await B.findsStep(E, st, tg), /damen 10 ads/);
    const cols = DB.raw.prepare("PRAGMA table_info(bikes)").all().map((x) => x.name);
    assert.ok(cols.includes("rating_why") && cols.includes("item"));
    assert.equal(DB.raw.prepare("SELECT title FROM bikes WHERE ad_id='ka-1'").get().title, "old");
  });
}

console.error = quiet;
console.log(`\nall ${pass} checks passed`);
