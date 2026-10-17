# wg-finder on Cloudflare Workers

The same bot, ported to run on Cloudflare's free plan. No card, no VM, no
always-on process to babysit.

**How it differs from the Python version**

| | Python | Worker |
|---|---|---|
| Runs | a long-lived process | cron every 2 min + webhook |
| Storage | SQLite file | D1 |
| Telegram | long-polling | webhook |
| Profile | `profile.yaml` | a row in D1 |

Each cron tick does **one** small thing — refresh one city's listing, or draft
one queued ad — so no invocation comes near the free plan's 10 ms CPU limit.

## Deploy

### 1. Install and log in

    cd cf
    npm install
    npx wrangler login

### 2. Create the database

    npx wrangler d1 create wg-finder

Copy the printed `database_id` into `wrangler.toml`, then create the tables:

    npm run db:init

### 3. Load your profile

`profile.yaml` is ~4.5KB of JSON, which exceeds the 5.1KB limit on Worker
secrets once encoded — so it lives in D1 instead:

    ./make-profile.sh
    npx wrangler d1 execute wg-finder --remote --file=profile.sql

It is cached per isolate, so this costs nothing at runtime.

### 4. Secrets

    npx wrangler secret put OPENAI_API_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put TELEGRAM_CHAT_ID     # group id (negative) or your own
    npx wrangler secret put TELEGRAM_OWNER_ID    # your user id — only you can command it
    npx wrangler secret put WEBHOOK_SECRET       # any random string you invent

### 5. Deploy

    npm run deploy

Note the URL it prints, e.g. `https://wg-finder.<you>.workers.dev`.

### 6. Point Telegram at it

Telegram pushes updates to you instead of you polling. Register the webhook,
using the same secret you set above:

    curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
      -d "url=https://wg-finder.<you>.workers.dev" \
      -d "secret_token=<WEBHOOK_SECRET>"

Send `/start` in Telegram. If it answers, you're done.

**Only run one of the two.** If the Python bot is still running anywhere it
will fight the Worker over the same Telegram updates. Stop it first, and note
that `setWebhook` disables long-polling for that token automatically.

## Day to day

Commands are identical to the Python version: `/scan`, `/more`, `/filters`,
`/settings`, `/pause`, `/resume`, `/stats`, `/retry`.

### Bike alerts

A second, independent job (`src/bikes.ts`, `src/bikeai.ts`) posts bikes from
Kleinanzeigen within 30 km of Cottbus that are free or under a price cap
(default 30 €) to the same group. Each one is read in full and rated 1-10 by
a cheap model (`BIKES_MODEL`, gpt-5.6-luna), with one line on why it got that
score and the things worth knowing before you go and get it: defects, size,
what's included, pickup limits.

What gets through: whole bikes only. Parts and accessories are dropped by
title for free, then by the ad page's own "Art: Zubehör" field, and anything
left that still isn't a bike is caught by the model.

It runs on its own cron (every 10 min on odd minutes), so it never shares a
tick or CPU budget with the WG job. The listing is checked every 30 min; the
ticks in between read and rate at most two new ads each. It keeps its own
backoff and cookie jar: if Kleinanzeigen rate-limits the bike search, the WG
search is not paused. While the WG search is itself being limited by
Kleinanzeigen, the bike job sits those runs out rather than make it worse.
Only one bike run works at a time (a lock in D1 that expires after 5 min), so
overlapping triggers or a tap on "Check now" can't post a bike twice.

`/bikes` is open to **everyone in the group** (all other commands stay
owner-only): it shows the state with buttons for the price cap, a minimum
rating, pause and check-now. Also `/bikes price 30`, `/bikes min 5`,
`/bikes on|off|now`. It ignores `/pause`, which only stops the room search.

## Local development

    cp .dev.vars.example .dev.vars   # then fill it in
    npx wrangler d1 execute wg-finder --local --file=schema.sql
    npx wrangler d1 execute wg-finder --local --file=profile.sql
    npx wrangler dev --local --test-scheduled

Fire a scan by hand:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled"

## Costs

Free plan: 100k requests/day, 5 cron triggers, D1 included. This uses 2
triggers, roughly 870 cron invocations a day and a handful of webhook calls. The only thing you
pay for is OpenAI, same as before.
