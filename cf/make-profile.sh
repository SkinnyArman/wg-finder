#!/bin/bash
# Converts ../profile.yaml into the base64 blob the Worker expects.
cd "$(dirname "$0")"
../venv/bin/python -c "
import base64, json, yaml, pathlib
d = yaml.safe_load(pathlib.Path('../profile.yaml').read_text(encoding='utf-8'))
raw = json.dumps(d, ensure_ascii=False).encode('utf-8')
pathlib.Path('profile.b64').write_text(base64.b64encode(raw).decode())
print(f'profile.b64 written ({len(raw)} bytes JSON)')
"
echo "Now run:  npx wrangler secret put PROFILE_B64 < profile.b64"
