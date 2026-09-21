#!/bin/bash
# Creates the tables one statement at a time, in case --file misbehaves.
set -e
cd "$(dirname "$0")"
run() { npx wrangler d1 execute wg-finder --remote --command "$1"; }

run "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
run "CREATE TABLE IF NOT EXISTS ads (
  ad_id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, rent TEXT, size TEXT,
  district TEXT, image TEXT, flatmates TEXT, seeking TEXT, language TEXT,
  ad_text TEXT, message TEXT, status TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0, pushed_at INTEGER,
  first_seen INTEGER NOT NULL, updated INTEGER NOT NULL)"
run "CREATE INDEX IF NOT EXISTS ads_status ON ads(status)"
run "CREATE INDEX IF NOT EXISTS ads_pushed ON ads(pushed_at)"
run "SELECT name FROM sqlite_master WHERE type='table'"
