// A rejected OpenAI key never fixes itself - unlike a rate limit - so it is
// the one failure the group hears about straight away. Once per outage: the
// first good answer from OpenAI resets it.

import type { Store } from "./store.ts";
import type { Telegram } from "./telegram.ts";

/** 401/403 (bad or revoked key) or no credit left: needs a human. */
export const keyRejected = (msg: string) =>
  /OpenAI (401|403)\b/.test(msg) || /insufficient_quota/.test(msg);

export async function aiFailed(store: Store, tg: Telegram, err: unknown): Promise<void> {
  const msg = String((err as any)?.message ?? err);
  if (!keyRejected(msg) || (await store.kvGet("ai_key_alerted")) === "1") return;
  await store.kvSet("ai_key_alerted", "1");
  const quota = /insufficient_quota/.test(msg);
  await tg.send(
    `⚠️ <b>OpenAI ${quota ? "has no credit left" : "rejected the API key"}</b>\n\n` +
    `Bike ratings and WG drafts can't run until it's fixed. Bikes are only ` +
    `posted meanwhile if their title clearly names a bike; rooms that fail ` +
    `can be re-drafted with /retry afterwards.\n\n` +
    (quota
      ? `Fix: add credit at platform.openai.com.`
      : `Fix: a new key from platform.openai.com, then in the cf folder ` +
        `<code>npx wrangler secret put OPENAI_API_KEY</code>.`));
}

export async function aiWorked(store: Store): Promise<void> {
  if ((await store.kvGet("ai_key_alerted")) === "1") await store.kvSet("ai_key_alerted", "0");
}

/** For /health?ai: does OpenAI accept the key? Looking up a model costs nothing. */
export async function checkKey(apiKey: string, model: string): Promise<string> {
  const r = await fetch(`https://api.openai.com/v1/models/${model}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return r.ok ? "ok" : `rejected (${r.status})`;
}
