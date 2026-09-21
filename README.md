# WG-Gesucht watcher (Cottbus)

Checks your WG-Gesucht searches every ~10 minutes, reads each new Anzeige,
drafts a reply in the ad's own language, and sends it to you on Telegram.
You tap **Approve** and it hands you the finished text plus the link — you
paste it yourself. Nothing is ever sent to a landlord automatically.

## No WG-Gesucht login needed

Ad descriptions are public, so there's nothing to log in for. The script only
reads listing pages and ad pages. It never touches the contact form
(`/nachricht-senden.html`), which is also Disallow-ed in their robots.txt —
that part stays manual, which is the whole point of the approve step.

## Testing it locally

**Stage 1 — see what it finds (no keys at all):**

    ./venv/bin/python preview.py --dry -n 3

**Stage 2 — check the drafts (needs only OPENAI_API_KEY):**

    ./venv/bin/python preview.py -n 2
    ./venv/bin/python preview.py -n 1 --city Senftenberg

This prints the ad and the message it would send, with the detected language
and which optional facts it chose. Costs about a cent. Do this until the tone
is right — editing `profile.yaml` between runs — before touching Telegram.

**Stage 3 — the real thing (needs Telegram too):**

    ./run.sh

Then send `/scan` to your bot to force an immediate check.

## Setup

1. `cp .env.example .env` and fill in your OpenAI key + Telegram details.
2. `./run.sh`

### Telegram bot (one time)
1. Open Telegram, message **@BotFather**, send `/newbot`.
2. Pick a name and a username ending in `bot`. It gives you a token.
3. Put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
4. Find your new bot in Telegram, hit **Start**, send it "hi".
5. Run `./venv/bin/python get_chat_id.py` → paste the id into `.env`.

## How the message gets written

`profile.yaml` splits everything about you into three tiers:

- **always** — in every message (name, age, BTU, non-smoker, languages, dates)
- **if_relevant** — only when the ad's vibe fits (cats, dev background, making friends)
- **contextual** — only on a clear match (board games, football, music, food)

The AI is told most messages should use *zero or one* contextual fact. That's
what keeps them from all reading the same, and stops it dumping your whole
biography into a room ad that just says "20qm, frei ab sofort".

It also must open by reacting to something specific in the ad, and is banned
from "I saw your ad", emojis, and generic filler.

## Cities covered

Cottbus plus the commutable towns, with IDs verified against wg-gesucht's
sitemap: Senftenberg (BTU's second campus), Forst, Vetschau, Drebkau,
Lauchhammer. Most are empty most of the time — that's normal, they're there
to catch new posts. To add one, search it on the site and copy the URL.

## Using it

| Command | What it does |
|---|---|
| `/pause` | Stop searching. `/pause 2h` stops for a while |
| `/resume` | Start again |
| `/more [n]` | Send n more now, ignoring the hourly cap (default 5) |
| `/settings` | Check interval, ads per hour, captcha pause |
| `/settings poll_minutes 30` | Set one directly |
| `/filters` | Show the ad filters, with buttons to change them |
| `/filters max_rent 750` | Set one directly |
| `/scan` | Check for new ads right now |
| `/stats` | What it has seen so far |
| `/retry` | Re-draft ads that errored |

Per ad: **Approve** (hands you the text to paste), **Rewrite** (different
angle, costs one more API call), **Skip** (never shown again).

Timing lives in `/settings`, not in `.env` — change the check interval from
Telegram and the schedule updates immediately, no restart. Defaults are in the
`behaviour:` block of `profile.yaml`.

By default it checks every **15 minutes** and sends at most **2 ads per hour**.
Queued ads cost nothing — no API call happens until an ad is actually sent.

Filter changes from Telegram are saved to `filters.local.json`, which
overrides `profile.yaml`. That keeps the commented YAML intact.

## Privacy

`profile.yaml` holds your personal details and is **gitignored**. The repo
ships `profile.example.yaml` with placeholders. Copy it and fill it in:

    cp profile.example.yaml profile.yaml

The bot only answers your `TELEGRAM_CHAT_ID`. Anyone else who finds it gets a
polite refusal and nothing runs.

## Deploying

See [DEPLOY.md](DEPLOY.md) — Oracle Cloud's Always Free tier runs it 24/7 at
no cost.

## When wg-gesucht blocks you

Too many requests and the site serves a captcha instead of listings. The bot
handles this without you:

1. It tells you it's blocked and **when it will try again**.
2. The countdown is stored on disk, so restarting the bot doesn't reset it —
   restarting to "fix" it would only make the block last longer.
3. `/scan`, `/more` and `/resume` refuse while it's running, showing the time
   left.
4. The moment the timer expires it resumes **by itself** and messages you.
   It does not wait for the next hourly check.

Nothing is lost while blocked; queued ads stay queued.

## Notes
- Every ad seen is recorded in `wgfinder.db` and never shown twice.
- Polls with ±90s jitter, 2.5–6s between page loads, max 8 drafts per tick.
  wg-gesucht soft-blocks with 404s if you hammer it; the client backs off.
- If parsing ever breaks, the raw HTML lands in `debug/`.
