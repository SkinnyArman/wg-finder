"""Live-editable filters.

profile.yaml holds the defaults (and all the explanatory comments). Anything
changed from Telegram is written to filters.local.json, which overrides the
YAML. That way editing filters from the bot never mangles the commented file.
"""
import json
import threading
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "profile.yaml"
OVERRIDES = ROOT / "filters.local.json"

_lock = threading.Lock()

# key -> (type, human label)
EDITABLE = {
    "max_rent":          (int,  "Max rent (EUR)"),
    "min_rent":          (int,  "Min rent (EUR)"),
    "skip_female_only":  (bool, "Skip women-only WGs"),
    "skip_pendler":      (bool, "Skip Pendler / weekly-commuter rooms"),
}

DEFAULTS = {"skip_female_only": True, "skip_pendler": True,
            "max_rent": 600, "min_rent": 0}


def _yaml_filters() -> dict:
    d = yaml.safe_load(PROFILE.read_text(encoding="utf-8")) or {}
    return (d.get("filters") or {}).copy()


def load() -> dict:
    f = DEFAULTS.copy()
    f.update(_yaml_filters())
    if OVERRIDES.exists():
        try:
            f.update(json.loads(OVERRIDES.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    return f


def set_value(key: str, raw) -> tuple[bool, str]:
    """Returns (ok, message). Only keys in EDITABLE can be changed."""
    if key not in EDITABLE:
        return False, f"'{key}' is not editable. Try: {', '.join(EDITABLE)}"
    typ, label = EDITABLE[key]
    try:
        if typ is bool:
            v = str(raw).strip().lower() in ("1", "true", "yes", "on", "an")
        else:
            v = int(str(raw).strip())
            if v < 0:
                return False, "Must be 0 or more."
    except (ValueError, TypeError):
        return False, f"'{raw}' is not a valid value for {label}."

    with _lock:
        cur = {}
        if OVERRIDES.exists():
            try:
                cur = json.loads(OVERRIDES.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                cur = {}
        cur[key] = v
        OVERRIDES.write_text(json.dumps(cur, indent=2), encoding="utf-8")
    return True, f"{label} is now {v}"


def toggle(key: str) -> tuple[bool, str]:
    cur = load().get(key, False)
    return set_value(key, not bool(cur))


def reset() -> None:
    with _lock:
        OVERRIDES.unlink(missing_ok=True)


def summary() -> str:
    f = load()
    on = lambda b: "on" if b else "off"          # noqa: E731
    lines = [
        f"Max rent:            {f.get('max_rent', 0)} EUR",
        f"Min rent:            {f.get('min_rent', 0)} EUR",
        f"Skip women-only:     {on(f.get('skip_female_only'))}",
        f"Skip Pendler rooms:  {on(f.get('skip_pendler'))}",
    ]
    words = f.get("skip_if_title_contains") or []
    if words:
        lines.append(f"\nTitle blocklist ({len(words)}):\n  " + ", ".join(words))
    return "\n".join(lines)
