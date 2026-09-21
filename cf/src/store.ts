import type { Ad } from "./scraper.ts";

export const MAX_ATTEMPTS = 3;

export interface AdRow {
  ad_id: string; url: string; title: string; rent: string; size: string;
  district: string; image: string; flatmates: string; seeking: string;
  language: string | null; ad_text: string | null; message: string | null;
  status: string; attempts: number; pushed_at: number | null;
}

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  private db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }

  /** Dealt with already? Ads that errored stay retryable for a while. */
  async seen(adId: string): Promise<boolean> {
    const r = await this.db
      .prepare("SELECT status, attempts FROM ads WHERE ad_id=?")
      .bind(adId).first<{ status: string; attempts: number }>();
    if (!r) return false;
    if (r.status === "error" && (r.attempts ?? 0) < MAX_ATTEMPTS) return false;
    return true;
  }

  async seenMany(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const marks = ids.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(
        `SELECT ad_id FROM ads WHERE ad_id IN (${marks})
         AND NOT (status='error' AND attempts < ${MAX_ATTEMPTS})`)
      .bind(...ids).all<{ ad_id: string }>();
    return new Set((results ?? []).map((r) => r.ad_id));
  }

  /** Queue a freshly-found ad for drafting. */
  async queue(ad: Ad, flat: string): Promise<void> {
    const t = now();
    await this.db.prepare(
      `INSERT INTO ads (ad_id,url,title,rent,size,district,image,flatmates,
                        seeking,status,first_seen,updated)
       VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)
       ON CONFLICT(ad_id) DO NOTHING`)
      .bind(ad.ad_id, ad.url, ad.title, ad.rent, ad.size, ad.district,
            ad.image, flat, ad.seeking, t, t).run();
  }

  async markFiltered(ad: Ad, why: string): Promise<void> {
    const t = now();
    await this.db.prepare(
      `INSERT INTO ads (ad_id,url,title,rent,status,message,first_seen,updated)
       VALUES (?,?,?,?,'filtered',?,?,?)
       ON CONFLICT(ad_id) DO UPDATE SET status='filtered', updated=excluded.updated`)
      .bind(ad.ad_id, ad.url, ad.title, ad.rent, why, t, t).run();
  }

  /** Oldest ad still waiting for a description + draft. */
  async nextQueued(): Promise<AdRow | null> {
    return await this.db.prepare(
      `SELECT * FROM ads
       WHERE status='queued' OR (status='error' AND attempts < ${MAX_ATTEMPTS})
       ORDER BY first_seen LIMIT 1`).first<AdRow>();
  }

  async saveDraft(adId: string, language: string, adText: string, message: string) {
    await this.db.prepare(
      `UPDATE ads SET language=?, ad_text=?, message=?, status='pending',
                      pushed_at=?, updated=? WHERE ad_id=?`)
      .bind(language, adText, message, now(), now(), adId).run();
  }

  /** Store the generated text but leave the ad queued (delivery failed). */
  async keepDraft(adId: string, language: string, adText: string, message: string) {
    await this.db.prepare(
      `UPDATE ads SET language=?, ad_text=?, message=?, status='queued',
                      pushed_at=NULL, updated=? WHERE ad_id=?`)
      .bind(language, adText, message, now(), adId).run();
  }

  async setStatus(adId: string, status: string) {
    await this.db.prepare("UPDATE ads SET status=?, updated=? WHERE ad_id=?")
      .bind(status, now(), adId).run();
  }

  async noteFailure(adId: string) {
    await this.db.prepare(
      `UPDATE ads SET status='error', attempts=attempts+1, updated=? WHERE ad_id=?`)
      .bind(now(), adId).run();
  }

  async get(adId: string): Promise<AdRow | null> {
    return await this.db.prepare("SELECT * FROM ads WHERE ad_id=?")
      .bind(adId).first<AdRow>();
  }

  async pushedSince(seconds: number): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM ads WHERE pushed_at > ?")
      .bind(now() - seconds).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Unix ts of the most recent ad we sent, or 0. */
  async lastPushed(): Promise<number> {
    const r = await this.db
      .prepare("SELECT MAX(pushed_at) AS t FROM ads")
      .first<{ t: number | null }>();
    return r?.t ?? 0;
  }

  async countQueued(): Promise<number> {
    const r = await this.db.prepare(
      `SELECT COUNT(*) AS n FROM ads
       WHERE status='queued' OR (status='error' AND attempts < ${MAX_ATTEMPTS})`)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async retryFailed(): Promise<number> {
    const r = await this.db.prepare("DELETE FROM ads WHERE status='error'").run();
    return r.meta.changes ?? 0;
  }

  async stats(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM ads GROUP BY status")
      .all<{ status: string; n: number }>();
    return Object.fromEntries((results ?? []).map((r) => [r.status, r.n]));
  }

  // --- kv ---
  async kvGet(k: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT v FROM kv WHERE k=?").bind(k)
      .first<{ v: string }>();
    return r?.v ?? null;
  }

  async kvSet(k: string, v: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .bind(k, v).run();
  }
}
