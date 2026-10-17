CREATE TABLE IF NOT EXISTS ads (
  ad_id      TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT,
  rent       TEXT,
  size       TEXT,
  district   TEXT,
  image      TEXT,
  flatmates  TEXT,
  seeking    TEXT,
  language   TEXT,
  ad_text    TEXT,
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  attempts   INTEGER NOT NULL DEFAULT 0,
  pushed_at  INTEGER,
  first_seen INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ads_status ON ads(status);
CREATE INDEX IF NOT EXISTS ads_pushed ON ads(pushed_at);

-- settings overrides, cursors, captcha backoff, pause state
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- bike alerts (src/bikes.ts also creates this on first use)
CREATE TABLE IF NOT EXISTS bikes (
  ad_id      TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT,
  price      TEXT,
  place      TEXT,
  image      TEXT,
  snippet    TEXT,
  status     TEXT NOT NULL,      -- new -> ready -> sent | skipped | gone | failed
  why        TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  sent_at    INTEGER,
  score      INTEGER,            -- AI rating 1-10
  kind       TEXT,               -- AI label, e.g. "Women's city bike 28\""
  notes      TEXT,               -- JSON list of considerations
  rating_why TEXT                -- the score explained in one line
);
CREATE INDEX IF NOT EXISTS bikes_status ON bikes(status);
