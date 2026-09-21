"""SQLite record of every ad we've seen and what happened to it."""
import os
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.environ.get(
    "WGFINDER_DB", Path(__file__).resolve().parent.parent / "wgfinder.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS ads (
    ad_id       TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    title       TEXT,
    rent        TEXT,
    district    TEXT,
    flatmates   TEXT,
    language    TEXT,
    ad_text     TEXT,
    message     TEXT,
    status      TEXT NOT NULL DEFAULT 'new',  -- new|pending|approved|skipped|filtered|error
    attempts    INTEGER NOT NULL DEFAULT 0,
    pushed_at   INTEGER,
    first_seen  INTEGER NOT NULL,
    updated     INTEGER NOT NULL
);
"""

MAX_ATTEMPTS = 3   # a failing ad is retried this many times, then given up on


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init():
    with _conn() as c:
        c.executescript(SCHEMA)
        # migrate older databases
        cols = {r["name"] for r in c.execute("PRAGMA table_info(ads)")}
        for col, ddl in (("attempts", "INTEGER NOT NULL DEFAULT 0"),
                         ("flatmates", "TEXT"), ("pushed_at", "INTEGER")):
            if col not in cols:
                c.execute(f"ALTER TABLE ads ADD COLUMN {col} {ddl}")


def seen(ad_id: str) -> bool:
    """Has this ad been dealt with? Ads that errored stay retryable.

    Anything already drafted, approved, skipped or filtered counts as seen, so
    we never pay for it twice. An ad that blew up mid-draft (bad API key, model
    rejecting a parameter, a network blip) is NOT seen - otherwise a transient
    fault would silently bury it forever - until it has failed MAX_ATTEMPTS times.
    """
    with _conn() as c:
        r = c.execute("SELECT status, attempts FROM ads WHERE ad_id=?",
                      (ad_id,)).fetchone()
    if r is None:
        return False
    if r["status"] == "error" and (r["attempts"] or 0) < MAX_ATTEMPTS:
        return False
    return True


def note_failure(ad_id: str, url: str = "", title: str = ""):
    """Record a failed draft attempt, keeping the ad retryable for a while."""
    now = int(time.time())
    with _conn() as c:
        c.execute("""INSERT INTO ads (ad_id,url,title,status,attempts,first_seen,updated)
                     VALUES (?,?,?, 'error', 1, ?, ?)
                     ON CONFLICT(ad_id) DO UPDATE SET
                        status='error', attempts=attempts+1, updated=excluded.updated""",
                  (ad_id, url, title, now, now))


def retry_failed() -> int:
    """Clear the error backlog so the next scan picks those ads up again."""
    with _conn() as c:
        cur = c.execute("DELETE FROM ads WHERE status='error'")
        return cur.rowcount


def record(ad_id: str, *, url: str, title: str = "", rent: str = "",
           district: str = "", status: str = "new", **extra):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            """INSERT INTO ads (ad_id,url,title,rent,district,status,first_seen,updated)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(ad_id) DO UPDATE SET status=excluded.status, updated=excluded.updated""",
            (ad_id, url, title, rent, district, status, now, now),
        )
        for k, v in extra.items():
            if k in ("language", "ad_text", "message", "flatmates"):
                c.execute(f"UPDATE ads SET {k}=?, updated=? WHERE ad_id=?", (v, now, ad_id))


def mark_pushed(ad_id: str):
    with _conn() as c:
        c.execute("UPDATE ads SET pushed_at=? WHERE ad_id=?",
                  (int(time.time()), ad_id))


def pushed_since(seconds: int) -> int:
    """How many ads we've sent in the last `seconds`."""
    cutoff = int(time.time()) - seconds
    with _conn() as c:
        r = c.execute("SELECT COUNT(*) n FROM ads WHERE pushed_at > ?",
                      (cutoff,)).fetchone()
    return r["n"]


def set_status(ad_id: str, status: str):
    with _conn() as c:
        c.execute("UPDATE ads SET status=?, updated=? WHERE ad_id=?",
                  (status, int(time.time()), ad_id))


def get(ad_id: str):
    with _conn() as c:
        return c.execute("SELECT * FROM ads WHERE ad_id=?", (ad_id,)).fetchone()


def stats() -> dict:
    with _conn() as c:
        rows = c.execute("SELECT status, COUNT(*) n FROM ads GROUP BY status").fetchall()
    return {r["status"]: r["n"] for r in rows}
