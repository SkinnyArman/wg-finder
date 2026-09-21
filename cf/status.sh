#!/bin/bash
# Is the bot actually alive? Reads the bot token from ../.env
cd "$(dirname "$0")"
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' ../.env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ')
if [ -z "$TOKEN" ]; then
  echo "No TELEGRAM_BOT_TOKEN in ../.env — pass it as: $0 <token>"
  TOKEN="$1"
fi
[ -z "$TOKEN" ] && exit 1

echo "=== 1. Telegram webhook ==="
curl -s "https://api.telegram.org/bot$TOKEN/getWebhookInfo" \
 | python3 -c "
import json,sys
d=json.load(sys.stdin).get('result',{})
print('  url               :', d.get('url') or '(none — commands will not work)')
print('  pending updates   :', d.get('pending_update_count'))
print('  custom secret set :', d.get('has_custom_certificate') is not None and bool(d.get('url')))
err=d.get('last_error_message')
print('  last error        :', err or 'none')
if err: print('    ^ 403 here means WEBHOOK_SECRET does not match')
"

echo
echo "=== 2. Database ==="
npx wrangler d1 execute wg-finder --remote --json \
  --command "SELECT k, length(v) AS bytes FROM kv" 2>/dev/null \
 | python3 -c "
import json,sys
try:
    rows=json.load(sys.stdin)[0]['results']
except Exception:
    print('  could not read kv — is the schema created?'); sys.exit()
if not any(r['k']=='profile' for r in rows):
    print('  NO PROFILE ROW — run ./make-profile.sh then load profile.sql')
for r in rows: print(f\"  {r['k']:14} {r['bytes']} bytes\")
"

echo
echo "=== 3. Ads seen so far ==="
npx wrangler d1 execute wg-finder --remote --json \
  --command "SELECT status, COUNT(*) n FROM ads GROUP BY status" 2>/dev/null \
 | python3 -c "
import json,sys
try:
    rows=json.load(sys.stdin)[0]['results']
except Exception:
    print('  no ads table yet'); sys.exit()
if not rows:
    print('  none yet — the cron may not have run, or it is paused/blocked')
for r in rows: print(f\"  {r['status']:10} {r['n']}\")
"

echo
echo "=== 4. Live logs (Ctrl-C to stop) ==="
echo "  npx wrangler tail"
