import type { Store } from "./store.ts";

export interface Profile {
  about: Record<string, unknown>;
  style: Record<string, unknown>;
  behaviour?: Record<string, number>;
  searches: { name: string; url: string }[];
  filters: Record<string, unknown>;
}

export interface Settings {
  max_rent: number;
  min_rent: number;
  skip_female_only: boolean;
  skip_pendler: boolean;
  poll_minutes: number;
  max_per_hour: number;
  block_backoff_min: number;
  skip_if_title_contains: string[];
}

export const BOUNDS: Record<string, [number, number]> = {
  poll_minutes: [5, 180],
  max_per_hour: [1, 20],
  block_backoff_min: [10, 360],
  max_rent: [0, 5000],
  min_rent: [0, 5000],
};

export const LABELS: Record<string, string> = {
  max_rent: "Max rent (EUR)",
  min_rent: "Min rent (EUR)",
  skip_female_only: "Skip women-only WGs",
  skip_pendler: "Skip Pendler rooms",
  poll_minutes: "Check every (minutes)",
  max_per_hour: "Max ads per hour",
  block_backoff_min: "Pause after a captcha (minutes)",
};

const DEFAULTS: Settings = {
  max_rent: 600, min_rent: 0,
  skip_female_only: true, skip_pendler: true,
  poll_minutes: 60, max_per_hour: 2, block_backoff_min: 45,
  skip_if_title_contains: [],
};

export async function loadSettings(store: Store, profile: Profile): Promise<Settings> {
  const s: Settings = { ...DEFAULTS };
  Object.assign(s, profile.filters ?? {}, profile.behaviour ?? {});
  const raw = await store.kvGet("settings");
  if (raw) {
    try { Object.assign(s, JSON.parse(raw)); } catch { /* ignore bad json */ }
  }
  return s;
}

export async function setSetting(
  store: Store, profile: Profile, key: string, value: string | number | boolean,
): Promise<{ ok: boolean; msg: string }> {
  if (!(key in LABELS)) {
    return { ok: false, msg: `'${key}' is not editable. Try: ${Object.keys(LABELS).join(", ")}` };
  }
  const label = LABELS[key];
  const cur = await loadSettings(store, profile);
  let v: number | boolean;

  if (typeof (cur as never as Record<string, unknown>)[key] === "boolean") {
    v = ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  } else {
    const n = Number(String(value).trim());
    if (!Number.isFinite(n)) return { ok: false, msg: `'${value}' is not a number.` };
    const [lo, hi] = BOUNDS[key] ?? [0, Number.MAX_SAFE_INTEGER];
    if (n < lo) return { ok: false, msg: `${label}: minimum is ${lo}.` };
    if (n > hi) return { ok: false, msg: `${label}: maximum is ${hi}.` };
    v = Math.round(n);
  }

  const raw = await store.kvGet("settings");
  const over: Record<string, unknown> = raw ? JSON.parse(raw) : {};
  over[key] = v;
  await store.kvSet("settings", JSON.stringify(over));
  return { ok: true, msg: `${label} is now ${v}` };
}

// ---------- pause ----------
export async function pauseState(store: Store): Promise<[boolean, string]> {
  const v = Number((await store.kvGet("paused_until")) ?? 0);
  if (v === 0) return [false, "running"];
  if (v < 0) return [true, "paused indefinitely"];
  const left = v - Math.floor(Date.now() / 1000);
  if (left <= 0) { await store.kvSet("paused_until", "0"); return [false, "running"]; }
  return [true, `paused, ${fmtLeft(left)} left`];
}

export async function pause(store: Store, seconds: number | null): Promise<string> {
  if (seconds === null) { await store.kvSet("paused_until", "-1"); return "Paused indefinitely"; }
  await store.kvSet("paused_until", String(Math.floor(Date.now() / 1000) + seconds));
  return `Paused for ${fmtLeft(seconds)}`;
}

export const resume = (store: Store) => store.kvSet("paused_until", "0");

// ---------- bot-check backoff, per source ----------
// Each site backs off on its own: a block on Kleinanzeigen must not stop
// wg-gesucht, and vice versa. wg-gesucht keeps the original key so existing
// state carries over.
export type Source = "wg" | "ka";
export const SOURCES: Source[] = ["wg", "ka"];
export const SITE: Record<Source, string> = { wg: "wg-gesucht", ka: "Kleinanzeigen" };
const blockKey = (src: Source) => (src === "wg" ? "blocked_until" : "blocked_until_ka");

export async function blockSecondsLeft(store: Store, src: Source = "wg"): Promise<number> {
  const v = Number((await store.kvGet(blockKey(src))) ?? 0);
  if (v <= 0) return 0;
  return Math.max(0, v - Math.floor(Date.now() / 1000));
}

export async function startBlock(store: Store, minutes: number, src: Source = "wg"): Promise<void> {
  await store.kvSet(blockKey(src), String(Math.floor(Date.now() / 1000) + minutes * 60));
}

export const clearBlock = (store: Store, src: Source = "wg") => store.kvSet(blockKey(src), "0");

/** Seconds left per source; 0 means that source is usable. */
export async function blocks(store: Store): Promise<Record<Source, number>> {
  return { wg: await blockSecondsLeft(store, "wg"), ka: await blockSecondsLeft(store, "ka") };
}

export function fmtLeft(seconds: number): string {
  const mins = Math.floor(seconds / 60) + 1;
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m` : `${mins} min`;
}

export async function behaviourSummary(store: Store, profile: Profile): Promise<string> {
  const s = await loadSettings(store, profile);
  const [, state] = await pauseState(store);
  const b = await blocks(store);
  const waits = SOURCES.filter((x) => b[x] > 0).map((x) => `${SITE[x]} back in ${fmtLeft(b[x])}`);
  const status = waits.length ? `${state}; ${waits.join(", ")}` : state;
  return [
    `Status:            ${status}`,
    `Check every:       ${s.poll_minutes} min`,
    `Max ads per hour:  ${s.max_per_hour}`,
    `Pause on captcha:  ${s.block_backoff_min} min`,
  ].join("\n");
}

export async function filtersSummary(store: Store, profile: Profile): Promise<string> {
  const s = await loadSettings(store, profile);
  const on = (b: boolean) => (b ? "on" : "off");
  const words = s.skip_if_title_contains ?? [];
  return [
    `Max rent:          ${s.max_rent} EUR`,
    `Min rent:          ${s.min_rent} EUR`,
    `Skip women-only:   ${on(s.skip_female_only)}`,
    `Skip Pendler:      ${on(s.skip_pendler)}`,
    words.length ? `\nTitle blocklist (${words.length}):\n  ${words.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
