# Where to run this for free

The bot needs ~76 MB of RAM, a few KB of network per hour, and almost no CPU.
The hard part is not the resources — it's that it must stay **running**, because
the Approve buttons need a live process. Most "free tiers" in 2026 either sleep
when idle or have quietly closed.

## Recommended: Google Cloud e2-micro (Always Free)

A real always-on VM, free indefinitely, and — unlike Oracle — Google does not
reclaim it for being idle. 1 GB RAM is more than ten times what this needs.

**The catch:** it must be in `us-west1`, `us-central1` or `us-east1`. Any other
region is billed. US latency is irrelevant here since we poll hourly.

A card is required. Set a **budget alert at €1** so you'd hear about any
mistake immediately (Billing → Budgets & alerts).

### Create it

1. <https://console.cloud.google.com> → new project.
2. **Compute Engine → VM instances → Create instance**
3. Region **us-central1**, series **E2**, machine type **e2-micro**.
4. Boot disk: Ubuntu 24.04 LTS, **30 GB Standard persistent disk** (the free
   allowance — do not pick SSD, that is billed).
5. Leave firewall boxes unchecked. The bot makes only outbound connections.
6. Create, then **SSH** straight from the browser console.

### Install

    sudo apt update && sudo apt install -y python3-venv git
    git clone https://github.com/<you>/wg-finder.git
    cd wg-finder
    python3 -m venv venv
    ./venv/bin/pip install -r requirements.txt

### Configure

`profile.yaml` is not in the repo — it holds your personal details. Copy both
files up from your laptop:

    # on your LAPTOP
    gcloud compute scp profile.yaml .env <instance-name>:~/wg-finder/ --zone us-central1-a

Or paste them in on the server with `nano profile.yaml` and `nano .env`,
starting from `profile.example.yaml` and `.env.example`.

### Run it as a service

    sudo cp wg-finder.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now wg-finder
    systemctl status wg-finder
    journalctl -u wg-finder -f      # live logs

Send `/start` in Telegram. If it answers, you're done and your Mac is free.

### Updating

    cd ~/wg-finder && git pull
    ./venv/bin/pip install -r requirements.txt
    sudo systemctl restart wg-finder

---

## Why not the others

**Oracle Cloud Always Free** — I recommended this earlier and was wrong for
this workload. Oracle reclaims Always Free instances when the 7-day p95 CPU,
network *and* memory are all under 20%. This bot sits at roughly 0.1% CPU and
1.5% memory of a 6 GB A1. It is precisely the profile Oracle reclaims. The
hardware is generous, but you would be waiting for it to disappear.

**Fly.io** — the free tier ended; new accounts are pay-as-you-go.

**Koyeb** — free Starter tier closed to new signups after the Mistral
acquisition, and it scales to zero after an hour of no traffic anyway.

**Render** — free tier has **no background workers**, and free web services
spin down after 15 minutes idle. Not viable as-is.

**Railway / Replit** — trial credit, then paid.

## Free alternatives that don't involve a cloud account

**A Raspberry Pi**, an **old Android phone** running Termux, or any machine you
already leave on. This bot would not notice a Pi Zero. If you have one lying
around it is the cheapest correct answer, and the setup is identical to the
Linux steps above.

**GitHub Actions + a webhook** would be genuinely free forever, but the Approve
buttons need a reachable endpoint, so it means rewriting the bot around
webhooks and swapping SQLite for hosted storage. Ask if you want that — it is
a real option, just a different shape of program.

## Docker

If you prefer containers, on any of the above:

    docker build -t wg-finder .
    docker run -d --restart=always --env-file .env \
        -v $PWD/profile.yaml:/app/profile.yaml \
        -v $PWD/data:/app/data --name wg wg-finder
