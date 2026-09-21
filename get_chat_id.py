"""Print the ids you need for .env.

Run it after messaging your bot (in a DM and/or in the group).

  TELEGRAM_CHAT_ID   where ads get posted  (a group id is negative)
  TELEGRAM_OWNER_ID  who may command it    (always your personal user id)
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")
tok = os.getenv("TELEGRAM_BOT_TOKEN")
if not tok:
    sys.exit("Put TELEGRAM_BOT_TOKEN in .env first.")

with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/getUpdates") as r:
    data = json.load(r)

chats, users = {}, {}
for u in data.get("result", []):
    msg = u.get("message") or u.get("my_chat_member") or u.get("callback_query", {}).get("message")
    if not msg:
        continue
    c = msg.get("chat", {})
    if c.get("id") is not None:
        label = c.get("title") or c.get("first_name") or ""
        chats[c["id"]] = f"{c.get('type', '?')}  {label}"
    frm = (u.get("message") or {}).get("from") or u.get("from") or {}
    if frm.get("id"):
        users[frm["id"]] = f"@{frm.get('username')}" if frm.get("username") else frm.get("first_name", "")

if not chats and not users:
    sys.exit("No messages seen yet.\n"
             "Send your bot a message (and post one in the group), then rerun.\n"
             "In a group you may need to send /start@yourbotname.")

print("\n--- TELEGRAM_CHAT_ID  (where ads are posted) ---")
for cid, label in chats.items():
    kind = "GROUP" if cid < 0 else "direct"
    print(f"  {cid:<16} {kind:7} {label}")

print("\n--- TELEGRAM_OWNER_ID (who may command it — pick yourself) ---")
for uid, label in users.items():
    print(f"  {uid:<16} {label}")

print("\nPut both in .env. To post into the group, use the negative group id\n"
      "as TELEGRAM_CHAT_ID and your own user id as TELEGRAM_OWNER_ID.")
