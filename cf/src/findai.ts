// Reads a found ad and rates it, with a cheap model: is it really the thing
// we're looking for, a 1-10 score, why, and what's worth knowing before you
// go and pick it up. Rules in finds.ts already threw out the obvious misses;
// this catches what a title can't show - and the rating needs the call anyway.

export type ItemKey = "bike" | "bed" | "kommode";

export interface Assessment {
  is_match: boolean;
  reason: string;     // why it isn't what we want, when it isn't
  kind: string;       // "Women's city bike 28\"", "IKEA Malm bed 140×200 with slats"
  score: number;      // 1-10
  why: string;        // the score in one line: what pushed it up or down
  notes: string[];    // considerations, at most 3
}

export interface FoundAd {
  title: string;
  price: string;
  place: string;                    // "03046 Cottbus · 1 km"
  details: Record<string, string>;  // Art, Typ, Zustand, Versand…
  text: string;
}

interface Spec { what: string; isMatch: string; kinds: string; factors: string; caps: string; notes: string }

const SPECS: Record<ItemKey, Spec> = {
  bike: {
    what: "adult bike",
    isMatch: `true if the ad sells one or more complete adult bicycles - women's, men's, unisex, e-bike, cargo - that can be ridden as a whole, even if they need repair. false for parts or accessories on their own (frames, wheels, saddles, handlebars, lights, racks, displays, clothing, tools), kids' and balance bikes, scooters, notices about stolen bikes, and posts searching for a bike.`,
    kinds: `"Women's city bike 28\\"", "Men's trekking bike 28\\"", "Mountain bike 26\\""`,
    factors: `- condition and completeness weigh most: ready to ride vs. needs repair, missing or broken parts
- value: what you get for the price; free or very cheap for a rideable bike scores high
- everyday usefulness: brakes, gears, lights, sensible size`,
    caps: `condition not described at all -> at most 6. 20 km or more away -> at most 7. Needs repair to be ridden -> at most 5.`,
    notes: `defects, needed repairs, missing parts, pickup-only or time limits, frame size or rider height, what's included`,
  },
  bed: {
    what: "bed (140×200)",
    isMatch: `true if the ad sells a bed frame for a 140×200 cm mattress - with or without a slatted base (Lattenrost) or mattress, any style: wood, metal, upholstered, boxspring, IKEA. A double bed whose size isn't stated anywhere also counts - then add the note "Size not stated - ask" and score at most 5. false for other sizes (90, 100, 120, 160, 180 wide), mattresses, slatted bases or bedding on their own, kids', bunk and loft beds, and posts searching for a bed.`,
    kinds: `"IKEA Malm bed 140×200 with slats", "Solid wood double bed 140×200", "Boxspring bed 140×200"`,
    factors: `- condition and completeness weigh most: sturdy, no damage, all parts and screws there, slatted base included
- value: what you get for the price; a slatted base included adds real value, a used mattress at most a little (hygiene)
- transport: it's bulky - pickup needs a car or van and usually taking it apart, so distance counts more than for small things`,
    caps: `condition not described at all -> at most 6. 20 km or more away -> at most 6. No slatted base -> at most 7.`,
    notes: `slatted base or mattress included, already taken apart or not, dimensions, damage, pickup deadlines`,
  },
  kommode: {
    what: "chest of drawers (Kommode)",
    isMatch: `true if the ad sells a freestanding chest of drawers (Kommode) that can hold clothes - several drawers, any style or brand; some doors besides the drawers are fine. false for changing tables (Wickelkommode), inserts for wardrobes (e.g. for IKEA PAX), small nightstands, shoe cabinets, TV boards or sideboards without drawers, tables, miniatures and toys, handles or parts, and posts searching for one.`,
    kinds: `"IKEA Malm, 3 drawers", "Solid wood chest, 4 drawers", "Kommode with 2 doors and 3 drawers"`,
    factors: `- condition weighs most: drawers run smoothly, nothing broken, sturdy
- storage: more and bigger drawers are better for clothes
- value: what you get for the price
- transport: pickup needs a car or van, so distance counts more than for small things`,
    caps: `condition not described at all -> at most 6. 20 km or more away -> at most 6. A broken drawer or needs repair -> at most 5.`,
    notes: `dimensions, number of drawers, damage, pickup deadlines`,
  },
};

const system = (s: Spec) => `You rate second-hand ${s.what} listings from Kleinanzeigen around Cottbus, Germany, for a group chat of people looking for cheap or free things. Read the listing and return JSON only:

{"is_match": boolean, "reason": string, "kind": string, "score": integer, "why": string, "notes": [string]}

is_match: ${s.isMatch} If false, set reason (max 8 words) and leave the rest empty/0.

kind: short English label, e.g. ${s.kinds}.

score 1-10, overall: is it worth going to get?
${s.factors}
- location: in Cottbus itself is best; the further away (the place line shows km from Cottbus centre), the lower - 20-30 km means a long trip to collect it
Anchors: 9-10 good condition, cheap, in Cottbus. 7-8 good deal with small caveats. 5-6 fine but needs work or is far. 3-4 big repairs, far, or poor value. 1-2 junk.
Caps: ${s.caps} Be strict; most listings land between 4 and 7.

why: one short line, under 90 characters, saying what drives the score up and what pulls it down, so a reader sees at a glance why it isn't higher or lower. Name the real factors, e.g. "Looks well kept and cheap, only docked for the 26 km pickup" or "Free, but a drawer is broken". If distance cost points, say so here.

notes: 0-3 short considerations a buyer should know, each under 60 characters, in English: ${s.notes}. Only what the listing says or clearly implies - never invent. Never restate the price, place or distance - they are shown already. Empty list if nothing notable.`;

export async function assessItem(
  apiKey: string, model: string, item: ItemKey, ad: FoundAd,
): Promise<Assessment> {
  let text = ad.text.trim();
  if (text.length > 2500) text = text.slice(0, 2500) + " […]";
  const facts = Object.entries(ad.details).map(([k, v]) => `${k}: ${v}`).join("\n");
  const user =
    `Title: ${ad.title}\nPrice: ${ad.price || "not stated"}\nPlace: ${ad.place || "unknown"}\n` +
    (facts ? `${facts}\n` : "") +
    `\nDescription:\n${text || "(no description)"}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system(SPECS[item]) }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const data = (await r.json()) as any;
  const d = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
  let score = Math.round(Number(d.score));
  // A bed whose size the ad never states might not take a 140×200 mattress:
  // the prompt caps it at 5, and the model doesn't always listen.
  const notes = Array.isArray(d.notes) ? d.notes.map(String) : [];
  if (item === "bed" && notes.some((n: string) => /size not stated/i.test(n))) score = Math.min(score, 5);
  return {
    is_match: d.is_match !== false,
    reason: String(d.reason ?? "").slice(0, 80),
    kind: String(d.kind ?? "").slice(0, 60),
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    why: String(d.why ?? "").trim().slice(0, 120),
    notes: notes
      .map((n: string) => n.trim())
      // the distance is on the line above; the model still repeats it now and then
      .filter((n: string) => n && !/\d+\s*km\b|from cottbus/i.test(n))
      .slice(0, 3)
      .map((n: string) => (n.length > 90 ? n.slice(0, 89) + "…" : n)),
  };
}
