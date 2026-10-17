// Reads a bike ad and rates it, with a cheap model: a yes/no on "is this a
// whole bike", a 1-10 score, and the things worth knowing before you go and
// pick it up.

export interface Assessment {
  is_bike: boolean;
  reason: string;     // why it isn't a bike, when it isn't
  kind: string;       // "Men's city bike 28\"", "Kids' bike 16\" (~4-6 yrs)"
  score: number;      // 1-10
  why: string;        // the score in one line: what pushed it up or down
  notes: string[];    // considerations, at most 3
}

export interface BikeAd {
  title: string;
  price: string;
  place: string;                    // "03046 Cottbus · 1 km"
  details: Record<string, string>;  // Art, Typ, Zustand, Versand…
  text: string;
}

const SYSTEM = `You screen second-hand bike listings from Kleinanzeigen around Cottbus, Germany, for a group chat of people looking for a cheap or free bike. Read the listing and return JSON only:

{"is_bike": boolean, "reason": string, "kind": string, "score": integer, "why": string, "notes": [string]}

is_bike: true only for a complete, rideable-as-a-whole bicycle of any size - adult, kids', balance bike, e-bike, cargo bike. false for parts and accessories (bells, horns, handlebars, grips, lights, locks, helmets, seats, saddles, tires, wheels, pedals, racks, baskets, trailers), scooters, exercise bikes, and posts searching for a bike. If false, set reason (max 8 words) and leave the rest empty/0.

kind: short English label with type and wheel size if known, e.g. "Women's city bike 28\\"", "Kids' bike 16\\" (~4-6 yrs)", "Mountain bike 26\\"".

score 1-10, overall: is it worth going to get?
- condition and completeness weigh most: ready to ride vs. needs repair, missing or broken parts
- value: what you get for the price; free or very cheap for a rideable bike scores high
- location: in Cottbus itself is best; the further away (the place line shows km from Cottbus centre), the lower - 20-30 km means a train or bus trip to collect it
- everyday usefulness: brakes, gears, lights, sensible size
Anchors: 9-10 rideable, good condition, cheap, in Cottbus. 7-8 good deal with small caveats. 5-6 fine but needs work or is far. 3-4 big repairs, far, or poor value. 1-2 scrap.
Caps: condition not described at all -> at most 6. 20 km or more away -> at most 7. Needs repair to be ridden -> at most 5. Be strict; most listings land between 4 and 7.

why: one short line, under 90 characters, saying what drives the score up and what pulls it down, so a reader sees at a glance why it isn't higher or lower. Name the real factors, e.g. "Looks well kept and cheap, only docked for the 26 km pickup" or "Free, but needs new brakes and tires". If distance cost points, say so here.

notes: 0-3 short considerations a buyer should know, each under 60 characters, in English: defects, needed repairs, missing parts, pickup-only or time limits, frame size or rider height, age range for kids' bikes, what's included. Only what the listing says or clearly implies - never invent. Never restate the price, place or distance - they are shown already. Empty list if nothing notable.`;

export async function assessBike(apiKey: string, model: string, ad: BikeAd): Promise<Assessment> {
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
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const data = (await r.json()) as any;
  const d = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
  const score = Math.round(Number(d.score));
  return {
    is_bike: d.is_bike !== false,
    reason: String(d.reason ?? "").slice(0, 80),
    kind: String(d.kind ?? "").slice(0, 60),
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    why: String(d.why ?? "").trim().slice(0, 120),
    notes: (Array.isArray(d.notes) ? d.notes : [])
      .map((n: unknown) => String(n).trim())
      // the distance is on the line above; the model still repeats it now and then
      .filter((n: string) => n && !/\d+\s*km\b|from cottbus/i.test(n))
      .slice(0, 3)
      .map((n: string) => (n.length > 90 ? n.slice(0, 89) + "…" : n)),
  };
}
