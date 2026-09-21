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

# key -> (type, human label, min, max)
FILTER_KEYS = {
    "max_rent":          (int,  "Max rent (EUR)", 0, 5000),
    "min_rent":          (int,  "Min rent (EUR)", 0, 5000),
    "skip_female_only":  (bool, "Skip women-only WGs", None, None),
    "skip_pendler":      (bool, "Skip Pendler / weekly-commuter rooms", None, None),
}

BEHAVIOUR_KEYS = {
    "poll_minutes":      (int,  "Check every (minutes)", 5, 180),
    "max_per_hour":      (int,  "Max ads sent per hour", 1, 20),
    "block_backoff_min": (int,  "Pause after a captcha (minutes)", 10, 360),
}

EDITABLE = {**FILTER_KEYS, **BEHAVIOUR_KEYS}

DEFAULTS = {"skip_female_only": True, "skip_pendler": True,
            "max_rent": 600, "min_rent": 0,
            "poll_minutes": 15, "max_per_hour": 2, "block_backoff_min": 45,
            "paused_until": 0}   # 0 = running, -1 = paused indefinitely


def _yaml_defaults() -> dict:
    d = yaml.safe_load(PROFILE.read_text(encoding="utf-8")) or {}
    out = (d.get("filters") or {}).copy()
    out.update(d.get("behaviour") or {})
    return out


def load() -> dict:
    f = DEFAULTS.copy()
    f.update(_yaml_defaults())
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
    typ, label, lo, hi = EDITABLE[key]
    try:
        if typ is bool:
            v = str(raw).strip().lower() in ("1", "true", "yes", "on", "an")
        else:
            v = int(str(raw).strip())
            if lo is not None and v < lo:
                return False, f"{label}: minimum is {lo}."
            if hi is not None and v > hi:
                return False, f"{label}: maximum is {hi}."
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


def _write(key, value):
    with _lock:
        cur = {}
        if OVERRIDES.exists():
            try:
                cur = json.loads(OVERRIDES.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                cur = {}
        cur[key] = value
        OVERRIDES.write_text(json.dumps(cur, indent=2), encoding="utf-8")


def pause(seconds: int | None = None) -> str:
    """seconds=None pauses indefinitely. Returns a human description."""
    import time as _t
    if seconds is None:
        _write("paused_until", -1)
        return "Paused indefinitely"
    until = int(_t.time()) + seconds
    _write("paused_until", until)
    mins = round(seconds / 60)
    if mins >= 60:
        return f"Paused for {mins // 60}h {mins % 60:02d}m"
    return f"Paused for {mins} min"


def resume() -> None:
    _write("paused_until", 0)


def pause_state() -> tuple[bool, str]:
    """(is_paused, human description)."""
    import time as _t
    v = int(load().get("paused_until") or 0)
    if v == 0:
        return False, "running"
    if v < 0:
        return True, "paused indefinitely"
    left = v - int(_t.time())
    if left <= 0:
        resume()
        return False, "running"
    mins = left // 60 + 1
    if mins >= 60:
        return True, f"paused, {mins // 60}h {mins % 60:02d}m left"
    return True, f"paused, {mins} min left"


def behaviour_summary() -> str:
    f = load()
    _, state = pause_state()
    return "\n".join([
        f"Status:              {state}",
        f"Check every:         {f['poll_minutes']} min",
        f"Max ads per hour:    {f['max_per_hour']}",
        f"Pause on captcha:    {f['block_backoff_min']} min",
    ])


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
