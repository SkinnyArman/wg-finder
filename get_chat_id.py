"""Run this once, after you've sent your bot a message, to get your chat id."""
import os, sys, json, urllib.request
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")
tok = os.getenv("TELEGRAM_BOT_TOKEN")
if not tok:
    sys.exit("Put TELEGRAM_BOT_TOKEN in .env first.")

with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/getUpdates") as r:
    data = json.load(r)

ids = {u["message"]["chat"]["id"]: u["message"]["chat"].get("first_name", "")
       for u in data.get("result", []) if "message" in u}
if not ids:
    sys.exit("No messages yet. Open Telegram, find your bot, send it 'hi', then rerun.")
for cid, name in ids.items():
    print(f"TELEGRAM_CHAT_ID={cid}   ({name})")
