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
