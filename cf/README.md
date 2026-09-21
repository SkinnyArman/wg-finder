# wg-finder on Cloudflare Workers

The same bot, ported to run on Cloudflare's free plan. No card, no VM, no
always-on process to babysit.

**How it differs from the Python version**

| | Python | Worker |
|---|---|---|
| Runs | a long-lived process | cron every 2 min + webhook |
| Storage | SQLite file | D1 |
| Telegram | long-polling | webhook |
| Profile | `profile.yaml` | base64 secret |

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

### 3. Secrets

Your profile is personal, so it goes in as a secret rather than the repo:

    ./make-profile.sh
    npx wrangler secret put PROFILE_B64 < profile.b64

Then the rest:

    npx wrangler secret put OPENAI_API_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put TELEGRAM_CHAT_ID     # group id (negative) or your own
    npx wrangler secret put TELEGRAM_OWNER_ID    # your user id — only you can command it
    npx wrangler secret put WEBHOOK_SECRET       # any random string you invent

### 4. Deploy

    npm run deploy

Note the URL it prints, e.g. `https://wg-finder.<you>.workers.dev`.

### 5. Point Telegram at it

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

Logs:

    npx wrangler tail

Change your profile later: edit `../profile.yaml`, then

    ./make-profile.sh && npx wrangler secret put PROFILE_B64 < profile.b64

## Local development

    cp .dev.vars.example .dev.vars   # then fill it in
    npx wrangler d1 execute wg-finder --local --file=schema.sql
    npx wrangler dev --local --test-scheduled

Fire a scan by hand:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled"

## Costs

Free plan: 100k requests/day, 5 cron triggers, D1 included. This uses roughly
720 cron invocations a day and a handful of webhook calls. The only thing you
pay for is OpenAI, same as before.
