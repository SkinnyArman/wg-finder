import { SYSTEM } from "./prompt.ts";
import type { Profile } from "./settings.ts";

export interface Draft {
  language: "de" | "en";
  ad_summary: string;
  facts_used: string[];
  thin_ad: boolean;
  message: string;
}

interface AdLike {
  title: string; rent: string; size: string; district: string;
  text?: string | null; flatmates?: string;
  details?: Record<string, string>;   // e.g. Kleinanzeigen "Verfügbar ab"
}

function profileBlock(p: Profile): string {
  const a = (p.about ?? {}) as Record<string, any>;
  const s = (p.style ?? {}) as Record<string, any>;
  const L: string[] = ["=== APPLICANT ==="];
  L.push(`name: ${a.name}, age: ${a.age}, pronouns: ${a.pronouns}`);

  L.push("\n--- ALWAYS include all of these ---");
  for (const f of a.always ?? []) L.push(`  * ${f}`);

  L.push("\n--- IF_RELEVANT (only when the condition matches) ---");
  for (const it of a.if_relevant ?? [])
    L.push(`  * ${it.fact}\n      include when: ${String(it.when).replace(/\s+/g, " ")}`);

  L.push("\n--- CONTEXTUAL (only on a clear match; usually omit) ---");
  for (const it of a.contextual ?? [])
    L.push(`  * ${it.fact}\n      include when: ${String(it.when).replace(/\s+/g, " ")}`);

  L.push("\n--- NEVER (hard rules) ---");
  for (const f of a.never ?? []) L.push(`  ! ${String(f).replace(/\s+/g, " ")}`);

  if (a.move_in_rule)
    L.push(`\n--- MOVE-IN RULE ---\n${String(a.move_in_rule).replace(/\s+/g, " ")}`);

  L.push("\n=== STYLE ===");
  L.push(`length: ${s.length ?? "140-200 words"}`);
  L.push(`tone: ${String(s.tone ?? "warm and natural").replace(/\s+/g, " ")}`);
  for (const i of s.always_include ?? []) L.push(`MUST include: ${i}`);
  for (const i of s.never_include ?? []) L.push(`MUST NOT include: ${i}`);
  if (s.sign_off) L.push(`sign off as: ${s.sign_off}`);
  return L.join("\n");
}

/** Structured listing facts - "Verfügbar ab" feeds the move-in rule. */
function detailsBlock(d?: Record<string, string>): string {
  const e = Object.entries(d ?? {});
  return e.length ? "Listing facts:\n" + e.map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n" : "";
}

export async function compose(
  apiKey: string, model: string, profile: Profile, ad: AdLike, retryNote = "",
): Promise<Draft> {
  let adText = (ad.text ?? "").trim();
  if (adText.length > 6000) adText = adText.slice(0, 6000) + "\n[...truncated]";

  let user =
    `${profileBlock(profile)}\n\n` +
    `=== THE ANZEIGE ===\n` +
    `Title: ${ad.title}\nRent: ${ad.rent}\nSize: ${ad.size}\n` +
    `Area: ${ad.district}\nFlat: ${ad.flatmates || "not stated"}\n` +
    detailsBlock(ad.details) + "\n" +
    `Description:\n${adText || "(no description text could be extracted)"}\n`;
  if (retryNote) user += `\n=== REWRITE REQUEST ===\n${retryNote}\n`;

  const body: Record<string, unknown> = {
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const data = (await r.json()) as any;
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  const d = JSON.parse(raw) as Partial<Draft>;
  return {
    language: d.language === "en" ? "en" : "de",
    ad_summary: d.ad_summary ?? ad.title,
    facts_used: d.facts_used ?? [],
    thin_ad: Boolean(d.thin_ad),
    message: d.message ?? "",
  };
}
