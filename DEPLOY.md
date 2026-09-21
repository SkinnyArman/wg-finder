# Deploying to Oracle Cloud (Always Free)

Oracle's Always Free tier gives you a small ARM VM that runs forever at no
cost. It does not expire after a trial, and it does not sleep — which matters
here, because the Approve buttons only work while the bot is running.

## 1. Create the VM (~15 min, once)

1. Sign up at <https://cloud.oracle.com>. A card is required for identity
   verification; the Always Free resources are not charged.
2. **Compute → Instances → Create instance**
3. Image: **Canonical Ubuntu 24.04**
4. Shape: **Change shape → Ampere → VM.Standard.A1.Flex**, set
   **1 OCPU / 6 GB RAM**. This is inside the free allowance.
   - If you get *"Out of host capacity"*, try a different Availability Domain,
     or another region. It is a common Oracle annoyance, not a mistake on your
     side. Retrying later usually works.
5. Under **Add SSH keys**, choose *Generate a key pair* and download the
   private key.
6. Create, then copy the instance's **Public IP address**.

## 2. Connect

    chmod 600 ~/Downloads/ssh-key-*.key
    ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>

## 3. Install

    sudo apt update && sudo apt install -y python3-venv git
    git clone https://github.com/<you>/wg-finder.git
    cd wg-finder
    python3 -m venv venv
    ./venv/bin/pip install -r requirements.txt

## 4. Configure

`profile.yaml` is deliberately not in the repo, because it holds personal
details. Copy yours up from your laptop:

    # run this on your LAPTOP, not the server
    scp -i ~/Downloads/ssh-key-*.key \
        profile.yaml .env ubuntu@<PUBLIC_IP>:~/wg-finder/

Or start from the template and edit it on the server:

    cp profile.example.yaml profile.yaml
    cp .env.example .env
    nano profile.yaml
    nano .env

## 5. Run it as a service

So it survives reboots and restarts itself if it crashes:

    sudo cp wg-finder.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now wg-finder

Check it:

    systemctl status wg-finder
    journalctl -u wg-finder -f        # live logs, Ctrl-C to stop watching

Send `/start` in Telegram. If it replies, you're done.

## Updating later

    cd ~/wg-finder
    git pull
    ./venv/bin/pip install -r requirements.txt
    sudo systemctl restart wg-finder

## Notes

- **No inbound ports needed.** The bot polls Telegram outbound, so you do not
  have to open the firewall or configure a security list.
- The timezone is set to Europe/Berlin in the service so log timestamps match
  the ads.
- `wgfinder.db` lives in the repo directory. Back it up if you care about the
  history of what you've already applied to; losing it just means the bot
  re-sends current listings once.
- A `Dockerfile` is included if you would rather run it containerised:

      docker build -t wg-finder .
      docker run -d --restart=always --env-file .env \
          -v $PWD/data:/app/data --name wg wg-finder

## Alternatives

- **Your own Mac**: zero setup, but it stops when the laptop sleeps. Fine if
  you mostly leave it on and awake.
- **Fly.io**: easiest Docker deploy, but the free allowance is small and now
  generally wants a card; expect a euro or two a month.
- **GitHub Actions on a cron** does *not* work here. It can scan, but the
  Approve buttons need a process that stays alive.
