#!/bin/bash
# Turns ../profile.yaml into profile.sql, which seeds the profile into D1.
# (It is ~4.5KB of JSON — too big for a Worker secret's 5.1KB limit.)
set -e
cd "$(dirname "$0")"

../venv/bin/python -c "
import json, yaml, pathlib
d = yaml.safe_load(pathlib.Path('../profile.yaml').read_text(encoding='utf-8'))
raw = json.dumps(d, ensure_ascii=False, separators=(',', ':'))
esc = raw.replace(chr(39), chr(39)*2)          # SQL-escape single quotes
pathlib.Path('profile.sql').write_text(
    \"INSERT INTO kv (k,v) VALUES ('profile','\" + esc + \"')\n\"
    \"ON CONFLICT(k) DO UPDATE SET v=excluded.v;\n\", encoding='utf-8')
print(f'profile.sql written ({len(raw)} bytes of JSON)')
"

echo
echo "Now load it into D1:"
echo "  npx wrangler d1 execute wg-finder --remote --file=profile.sql"
