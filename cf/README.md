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

**Forum topics.** If the group has topics, each kind of post goes to its own
one: set `TOPIC_WG`, `TOPIC_BIKE`, `TOPIC_BED`, `TOPIC_KOMMODE`, `TOPIC_FREE` in
`wrangler.toml` to the number at the end of the topic's link
(`t.me/c/<group>/<topic>`). Commands are answered in the topic they were
typed in; anything without a topic (or with a deleted one) goes to General.

**Is it healthy?** `curl 'https://wg-finder.<you>.workers.dev/health?ai'` answers
`{"ok":true,"openai":"ok"}` when the deployed OpenAI key works. A rejected key
(or no credit) also sends the group one alert - unlike a rate limit, it never
fixes itself. Meanwhile bikes are only posted unrated when their title
clearly names a bike, and rooms that failed can be re-drafted with `/retry`.

**Bot checks are handled quietly.** When wg-gesucht or Kleinanzeigen refuses a
request, that site (and only that site) waits and retries by itself, longer
each time it's refused again: 45, 90, 180 minutes, up to 6 hours. The group
isn't told - `/status` (and `/bikes`) show the countdown. Only an outage that
has gone on for 6 hours straight sends one message, once.

### Finds: bikes, a bed, a Kommode, free stuff

A second, independent job (`src/finds.ts`, `src/findai.ts`) posts cheap or
free finds from Kleinanzeigen within 30 km of Cottbus to the same group, each
with its own price cap:

| | What | Default cap |
|---|---|---|
| 🚲 | adult bikes (Damen, Herren, Weiteres) | 30 € |
| 🛏 | a bed frame for a 140×200 mattress (category Betten) | 100 € |
| 🗄 | a Kommode / chest of drawers (keyword search) | 35 € |
| 🎁 | anything free a new student can use for their room (category Zu verschenken) | rated 6/10+ |

Each one is read in full and rated 1-10 by a cheap model (`FINDS_MODEL`,
gpt-5.6-luna), with one line on why it got that score and what's worth
knowing before you go and get it.

What gets through is decided mostly without AI:

1. Searches use the seller's own category where there is one (bikes:
   Damen/Herren/Weiteres; beds: Betten), so kids' bikes, accessories and
   mattresses on their own are never fetched.
2. Title rules reject what's obvious - bike parts and "Fahrrad…" compounds,
   kids' markers; beds of another size, bunk/pet beds, slats or mattresses
   alone; changing tables and wardrobe inserts.
3. The ad page's own "Art" field has to agree.
4. Ads that were already more than 2 days old when first seen are stored
   quietly: no backlog flood when a search starts, no pinned "TOP" ads.

Only what's left reaches the AI, in the one call it needs anyway for the
rating; that call also confirms it's the right thing (it reads the bed size
from the description, tells a Kommode from a nightstand).

Free stuff comes in fast and is mostly junk, so it has one more tier: titles
that are clearly junk (stones, clothes, plants, sofas, kids' things) are
dropped, titles naming something on the wishlist (kettle, desk, monitor…) go
straight to a full rating, and vague ones ("Verschiedenes zu verschenken") are
screened together in one cheap AI call from their title and preview. Free
beds, Kommoden and bikes are handed to their own items and topics. Only free
finds rated 6/10 or better are posted; the card's ⭐ buttons move that bar.

It runs on its own cron (every 10 min on odd minutes), so it never shares a
tick or CPU budget with the WG job. Each tick checks the most overdue search
(bikes every 30 min, Weiteres every 2 h, bed and Kommode hourly) and reads
and rates at most two new ads. It keeps its own
backoff and cookie jar: if Kleinanzeigen rate-limits the bike search, the WG
search is not paused. While the WG search is itself being limited by
Kleinanzeigen, the bike job sits those runs out rather than make it worse.
Only one bike run works at a time (a lock in D1 that expires after 5 min), so
overlapping triggers or a tap on "Check now" can't post a bike twice.

`/finds` is open to **everyone in the group** (all other commands stay
owner-only): a card with − / + price buttons and a pause button per item, a
minimum rating, and check-now. Also `/finds bed 80`, `/finds kommode off`,
`/finds min 5`, `/finds now`; `/bikes` still works for the bikes. It ignores
`/pause`, which only stops the room search.

## Tests

    npm test

Offline tests for the finds job and its wiring (Node 22.6+): synthetic
Kleinanzeigen pages, an in-memory D1, and recorded OpenAI/Telegram calls.

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
