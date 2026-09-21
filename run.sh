#!/bin/bash
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env — fill in your keys, then run ./run.sh again:"
  echo "   open -e .env"
  exit 1
fi

# preflight: tell the user what's missing instead of throwing a traceback
./venv/bin/python - <<'PY' || exit 1
import os, sys
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(".env"))
missing = []
for k, hint in [("OPENAI_API_KEY", "your OpenAI key"),
                ("TELEGRAM_BOT_TOKEN", "token from @BotFather"),
                ("TELEGRAM_CHAT_ID", "run: ./venv/bin/python get_chat_id.py")]:
    v = os.getenv(k, "")
    if not v or v.startswith(("sk-...", "123456")):
        missing.append(f"  {k:20} <- {hint}")
if missing:
    print("Still missing in .env:\n" + "\n".join(missing))
    sys.exit(1)
print(f"Config OK. Model: {os.getenv('OPENAI_MODEL','gpt-5.6-terra')}")
PY

exec ./venv/bin/python -m wgfinder.bot
