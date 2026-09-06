#!/usr/bin/env python3
from __future__ import annotations

"""
Manage multiple OpenAI Codex accounts by swapping auth.json.
"""

import json
import os
import sys
import shutil
import base64
import argparse
from pathlib import Path

CODEX_DIR = Path.home() / ".codex"
AUTH_FILE = CODEX_DIR / "auth.json"
ACCOUNTS_DIR = CODEX_DIR / "accounts"
OPENCLAW_AUTH_PROFILES_FILE = (
    Path.home() / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"
)
OPENCLAW_AGENTS_DIR = Path.home() / ".openclaw" / "agents"

def ensure_dirs():
    if not ACCOUNTS_DIR.exists():
        ACCOUNTS_DIR.mkdir(parents=True)

def decode_jwt_payload(token):
    try:
        # JWT is header.payload.signature
        parts = token.split('.')
        if len(parts) != 3:
            return {}
        
        payload = parts[1]
        # Add padding if needed
        payload += '=' * (-len(payload) % 4)
        
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return {}


def decode_jwt_segment(segment):
    try:
        segment += '=' * (-len(segment) % 4)
        decoded = base64.urlsafe_b64decode(segment)
        return json.loads(decoded)
    except Exception:
        return {}


def decode_jwt(token):
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return {}

        return {
            "header": decode_jwt_segment(parts[0]),
            "payload": decode_jwt_segment(parts[1]),
        }
    except Exception:
        return {}


def _normalize_str(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _get_tokens(data: dict) -> dict:
    tokens = data.get("tokens", {}) if isinstance(data, dict) else {}
    return tokens if isinstance(tokens, dict) else {}


def _read_access_token_auth_claims(data: dict) -> dict:
    access_token = _get_tokens(data).get("access_token")
    if not isinstance(access_token, str) or access_token.count(".") != 2:
        return {}

    payload = decode_jwt_payload(access_token)
    auth = payload.get("https://api.openai.com/auth")
    return auth if isinstance(auth, dict) else {}


def _read_access_token_profile_claims(data: dict) -> dict:
    access_token = _get_tokens(data).get("access_token")
    if not isinstance(access_token, str) or access_token.count(".") != 2:
        return {}

    payload = decode_jwt_payload(access_token)
    profile = payload.get("https://api.openai.com/profile")
    return profile if isinstance(profile, dict) else {}


def _read_codex_account_id(data: dict) -> str | None:
    auth = _read_access_token_auth_claims(data)
    account_id = _normalize_str(auth.get("chatgpt_account_id"))
    if account_id:
        return account_id
    return _normalize_str(data.get("account_id"))


def _read_codex_user_id(data: dict) -> str | None:
    auth = _read_access_token_auth_claims(data)
    return (
        _normalize_str(auth.get("user_id"))
        or _normalize_str(auth.get("chatgpt_user_id"))
        or _normalize_str(auth.get("chatgpt_account_user_id"))
    )


def _is_known_email(email: str | None) -> bool:
    value = _normalize_str(email)
    return bool(value and value not in ("unknown", "error"))


def _suggested_account_name(email: str | None, user_id: str | None) -> str:
    if isinstance(email, str) and "@" in email:
        suggested = email.split("@", 1)[0].strip()
        if suggested:
            return suggested
    if isinstance(user_id, str) and user_id.strip():
        return user_id.strip()
    return "account"


def _describe_identity(info: dict | None) -> str:
    info = info or {}
    user_id = _normalize_str(info.get("user_id"))
    email = _normalize_str(info.get("email"))
    account_id = _normalize_str(info.get("account_id"))

    if account_id:
        short_account = account_id[:12]
        if user_id and _is_known_email(email):
            return f"{user_id} / acct {short_account} ({email})"
        if _is_known_email(email):
            return f"acct {short_account} ({email})"
        if user_id:
            return f"{user_id} / acct {short_account}"
        return f"account_id {account_id}"
    if user_id and _is_known_email(email):
        return f"{user_id} ({email})"
    if user_id:
        return user_id
    if _is_known_email(email):
        return email
    return "unknown"

def _read_token_exp_seconds(data: dict) -> int | None:
    """Try to extract an expiry timestamp (unix seconds) from known JWT fields.

    Note: access/id tokens are intentionally short-lived (minutes/hours).
    """
    try:
        tokens = data.get('tokens', {}) if isinstance(data, dict) else {}
        if not isinstance(tokens, dict):
            return None

        # Prefer id_token (has email claim), fall back to access_token.
        for key in ("id_token", "access_token"):
            tok = tokens.get(key)
            if isinstance(tok, str) and tok.count('.') == 2:
                payload = decode_jwt_payload(tok)
                exp = payload.get('exp')
                if isinstance(exp, (int, float)) and exp > 0:
                    return int(exp)
        return None
    except Exception:
        return None


def get_account_info(auth_path):
    """Return token-derived identity and diagnostics from an auth.json file."""
    if not auth_path.exists():
        return None

    try:
        with open(auth_path, 'r') as f:
            data = json.load(f)

        exp = _read_token_exp_seconds(data)
        last_refresh = data.get('last_refresh') if isinstance(data, dict) else None
        account_id = _read_codex_account_id(data)
        user_id = _read_codex_user_id(data)

        # Prefer id_token for human-readable identity, then fall back to access token profile claims.
        tokens = _get_tokens(data)
        id_token = tokens.get('id_token')
        email = 'unknown'
        name = None

        if isinstance(id_token, str) and id_token.count('.') == 2:
            payload = decode_jwt_payload(id_token)
            email = payload.get('email', email)
            name = payload.get('name')
        else:
            profile = _read_access_token_profile_claims(data)
            email = profile.get('email', email)

        return {
            'email': email,
            'name': name,
            'account_id': account_id,
            'user_id': user_id,
            'exp': exp,
            'last_refresh': last_refresh,
            'raw': data
        }
    except Exception as e:
        return {'email': 'error', 'error': str(e)}

def _read_json_file(path: Path) -> dict | None:
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _auth_material(data: dict | None) -> dict | None:
    if not isinstance(data, dict):
        return None
    material = dict(data)
    material.pop("decoded_tokens", None)
    return material


def _same_auth_material(left_path: Path, right_path: Path) -> bool:
    left = _auth_material(_read_json_file(left_path))
    right = _auth_material(_read_json_file(right_path))
    return left is not None and right is not None and left == right


def _same_token_identity(left_path: Path, right_path: Path) -> bool:
    left = get_account_info(left_path) or {}
    right = get_account_info(right_path) or {}

    left_account = _normalize_str(left.get("account_id"))
    right_account = _normalize_str(right.get("account_id"))
    left_user = _normalize_str(left.get("user_id"))
    right_user = _normalize_str(right.get("user_id"))
    if left_user and right_user and left_account and right_account:
        return left_user == right_user and left_account == right_account

    if left_user and right_user:
        return left_user == right_user

    if left_account and right_account:
        return left_account == right_account

    left_email = _normalize_str(left.get("email"))
    right_email = _normalize_str(right.get("email"))
    if _is_known_email(left_email) and _is_known_email(right_email):
        return left_email.lower() == right_email.lower()

    return _same_auth_material(left_path, right_path)


def is_current(stored_path):
    """Check if the stored file represents the current auth.json identity."""
    if not AUTH_FILE.exists() or not stored_path.exists():
        return False

    return _same_token_identity(AUTH_FILE, stored_path)


# --- Account Activity Logging ---
# Tracks which account (user_id) is active at what time, enabling
# accurate attribution of sessions to accounts.

ACTIVITY_LOG = CODEX_DIR / "account-activity.jsonl"


def get_user_id_from_auth(auth_path=None):
    """Extract user_id from an auth.json file's JWT token."""
    if auth_path is None:
        auth_path = AUTH_FILE
    if not auth_path.exists():
        return None
    
    try:
        with open(auth_path, 'r') as f:
            data = json.load(f)

        return _read_codex_user_id(data)
    except Exception:
        return None


def log_account_switch(account_name, user_id=None):
    """Log an account switch to the activity log.
    
    This enables matching sessions to accounts by timestamp.
    """
    import time
    
    if user_id is None:
        user_id = get_user_id_from_auth()
    
    if not user_id:
        return  # Can't log without user_id
    
    entry = {
        "timestamp": int(time.time()),
        "account": account_name,
        "user_id": user_id
    }
    
    try:
        with open(ACTIVITY_LOG, 'a') as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Non-critical, don't fail the switch


def get_account_for_timestamp(ts):
    """Look up which account was active at a given timestamp.
    
    Returns (account_name, user_id) or (None, None) if unknown.
    """
    if not ACTIVITY_LOG.exists():
        return None, None
    
    try:
        entries = []
        with open(ACTIVITY_LOG, 'r') as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
        
        # Sort by timestamp descending
        entries.sort(key=lambda e: e.get('timestamp', 0), reverse=True)
        
        # Find the first entry with timestamp <= ts
        for entry in entries:
            if entry.get('timestamp', 0) <= ts:
                return entry.get('account'), entry.get('user_id')
        
        # If ts is before all entries, use the earliest entry
        if entries:
            earliest = min(entries, key=lambda e: e.get('timestamp', float('inf')))
            return earliest.get('account'), earliest.get('user_id')
        
        return None, None
    except Exception:
        return None, None

def resolve_active_profile():
    """Return (name, email) for the currently active auth.json if it matches a saved profile."""
    if not AUTH_FILE.exists():
        return None

    for f in _iter_account_snapshot_files():
        if is_current(f):
            info = get_account_info(f) or {}
            return f.stem, info.get("email", "unknown")

    # Active but not saved
    info = get_account_info(AUTH_FILE) or {}
    return None, info.get("email", "unknown")


def _format_expiry(exp_seconds: int | None) -> str:
    """Format access/id token expiry (short-lived). Mostly useful for debugging."""
    if not exp_seconds:
        return ""
    try:
        import time
        now = int(time.time())
        delta = exp_seconds - now
        if delta <= 0:
            return "(token expired)"
        if delta < 60:
            return "(token <1m)"
        mins = delta // 60
        if mins < 120:
            return f"(token {mins}m)"
        hours = mins // 60
        rem_m = mins % 60
        if hours < 48:
            return f"(token {hours}h{rem_m:02d}m)"
        days = hours // 24
        return f"(token {days}d)"
    except Exception:
        return ""


def _format_refreshed(last_refresh: str | None, fallback_path: Path | None = None) -> str:
    """More useful than token exp: when this snapshot was last refreshed."""
    try:
        from datetime import datetime, timezone

        ts: datetime | None = None
        if isinstance(last_refresh, str) and last_refresh.strip():
            raw = last_refresh.strip()
            # Python doesn't like trailing Z with fromisoformat.
            if raw.endswith('Z'):
                raw = raw[:-1] + '+00:00'
            ts = datetime.fromisoformat(raw)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        elif fallback_path is not None and fallback_path.exists():
            ts = datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)

        if not ts:
            return "refreshed ?"

        now = datetime.now(timezone.utc)
        delta = now - ts
        seconds = int(delta.total_seconds())
        if seconds < 60:
            return "refreshed just now"
        mins = seconds // 60
        if mins < 120:
            return f"refreshed {mins}m ago"
        hours = mins // 60
        rem_m = mins % 60
        if hours < 48:
            return f"refreshed {hours}h{rem_m:02d}m ago"
        days = hours // 24
        return f"refreshed {days}d ago"
    except Exception:
        return "refreshed ?"


def _parse_refresh_dt(last_refresh: str | None, fallback_path: Path | None = None):
    try:
        from datetime import datetime, timezone

        ts: datetime | None = None
        if isinstance(last_refresh, str) and last_refresh.strip():
            raw = last_refresh.strip()
            if raw.endswith('Z'):
                raw = raw[:-1] + '+00:00'
            ts = datetime.fromisoformat(raw)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        elif fallback_path is not None and fallback_path.exists():
            ts = datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)
        return ts
    except Exception:
        return None


def cmd_list(verbose: bool = False, json_mode: bool = False):
    ensure_dirs()

    accounts = []
    max_name = 0

    for f in _iter_account_snapshot_files():
        name = f.stem
        max_name = max(max_name, len(name))
        active = is_current(f)
        info = get_account_info(f) or {}
        last_refresh = info.get('last_refresh')
        exp = info.get('exp')
        accounts.append((name, active, last_refresh, exp, f))

    if not accounts:
        if json_mode:
            print(json.dumps({"accounts": [], "active": None}, indent=2))
        else:
            print("(no accounts saved)")
        return

    if json_mode:
        from datetime import datetime, timezone
        import time

        now = datetime.now(timezone.utc)
        now_epoch = int(time.time())
        payload_accounts = []
        active_name = None

        for name, active, last_refresh, exp, path in accounts:
            if active:
                active_name = name
            ts = _parse_refresh_dt(last_refresh, fallback_path=path)
            age_s = int((now - ts).total_seconds()) if ts else None
            ttl_s = int(exp - now_epoch) if isinstance(exp, int) else None
            token_exp_iso = (
                datetime.fromtimestamp(exp, tz=timezone.utc).isoformat().replace('+00:00', 'Z')
                if isinstance(exp, int)
                else None
            )
            payload_accounts.append(
                {
                    "name": name,
                    "active": bool(active),
                    "last_refresh": last_refresh if isinstance(last_refresh, str) else None,
                    "refreshed_age_seconds": age_s,
                    "token_exp": token_exp_iso,
                    "token_ttl_seconds": ttl_s,
                }
            )

        print(
            json.dumps(
                {
                    "generated_at": now.isoformat(),
                    "active": active_name,
                    "accounts": payload_accounts,
                },
                indent=2,
            )
        )
        return

    lines = []
    for name, active, last_refresh, exp, path in accounts:
        display = f"**{name}**" if name else name

        if verbose:
            left = f"- {display.ljust(max_name + 4)}  {_format_refreshed(last_refresh, fallback_path=path)}"
            extra = _format_expiry(exp)
            if extra:
                left += f"  {extra}"
        else:
            left = f"- {display.ljust(max_name + 4)}"

        if active:
            left += "  ✅"
        lines.append(left)

    header = "Codex Accounts"
    underline = "—" * len(header)
    print(header + "\n" + underline + "\n" + "\n".join(lines))

def _resolve_matching_account_by_email(email: str) -> Path | None:
    """Find the preferred saved account for an email."""
    want = (email or "").strip().lower()
    if not want:
        return None

    matches: list[Path] = []
    for f in _iter_account_snapshot_files():
        info = get_account_info(f) or {}
        got = (info.get("email") or "").strip().lower()
        if got and got == want:
            matches.append(f)

    return _preferred_identity_snapshot(matches)


def _resolve_matching_account_by_user_id(user_id: str) -> Path | None:
    """Find the preferred saved account for a user_id."""
    want = _normalize_str(user_id)
    if not want:
        return None

    matches: list[Path] = []
    for f in _iter_account_snapshot_files():
        info = get_account_info(f) or {}
        got = _normalize_str(info.get("user_id"))
        if got and got == want:
            matches.append(f)

    return _preferred_identity_snapshot(matches)


def _resolve_matching_account_by_account_id(account_id: str) -> Path | None:
    """Find the preferred saved account file for an accountId."""
    want = _normalize_str(account_id)
    if not want:
        return None

    matches: list[Path] = []
    for f in _iter_account_snapshot_files():
        info = get_account_info(f) or {}
        got = _normalize_str(info.get("account_id"))
        if got and got == want:
            matches.append(f)

    return _preferred_identity_snapshot(matches)


def _preferred_identity_snapshot(matches: list[Path]) -> Path | None:
    """Choose a stable canonical snapshot when historical duplicates exist."""
    import re

    if not matches:
        return None
    return min(
        matches,
        key=lambda path: (
            bool(re.search(r"-\d+$", path.stem)),
            len(path.stem),
            path.stem,
        ),
    )


def _resolve_matching_account(account_id: str | None, user_id: str | None, email: str | None) -> Path | None:
    """Find the best matching saved account using token-derived identity first."""
    normalized_account_id = _normalize_str(account_id)
    normalized_user_id = _normalize_str(user_id)
    normalized_email = _normalize_str(email)

    if normalized_user_id and normalized_account_id:
        matches: list[Path] = []
        for f in _iter_account_snapshot_files():
            info = get_account_info(f) or {}
            got_user_id = _normalize_str(info.get("user_id"))
            got_account_id = _normalize_str(info.get("account_id"))
            if got_user_id == normalized_user_id and got_account_id == normalized_account_id:
                matches.append(f)
        match = _preferred_identity_snapshot(matches)
        if match is not None:
            return match

    match = _resolve_matching_account_by_user_id(normalized_user_id or "")
    if match is not None:
        return match

    if not normalized_user_id:
        match = _resolve_matching_account_by_account_id(normalized_account_id or "")
        if match is not None:
            return match

    if not normalized_user_id and not normalized_account_id:
        return _resolve_matching_account_by_email(normalized_email or "")

    return None


def _resolve_unique_name_path(base_name: str) -> tuple[str, Path]:
    base = (base_name or "account").strip() or "account"
    target = ACCOUNTS_DIR / f"{base}.json"
    if not target.exists():
        return base, target

    suffix = 2
    while True:
        candidate_name = f"{base}-{suffix}"
        candidate = ACCOUNTS_DIR / f"{candidate_name}.json"
        if not candidate.exists():
            return candidate_name, candidate
        suffix += 1


def _iter_account_snapshot_files():
    for path in sorted(ACCOUNTS_DIR.glob("*.json")):
        if path.name.startswith('.'):
            continue
        if path.name == "registry.json" or path.name.endswith(".auth.json"):
            continue
        if path.name.endswith(".debug.json"):
            continue
        yield path


def _account_snapshot_identity(path: Path) -> tuple[str, str, str] | None:
    info = get_account_info(path) or {}
    user_id = _normalize_str(info.get("user_id")) or ""
    account_id = _normalize_str(info.get("account_id")) or ""
    email = _normalize_str(info.get("email")) or ""
    if user_id or account_id:
        return user_id, account_id, ""
    if _is_known_email(email):
        return "", "", email.lower()
    return None


def _account_snapshot_freshness(path: Path) -> float:
    info = get_account_info(path) or {}
    refreshed = _parse_refresh_dt(info.get("last_refresh"), fallback_path=path)
    if refreshed is not None:
        return refreshed.timestamp()
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def cmd_dedupe(json_mode: bool = False, apply: bool = False) -> None:
    """Collapse duplicate snapshots while preserving one canonical file per token identity."""
    groups: dict[tuple[str, str, str], list[Path]] = {}
    unidentifiable: list[Path] = []
    for path in _iter_account_snapshot_files():
        identity = _account_snapshot_identity(path)
        if identity is None:
            unidentifiable.append(path)
            continue
        groups.setdefault(identity, []).append(path)

    duplicate_groups = [paths for paths in groups.values() if len(paths) > 1]
    duplicate_files = sum(len(paths) - 1 for paths in duplicate_groups)
    removed = 0
    retained: list[str] = []

    if apply:
        for paths in duplicate_groups:
            canonical = _preferred_identity_snapshot(paths)
            if canonical is None:
                continue
            freshest = max(paths, key=_account_snapshot_freshness)
            if freshest != canonical:
                success, _ = safe_save_token(freshest, canonical, force=False)
                if not success:
                    continue
            retained.append(canonical.stem)
            for path in paths:
                if path == canonical:
                    continue
                try:
                    path.unlink()
                    quota_cache = ACCOUNTS_DIR / f".{path.stem}.quota.json"
                    quota_cache.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    continue
        sync_saved_openclaw_profiles()

    payload = {
        "apply": apply,
        "identity_count": len(groups),
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_file_count": duplicate_files,
        "removed_file_count": removed,
        "retained_accounts": sorted(retained),
        "unidentifiable_file_count": len(unidentifiable),
    }
    if json_mode:
        print(json.dumps(payload, indent=2))
    elif apply:
        print(f"✅ Removed {removed} duplicate snapshot(s); retained {len(groups)} account identity file(s).")
    else:
        print(f"Would remove {duplicate_files} duplicate snapshot(s) across {len(duplicate_groups)} identity group(s).")


def cmd_add(
    name_override: str | None = None,
    use_device_auth: bool = False,
    count: int | None = None,
):
    """Add accounts by ALWAYS running a fresh login flow.

    Behavior:
    - Always triggers a new login.
    - After login, detects token identity from ~/.codex/auth.json.
    - If we already have a saved account with that SAME token identity: update that file.
    - Otherwise: save a new file named from the email local-part, or userId when email is unavailable.

    Interactive (TTY): can repeat.
    Non-interactive (Clawdbot): single-shot.
    """
    ensure_dirs()

    interactive = bool(sys.stdin.isatty() and sys.stdout.isatty())
    target_count = count if count and count > 0 else None
    completed = 0

    while True:
        if use_device_auth:
            login_success = do_device_login()
        else:
            login_success = do_browser_login()

        if not login_success:
            if not interactive:
                return
            retry = input("Retry login? [Y/n] ").strip().lower()
            if retry == 'n':
                return
            continue

        if not AUTH_FILE.exists():
            print("❌ Login did not produce ~/.codex/auth.json.")
            if not interactive:
                return
            retry = input("Retry login? [Y/n] ").strip().lower()
            if retry == 'n':
                return
            continue

        info = get_account_info(AUTH_FILE) or {}
        email = info.get('email', 'unknown')
        account_id = info.get("account_id")
        user_id = info.get("user_id")
        identity_label = _describe_identity(info)
        current_email = (email or '').strip().lower() if isinstance(email, str) else ''
        print(f"Found active session for: {identity_label}")

        suggested = _suggested_account_name(email, user_id)

        # 1) If we already have this identity stored under ANY name, update that file.
        match = _resolve_matching_account(account_id, user_id, current_email)
        if match is not None:
            # Only overwrite if different.
            if _same_auth_material(AUTH_FILE, match):
                print(f"ℹ️  '{match.stem}' already up to date for {identity_label}")
            else:
                print(f"ℹ️  Updating existing account '{match.stem}' ({identity_label})")
                success, message = safe_save_token(AUTH_FILE, match, force=False)
                if not success:
                    print(f"ℹ️  Existing snapshot '{match.stem}' belongs to a different identity: {message}")
                    match = None
            if match is not None:
                print(f"✅ Saved '{match.stem}' ({identity_label})")
                sync_to_openclaw(match.stem, match)
        if match is None:
            # No exact identity match: create a new snapshot with default (or override) name.
            base_name = (name_override or suggested).strip() or suggested
            name, target = _resolve_unique_name_path(base_name)
            success, message = safe_save_token(AUTH_FILE, target, force=False)
            if not success:
                print(f"❌ {message}")
                if not interactive:
                    return
                retry = input("Retry login? [Y/n] ").strip().lower()
                if retry == 'n':
                    return
                continue
            print(f"✅ Saved '{name}' ({identity_label})")
            sync_to_openclaw(name, target)

        completed += 1
        if target_count is not None:
            if completed >= target_count:
                return
            continue

        if not interactive:
            return

        more = input("\nAdd another account? [y/N] ").strip().lower()
        if more != 'y':
            return

def do_browser_login():
    import subprocess
    import time

    print("\n🚀 Starting browser login (codex logout && codex login)...")

    before_mtime = AUTH_FILE.stat().st_mtime if AUTH_FILE.exists() else 0

    subprocess.run(["codex", "logout"], capture_output=True)

    # This typically opens the system browser and completes via localhost callback.
    # Prevent auto-opening the default browser. This avoids instantly re-logging
    # into whatever account is already signed into your primary browser profile.
    # You'll open the printed URL in the browser/profile you want.
    env = dict(os.environ)
    env["BROWSER"] = "/usr/bin/false"

    process = subprocess.Popen(
        ["codex", "login"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )

    # Stream output (so you can see errors) and watch auth.json for changes.
    start = time.time()
    timeout_s = 15 * 60
    
    while True:
        # Non-blocking-ish read: poll process and attempt readline
        if process.stdout:
            line = process.stdout.readline()
            if line:
                print(line.rstrip())
                # Common device-auth policy message; helpful to surface
                if "device code" in line.lower() and "admin" in line.lower():
                    pass

        if AUTH_FILE.exists():
            mtime = AUTH_FILE.stat().st_mtime
            if mtime > before_mtime:
                # auth.json updated; likely success
                break

        if process.poll() is not None:
            # Process ended; if auth didn't change, it's likely failure
            break

        if time.time() - start > timeout_s:
            process.kill()
            print("\n❌ Login timed out after 15 minutes.")
            return False

        time.sleep(0.2)

    process.wait(timeout=5)

    if AUTH_FILE.exists() and AUTH_FILE.stat().st_mtime > before_mtime:
        print("\n✅ Login successful (auth.json updated).")
        return True
    else:
        print("\n❌ Login did not update auth.json (may have failed).")
        return False


def do_device_login():
    import subprocess
    import re
    import time
    
    print("\n🚀 Starting device login (codex logout && codex login --device-auth)...")

    before_mtime = AUTH_FILE.stat().st_mtime if AUTH_FILE.exists() else 0
    
    # 1. Logout first to be safe
    subprocess.run(["codex", "logout"], capture_output=True)
    
    # 2. Start login process
    process = subprocess.Popen(
        ["codex", "login", "--device-auth"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )
    
    url = None
    code = None
    
    print("Waiting for code...")
    
    start = time.time()
    timeout_s = 15 * 60

    # Read output line by line to find URL and code
    while True:
        line = process.stdout.readline()
        if not line and process.poll() is not None:
            break
        if not line:
            if AUTH_FILE.exists() and AUTH_FILE.stat().st_mtime > before_mtime:
                break
            if time.time() - start > timeout_s:
                process.kill()
                print("\n❌ Login timed out after 15 minutes.")
                return False
            continue
            
        clean_line = re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip())
        if clean_line:
            print(clean_line)
        
        # Capture URL
        if "https://auth.openai.com" in clean_line:
            url = clean_line.strip()
        
        # Capture Code (usually 8 chars like ABCD-1234)
        # Regex for code: 4 chars - 5 chars (actually usually 4-4 or 4-5)
        # The output says: "Enter this one-time code"
        # Then the next non-empty line has the code.
        if "Enter this one-time code" in clean_line:
            # The next line should be the code
            while True:
                code_line = process.stdout.readline()
                if not code_line and process.poll() is not None:
                    break
                if not code_line:
                    continue
                code = re.sub(r'\x1b\[[0-9;]*m', '', code_line).strip()
                if code:
                    print(code)
                    break
            
            if url and code:
                print("\n" + "="*50)
                print(f"👉 OPEN THIS: {url}")
                print(f"🔑 ENTER CODE: {code}")
                print("="*50 + "\n")
                print("Waiting for you to complete login in browser...")

        if AUTH_FILE.exists() and AUTH_FILE.stat().st_mtime > before_mtime:
            break

        if time.time() - start > timeout_s:
            process.kill()
            print("\n❌ Login timed out after 15 minutes.")
            return False
    
    # Wait for process to finish (it exits after successful login)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    
    if AUTH_FILE.exists() and AUTH_FILE.stat().st_mtime > before_mtime:
        print("\n✅ Login successful!")
        return True
    else:
        print("\n❌ Login failed or timed out.")
        return False

def _get_quota_cache_file(name):
    """Get path to quota cache file for an account."""
    return ACCOUNTS_DIR / f".{name}.quota.json"

def _save_quota_cache(name, limits):
    """Save quota to cache file."""
    import time
    cache_file = _get_quota_cache_file(name)
    try:
        with open(cache_file, 'w') as f:
            json.dump({
                'rate_limits': limits,
                'cached_at': time.time()
            }, f)
    except:
        pass

def _load_quota_cache(name, max_age_hours=24):
    """Load quota from cache if fresh enough.

    Supports both legacy formats:
    - { rate_limits: ..., cached_at: <epoch> }
    - { rate_limits: ..., collected_at: <epoch> }

    If neither timestamp exists, we fall back to the file mtime.
    """
    import time
    cache_file = _get_quota_cache_file(name)
    if not cache_file.exists():
        return None
    try:
        with open(cache_file, 'r') as f:
            data = json.load(f)

        cached_at = data.get('cached_at') or data.get('collected_at')
        if not isinstance(cached_at, (int, float)):
            cached_at = cache_file.stat().st_mtime

        if time.time() - float(cached_at) < max_age_hours * 3600:
            return data.get('rate_limits')
    except Exception:
        pass
    return None


def _parse_usage_limit_reset(stderr_text: str) -> dict | None:
    """Parse Codex usage-limit stderr into a synthetic rate-limit payload."""
    import re
    from datetime import datetime, timedelta

    if not isinstance(stderr_text, str) or "You've hit your usage limit" not in stderr_text:
        return None

    match = re.search(r"try again at\s+(.+?)\.", stderr_text)
    if not match:
        return None

    raw_reset = match.group(1).strip()
    cleaned_reset = re.sub(r"(\d{1,2})(st|nd|rd|th)", r"\1", raw_reset)
    now = datetime.now()

    resets_at = 0
    bucket = "primary"

    for fmt, parsed_bucket in (
        ("%b %d, %Y %I:%M %p", "secondary"),
        ("%B %d, %Y %I:%M %p", "secondary"),
        ("%I:%M %p", "primary"),
    ):
        try:
            parsed = datetime.strptime(cleaned_reset, fmt)
            if fmt == "%I:%M %p":
                parsed = now.replace(hour=parsed.hour, minute=parsed.minute, second=0, microsecond=0)
                if parsed <= now:
                    parsed = parsed + timedelta(days=1)
            resets_at = int(parsed.timestamp())
            bucket = parsed_bucket
            break
        except ValueError:
            continue

    if resets_at <= 0:
        return None

    payload = {
        "_limit_error": raw_reset,
        "_limit_bucket": bucket,
    }
    if bucket == "secondary":
        payload["secondary"] = {"used_percent": 100, "resets_at": resets_at}
        payload["primary"] = {"used_percent": 0, "resets_at": 0}
    else:
        payload["secondary"] = {"used_percent": 0, "resets_at": 0}
        payload["primary"] = {"used_percent": 100, "resets_at": resets_at}
    return payload

def _get_quota_for_account(name):
    """Get quota info for an account by switching to it and pinging Codex."""
    import subprocess
    import time
    import re
    from datetime import datetime
    
    source = ACCOUNTS_DIR / f"{name}.json"
    if not source.exists():
        return None
    
    # Switch to account
    shutil.copy(source, AUTH_FILE)
    user_id = get_user_id_from_auth(source)
    log_account_switch(name, user_id)
    
    # Ping codex to get a fresh session (for rate limit info)
    session_id = None
    try:
        result = subprocess.run(
            [
                "codex",
                "exec",
                "--skip-git-repo-check",
                f'Quota-Probe for\n\n```json\n{{"user_id": "{user_id or ""}"}}\n```\n\nOnly reply `OK`',
            ],
            cwd=str(CODEX_DIR),
            capture_output=True,
            text=True,
            timeout=60,
        )
        match = re.search(r'session id:\s+([a-f0-9\-]+)', result.stderr)
        if match:
            session_id = match.group(1)

        limit_error = _parse_usage_limit_reset(result.stderr)
        if limit_error:
            _save_quota_cache(name, limit_error)
            return limit_error
    except Exception:
        pass
    
    time.sleep(1)
    
    if session_id:
        sessions_dir = CODEX_DIR / "sessions"
        now = datetime.now()
        
        for day_offset in range(2):
            date = datetime.fromordinal(now.toordinal() - day_offset)
            day_dir = sessions_dir / f"{date.year:04d}" / f"{date.month:02d}" / f"{date.day:02d}"
            
            if not day_dir.exists():
                continue
                
            for session_file in day_dir.glob(f"*{session_id}.jsonl"):
                with open(session_file, 'r') as f:
                    lines = f.readlines()
                
                for line in reversed(lines):
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                        if (event.get('payload', {}).get('type') == 'token_count' and
                            event.get('payload', {}).get('rate_limits')):
                            limits = event['payload']['rate_limits']
                            _save_quota_cache(name, limits)
                            return limits
                    except json.JSONDecodeError:
                        continue
    
    # No fresh rate_limits - try cached data
    cached = _load_quota_cache(name)
    if cached:
        return cached
    
    return None


def _normalize_rate_limit_bucket(bucket) -> dict | None:
    return bucket if isinstance(bucket, dict) else None


def _quota_summary(limits: dict) -> dict | None:
    if not isinstance(limits, dict):
        return None

    primary = _normalize_rate_limit_bucket(limits.get("primary"))
    secondary = _normalize_rate_limit_bucket(limits.get("secondary"))

    quota_bucket = secondary or primary
    if quota_bucket is None:
        return None

    used_percent = quota_bucket.get("used_percent")
    resets_at = quota_bucket.get("resets_at", 0)
    daily_used = primary.get("used_percent") if primary else None

    if not isinstance(used_percent, (int, float)):
        return None
    if daily_used is not None and not isinstance(daily_used, (int, float)):
        daily_used = None
    if not isinstance(resets_at, (int, float)):
        resets_at = 0

    daily_resets_at = primary.get("resets_at", 0) if primary else 0
    if not isinstance(daily_resets_at, (int, float)):
        daily_resets_at = 0

    return {
        "used_percent": float(used_percent),
        "daily_used": float(daily_used) if daily_used is not None else None,
        "daily_resets_at": int(daily_resets_at),
        "resets_at": int(resets_at),
        "source": "secondary" if secondary else "primary",
    }


def cmd_sync():
    """Sync all saved Codex snapshots into OpenClaw auth profiles."""
    ensure_dirs()
    sync_saved_openclaw_profiles()
    print("✅ Synced saved accounts to OpenClaw auth-profiles.json")


def cmd_compare(name_a: str, name_b: str, json_mode: bool = False):
    path_a = ACCOUNTS_DIR / f"{name_a}.json"
    path_b = ACCOUNTS_DIR / f"{name_b}.json"

    if not path_a.exists():
        print(f"❌ Account snapshot not found for '{name_a}': {path_a}")
        return
    if not path_b.exists():
        print(f"❌ Account snapshot not found for '{name_b}': {path_b}")
        return

    with open(path_a, "r") as f:
        a = json.load(f)
    with open(path_b, "r") as f:
        b = json.load(f)

    decoded_a = a.get("decoded_tokens") or _build_decoded_token_fields(a)
    decoded_b = b.get("decoded_tokens") or _build_decoded_token_fields(b)

    flat_a = _flatten_json(decoded_a)
    flat_b = _flatten_json(decoded_b)
    all_keys = sorted(set(flat_a) | set(flat_b))

    diffs = []
    for key in all_keys:
        val_a = flat_a.get(key)
        val_b = flat_b.get(key)
        if val_a != val_b:
            diffs.append({
                "field": key,
                name_a: val_a,
                name_b: val_b,
            })

    result = {
        "left": name_a,
        "right": name_b,
        "left_file": str(path_a),
        "right_file": str(path_b),
        "diff_count": len(diffs),
        "diffs": diffs,
    }

    if json_mode:
        print(json.dumps(result, indent=2))
        return

    print(f"Comparing {name_a} vs {name_b}")
    print(f"Left:  {path_a}")
    print(f"Right: {path_b}")
    print(f"Differences: {len(diffs)}")
    if not diffs:
        return

    for diff in diffs:
        print(f"\n{diff['field']}")
        print(f"  {name_a}: {json.dumps(diff[name_a], ensure_ascii=False)}")
        print(f"  {name_b}: {json.dumps(diff[name_b], ensure_ascii=False)}")

def _parse_excluded_accounts(values) -> set[str]:
    excluded: set[str] = set()
    for value in values or []:
        if not isinstance(value, str):
            continue
        for part in value.split(","):
            name = part.strip()
            if name:
                excluded.add(name)
    return excluded


def _is_hard_blocked_quota(data: dict) -> bool:
    weekly = data.get('effective_weekly_used', data.get('weekly_used'))
    daily = data.get('effective_daily_used', data.get('daily_used'))
    return (
        isinstance(weekly, (int, float)) and weekly >= 100
    ) or (
        isinstance(daily, (int, float)) and daily >= 100
    )


def cmd_auto(json_mode=False, exclude_accounts=None):
    """Switch to the account with the most quota available."""
    import time
    ensure_dirs()
    excluded = _parse_excluded_accounts(exclude_accounts)
    
    accounts = [f.stem for f in _iter_account_snapshot_files()]
    if not accounts:
        if json_mode:
            print('{"error": "No accounts found"}')
        else:
            print("❌ No accounts found")
        return
    
    # Save current account to restore if needed
    original_account = None
    if AUTH_FILE.exists():
        for acct_file in _iter_account_snapshot_files():
            if acct_file.read_bytes() == AUTH_FILE.read_bytes():
                original_account = acct_file.stem
                break
    
    if not json_mode:
        print(f"🔄 Checking quota for {len(accounts)} account(s)...\n")
    
    now = int(time.time())
    results = {}
    for name in accounts:
        if not json_mode:
            print(f"  → {name}...", end=" ", flush=True)
        
        limits = _get_quota_for_account(name)
        quota = _quota_summary(limits)
        
        if quota:
            weekly_pct = quota['used_percent']
            daily_pct = quota['daily_used']
            weekly_resets_at = quota['resets_at']
            
            # If quota has already reset, treat as 0% used
            effective_weekly_pct = 0 if now >= weekly_resets_at else weekly_pct
            
            daily_resets_at = quota.get('daily_resets_at', 0)
            effective_daily_pct = 0 if (daily_resets_at and now >= daily_resets_at) else (daily_pct or 0)

            results[name] = {
                'weekly_used': weekly_pct,
                'weekly_resets_at': weekly_resets_at,
                'effective_weekly_used': effective_weekly_pct,
                'daily_used': daily_pct,
                'daily_resets_at': daily_resets_at,
                'effective_daily_used': effective_daily_pct,
                'available': 100 - effective_weekly_pct,
                'quota_source': quota['source'],
            }
            if not json_mode:
                limit_reset = limits.get('_limit_error') if isinstance(limits, dict) else None
                limit_bucket = limits.get('_limit_bucket') if isinstance(limits, dict) else None
                if limit_reset and limit_bucket == "secondary":
                    print(f"blocked until {limit_reset}")
                elif limit_reset and limit_bucket == "primary":
                    print(f"5h blocked until {limit_reset}")
                elif effective_weekly_pct < weekly_pct:
                    print(f"weekly {weekly_pct:.0f}% used → RESET (now 0%)")
                else:
                    print(f"weekly {weekly_pct:.0f}% used")
        else:
            results[name] = {'error': 'could not get quota'}
            if not json_mode:
                print("❌ failed")
    
    # Find best account (lowest effective weekly usage, accounting for resets)
    valid = {k: v for k, v in results.items() if 'available' in v}
    eligible = {
        k: v
        for k, v in valid.items()
        if k not in excluded and not _is_hard_blocked_quota(v)
    }
    
    if not valid:
        if original_account:
            shutil.copy(ACCOUNTS_DIR / f"{original_account}.json", AUTH_FILE)
        if json_mode:
            print(json.dumps({"error": "No valid quota data", "results": results}))
        else:
            print("\n❌ Could not get quota for any account")
        return

    if not eligible:
        if original_account:
            shutil.copy(ACCOUNTS_DIR / f"{original_account}.json", AUTH_FILE)
        payload = {
            "error": "No account with available quota",
            "excluded_accounts": sorted(excluded),
            "blocked_accounts": sorted(k for k, v in valid.items() if _is_hard_blocked_quota(v)),
            "results": results,
        }
        if json_mode:
            print(json.dumps(payload))
        else:
            print("\n❌ No account with available quota")
            if excluded:
                print(f"Excluded: {', '.join(sorted(excluded))}")
        return
    
    # Sort by: 1) lowest effective usage, 2) earliest reset time (if both at 100%)
    def sort_key(k):
        """Budget-based scoring: prefer accounts under their ideal usage pace.

        Weekly budget: if you spread 100% evenly over 7 days, at any point
        you know where you *should* be: budget = (elapsed / 168h) * 100%.
        Score = actual% - budget%. Negative = under budget (good).

        5h penalty: if the 5h window is nearly maxed, the account is about
        to get blocked regardless of weekly headroom.
        """
        v = eligible[k]
        weekly = v['effective_weekly_used']
        daily = v.get('effective_daily_used', 0)
        weekly_resets = v.get('weekly_resets_at', 0)
        daily_resets = v.get('daily_resets_at', 0)

        # Hard block: either window at 100% means the account is unusable
        if weekly >= 100:
            weekly_penalty = 500  # completely blocked on weekly
        else:
            weekly_penalty = 0

        # Weekly budget score (only meaningful if not blocked)
        weekly_window = 168 * 3600  # 7 days in seconds
        weekly_elapsed = weekly_window - max(0, weekly_resets - now)
        weekly_budget = (weekly_elapsed / weekly_window) * 100 if weekly_window > 0 else 0
        weekly_score = weekly - weekly_budget  # negative = under budget

        # 5h penalty: if daily is almost maxed, heavily penalize
        if daily >= 100:
            daily_penalty = 200   # blocked right now
        elif daily >= 90:
            daily_penalty = 50    # about to be blocked
        elif daily >= 75:
            daily_penalty = 10    # getting warm
        else:
            daily_penalty = 0     # fine

        return weekly_penalty + weekly_score + daily_penalty
    
    # Compute and attach scores for transparency
    for k in valid:
        if k in eligible:
            valid[k]['_score'] = sort_key(k)

    best = min(eligible.keys(), key=sort_key)
    
    # Check if already on best account
    already_active = (original_account == best)
    
    # Always restore auth.json to the best account.
    # Probing switches auth.json to each account in turn, so after
    # probing it points at the LAST probed account, not the best one.
    shutil.copy(ACCOUNTS_DIR / f"{best}.json", AUTH_FILE)
    if not already_active:
        log_account_switch(best, get_user_id_from_auth(ACCOUNTS_DIR / f"{best}.json"))
    
    sync_saved_openclaw_profiles()
    
    if json_mode:
        print(json.dumps({
            "switched_to": best,
            "already_active": already_active,
            "weekly_used": valid[best]['weekly_used'],
            "effective_weekly_used": valid[best]['effective_weekly_used'],
            "weekly_resets_at": valid[best].get('weekly_resets_at'),
            "available": valid[best]['available'],
            "excluded_accounts": sorted(excluded),
            "available_accounts": sorted(eligible.keys()),
            "blocked_accounts": sorted(k for k, v in valid.items() if _is_hard_blocked_quota(v)),
            "all_accounts": results
        }, indent=2))
    else:
        from datetime import datetime
        if already_active:
            print(f"\n✅ Already on best account: {best}")
        else:
            print(f"\n✅ Switched to: {best}")
        
        # Show table sorted by score (best first)
        sorted_accounts = sorted(
            results.items(),
            key=lambda x: x[1].get('_score', 999) if '_score' in x[1] else 999
        )
        
        # Header
        print(f"\n{'Account':<12} {'7d':>5} {'5h':>5} {'Score':>7} {'7d Resets':>14} {'5h Resets':>14}")
        print(f"{'─' * 12} {'─' * 5} {'─' * 5} {'─' * 7} {'─' * 14} {'─' * 14}")
        
        for name, data in sorted_accounts:
            if 'error' in data:
                print(f"{name:<12} {'err':>5} {'':>5} {'':>7} {data['error']}")
                continue
            
            marker = " ←" if name == best else ""
            weekly = data.get('effective_weekly_used', data.get('weekly_used', 0))
            daily = data.get('effective_daily_used', data.get('daily_used', 0))
            score = data.get('_score', 0)
            resets_at = data.get('weekly_resets_at', 0)
            
            # Format weekly with reset indicator
            if data.get('effective_weekly_used', 999) < data.get('weekly_used', 0):
                weekly_str = "RST"
            elif weekly >= 100:
                weekly_str = "MAX"
            else:
                weekly_str = f"{weekly:.0f}%"
            
            # Format daily
            if daily >= 100:
                daily_str = "MAX"
            else:
                daily_str = f"{daily:.0f}%"
            
            # Format reset times
            reset_str = datetime.fromtimestamp(resets_at).strftime("%b %d %H:%M") if resets_at else "?"
            daily_resets = data.get('daily_resets_at', 0)
            if daily_resets and daily_resets > now:
                delta_s = int(daily_resets - now)
                h, m = delta_s // 3600, (delta_s % 3600) // 60
                daily_reset_str = f"in {h}h {m:02d}m"
            elif daily_resets:
                daily_reset_str = "reset"
            else:
                daily_reset_str = "?"
            
            print(f"{name:<12} {weekly_str:>5} {daily_str:>5} {score:>+7.1f} {reset_str:>14} {daily_reset_str:>14}{marker}")

def cmd_use(name):
    ensure_dirs()
    source = ACCOUNTS_DIR / f"{name}.json"
    
    if not source.exists():
        print(f"❌ Account '{name}' not found.")
        print("Available accounts:")
        for f in _iter_account_snapshot_files():
            print(f" - {f.stem}")
        return
    
    # Backup current if it's not saved? 
    # Maybe risky to overwrite silently, but that's what a switcher does.
    
    shutil.copy2(source, AUTH_FILE)
    log_account_switch(name, get_user_id_from_auth(source))
    info = get_account_info(source)
    print(f"✅ Switched to account: {name} ({_describe_identity(info)})")
    
    # Sync token to OpenClaw
    sync_saved_openclaw_profiles()

def _extract_openclaw_token_payload(source_path):
    """Extract token fields from a Codex snapshot for OpenClaw sync."""
    with open(source_path, "r") as f:
        data = json.load(f)

    tokens = _get_tokens(data)
    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")
    id_token = tokens.get("id_token")
    account_id = _read_codex_account_id(data) or ""

    if not access_token or not refresh_token:
        return None

    # Prefer access_token expiry (long-lived, used for API calls) over
    # id_token expiry (short-lived, only for identity).
    expires = 0
    for token_key in ("access_token", "id_token"):
        tok = tokens.get(token_key)
        if tok and "." in tok:
            try:
                seg = tok.split(".")[1]
                seg += '=' * (-len(seg) % 4)
                decoded = json.loads(base64.urlsafe_b64decode(seg))
                exp = int(decoded.get("exp", 0))
                if exp > 0:
                    candidate = exp * 1000
                    if candidate > expires:
                        expires = candidate
            except Exception:
                pass

    # Extract email from token for profile key
    email = None
    for token_key in ("id_token", "access_token"):
        tok = tokens.get(token_key)
        if tok and "." in tok:
            try:
                seg = tok.split(".")[1]
                seg += '=' * (-len(seg) % 4)
                decoded = json.loads(base64.urlsafe_b64decode(seg))
                profile = decoded.get("https://api.openai.com/profile", {})
                email = profile.get("email") or decoded.get("email")
                if email:
                    break
            except Exception:
                pass

    return {
        "access": access_token,
        "refresh": refresh_token,
        "expires": expires,
        "accountId": account_id,
        "email": email,
    }


def _build_openclaw_profile_id(name: str, email: str | None, account_id: str | None) -> str:
    normalized_email = _normalize_str(email)
    normalized_account_id = _normalize_str(account_id)
    if _is_known_email(normalized_email) and normalized_account_id:
        return f"openai-codex:{normalized_email}:{normalized_account_id}"
    if _is_known_email(normalized_email):
        return f"openai-codex:{normalized_email}"
    if normalized_account_id:
        return f"openai-codex:account:{normalized_account_id}"
    return f"openai-codex:{name}"


def _sync_to_agent_auth_json(token_payload, quiet: bool = False):
    """Sync the active Codex token into every OpenClaw agent's auth.json.

    Each agent has ~/.openclaw/agents/<id>/agent/auth.json with a top-level
    'openai-codex' key containing {type, access, refresh, expires}.
    """
    if not OPENCLAW_AGENTS_DIR.is_dir():
        return

    updated = []
    for agent_dir in sorted(OPENCLAW_AGENTS_DIR.iterdir()):
        auth_file = agent_dir / "agent" / "auth.json"
        if not auth_file.exists():
            continue

        try:
            with open(auth_file, "r") as f:
                agent_data = json.load(f)

            if not isinstance(agent_data, dict):
                continue

            # Only update if there's already an openai-codex entry (don't inject into agents that don't use it)
            if "openai-codex" not in agent_data:
                continue

            agent_data["openai-codex"] = {
                "type": "oauth",
                "access": token_payload["access"],
                "refresh": token_payload["refresh"],
                "expires": token_payload["expires"],
            }

            with open(auth_file, "w") as f:
                json.dump(agent_data, f, indent=2)
                f.write("\n")

            updated.append(agent_dir.name)
        except Exception:
            continue

    if updated and not quiet:
        print(f"✅ Updated auth.json for agent(s): {', '.join(updated)}", file=sys.stderr)


def sync_to_openclaw(name, source_path, quiet: bool = False):
    try:
        token_payload = _extract_openclaw_token_payload(source_path)
        if not token_payload:
            return

                # 1. Update auth-profiles.json for ALL agents
        agents_dir = Path.home() / ".openclaw" / "agents"
        profile_paths = []
        if agents_dir.is_dir():
            for agent_dir in sorted(agents_dir.iterdir()):
                ap = agent_dir / "agent" / "auth-profiles.json"
                if ap.exists():
                    profile_paths.append(ap)

        # Fallback to just main if nothing found
        if not profile_paths:
            profile_paths = [OPENCLAW_AUTH_PROFILES_FILE]

        updated_agents = []
        email = token_payload.get("email") or name
        account_id = token_payload.get("accountId")
        profile_id = _build_openclaw_profile_id(name, email, account_id)

        for oc_path in profile_paths:
            try:
                with open(oc_path, "r") as f:
                    oc_data = json.load(f)

                if "profiles" not in oc_data:
                    oc_data["profiles"] = {}

                # Remove old name-based key if it exists (migration)
                old_key = f"openai-codex:{name}"
                if old_key in oc_data["profiles"] and old_key != profile_id:
                    del oc_data["profiles"][old_key]

                legacy_email_key = None
                normalized_email = _normalize_str(email)
                if _is_known_email(normalized_email):
                    legacy_email_key = f"openai-codex:{normalized_email}"

                if legacy_email_key and legacy_email_key in oc_data["profiles"] and legacy_email_key != profile_id:
                    legacy_profile = oc_data["profiles"].get(legacy_email_key)
                    legacy_account_id = None
                    if isinstance(legacy_profile, dict):
                        legacy_account_id = _normalize_str(legacy_profile.get("accountId"))
                    if legacy_account_id == _normalize_str(account_id):
                        del oc_data["profiles"][legacy_email_key]

                oc_data["profiles"][profile_id] = {
                    "type": "oauth",
                    "provider": "openai-codex",
                    "access": token_payload["access"],
                    "refresh": token_payload["refresh"],
                    "expires": token_payload["expires"],
                    "accountId": token_payload.get("accountId", ""),
                    "email": email,
                }

                with open(oc_path, "w") as f:
                    json.dump(oc_data, f, indent=2)

                updated_agents.append(oc_path.parent.parent.name)
            except Exception:
                continue

        if not quiet and updated_agents:
            print(f"\u2705 Synced {name} token to OpenClaw auth-profiles.json ({', '.join(updated_agents)})", file=sys.stderr)

        # 2. Update every agent's auth.json that has an openai-codex entry
        _sync_to_agent_auth_json(token_payload, quiet=quiet)

    except Exception as e:
        if not quiet:
            print(f"⚠️ Failed to sync to OpenClaw: {e}", file=sys.stderr)


def sync_saved_openclaw_profiles() -> None:
    """Ensure every saved Codex snapshot is mirrored to an OpenClaw profile."""
    try:
        for account_file in _iter_account_snapshot_files():
            sync_to_openclaw(account_file.stem, account_file, quiet=True)
    except Exception:
        return

def get_token_email(auth_path) -> str:
    """Extract email from a token file."""
    info = get_account_info(auth_path) or {}
    return (info.get("email") or "").strip().lower()


def _build_decoded_token_fields(data: dict) -> dict:
    tokens = _get_tokens(data)
    decoded = {}
    for key in ("id_token", "access_token", "refresh_token"):
        token = tokens.get(key)
        if isinstance(token, str) and token.count(".") == 2:
            decoded[key] = decode_jwt(token)
    return decoded


def _annotate_snapshot_file(path: Path) -> None:
    try:
        with open(path, "r") as f:
            data = json.load(f)

        if not isinstance(data, dict):
            return

        data["decoded_tokens"] = _build_decoded_token_fields(data)

        with open(path, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
    except Exception:
        return


def _flatten_json(value, prefix="") -> dict[str, object]:
    items: dict[str, object] = {}
    if isinstance(value, dict):
        for key in sorted(value):
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            items.update(_flatten_json(value[key], child_prefix))
        return items
    if isinstance(value, list):
        if not value:
            items[prefix] = []
            return items
        for idx, item in enumerate(value):
            child_prefix = f"{prefix}[{idx}]"
            items.update(_flatten_json(item, child_prefix))
        return items
    items[prefix] = value
    return items


def safe_save_token(source_path: Path, target_path: Path, force: bool = False) -> tuple[bool, str]:
    """Safely save a token file, preventing overwrites with different token identities.
    
    Returns (success, message).
    """
    if not source_path.exists():
        return False, "Source token file does not exist"
    
    source_info = get_account_info(source_path) or {}
    source_email = (source_info.get("email") or "").strip().lower()
    source_account_id = _normalize_str(source_info.get("account_id"))
    source_user_id = _normalize_str(source_info.get("user_id"))

    if not source_user_id and not source_account_id and (not source_email or source_email in ("unknown", "error")):
        return False, "Could not determine identity from source token"
    
    # If target exists, verify token identities match.
    if target_path.exists():
        target_info = get_account_info(target_path) or {}
        target_email = (target_info.get("email") or "").strip().lower()
        target_account_id = _normalize_str(target_info.get("account_id"))
        target_user_id = _normalize_str(target_info.get("user_id"))

        mismatch = None
        if source_user_id and target_user_id and source_user_id != target_user_id:
            mismatch = f"target has user_id {target_user_id}, source has {source_user_id}"
        elif source_email and target_email and target_email not in ("unknown", "error") and source_email != target_email:
            mismatch = f"target has {target_email}, source has {source_email}"
        elif source_account_id and target_account_id and source_account_id != target_account_id:
            mismatch = f"target has account_id {target_account_id}, source has {source_account_id}"

        if mismatch:
            if not force:
                return False, f"Refusing to overwrite: {mismatch}"
            # Force mode: warn but proceed
            print(f"⚠️  Warning: overwriting despite identity mismatch ({mismatch}) (--force)")
    
    shutil.copy2(source_path, target_path)
    _annotate_snapshot_file(target_path)
    if source_user_id:
        return True, f"Saved token for user_id {source_user_id}"
    if source_email and source_email not in ("unknown", "error"):
        return True, f"Saved token for {source_email}"
    return True, f"Saved token for account_id {source_account_id}"


def cmd_save(name: str, force: bool = False):
    """Save the current auth.json to a named account, with safety check."""
    ensure_dirs()
    
    if not AUTH_FILE.exists():
        print("❌ No current auth.json to save")
        return
    
    target = ACCOUNTS_DIR / f"{name}.json"
    success, message = safe_save_token(AUTH_FILE, target, force=force)
    
    if success:
        print(f"✅ {message} as '{name}'")
        sync_to_openclaw(name, target)
    else:
        print(f"❌ {message}")


def sync_current_login_to_snapshot() -> None:
    """Persist the CURRENT ~/.codex/auth.json back into the matching named snapshot.

    This makes snapshots behave like "last known good refreshed token state".

    Rules:
    - If the current login's token identity matches an existing snapshot (any name), update that file.
    - If it doesn't match any snapshot, create a new snapshot using the email local-part, or userId if email is unavailable.
    - NEVER overwrite a snapshot with a different user's token (safety check).

    This runs silently (no prints) because it's executed on every invocation.
    """
    try:
        ensure_dirs()
        if not AUTH_FILE.exists():
            return

        info = get_account_info(AUTH_FILE) or {}
        account_id = info.get("account_id")
        user_id = info.get("user_id")
        email = (info.get("email") or "").strip().lower()
        if not user_id and (not email or email in ("unknown", "error")) and not account_id:
            return

        match = _resolve_matching_account(account_id, user_id, email)
        if match is not None:
            if not _same_auth_material(AUTH_FILE, match):
                # Safety check: verify token identities match before overwriting
                success, _ = safe_save_token(AUTH_FILE, match, force=False)
                if success:
                    sync_to_openclaw(match.stem, match, quiet=True)
                    return
                match = None
            else:
                return

        # No match: create a new snapshot using email local-part or userId
        suggested = _suggested_account_name(email, user_id)
        name, target = _resolve_unique_name_path(suggested)
        success, _ = safe_save_token(AUTH_FILE, target, force=False)
        if success:
            sync_to_openclaw(name, target, quiet=True)
    except Exception:
        # Never fail the command because of sync.
        return


def main():
    parser = argparse.ArgumentParser(description="Codex Account Switcher")
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list", help="List saved accounts")
    list_parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show extra diagnostics (refresh age + token TTL)",
    )
    list_parser.add_argument(
        "--json",
        action="store_true",
        help="Output verbose information as JSON",
    )

    add_parser = subparsers.add_parser("add", help="Run a fresh login and save as an account")
    add_parser.add_argument(
        "--name",
        help="Optional account name (non-interactive default). If omitted, uses email local-part or userId.",
    )
    add_parser.add_argument(
        "--device-auth",
        action="store_true",
        help="Use Codex device login instead of browser callback login.",
    )
    add_parser.add_argument(
        "--count",
        type=int,
        help="Number of accounts to capture in sequence before exiting.",
    )

    use_parser = subparsers.add_parser("use", help="Switch to an account")
    use_parser.add_argument("name", help="Name of the account to switch to")

    save_parser = subparsers.add_parser("save", help="Save current token to a named account")
    save_parser.add_argument("name", help="Name to save the account as")
    save_parser.add_argument("--force", action="store_true", help="Force overwrite even if emails don't match")

    auto_parser = subparsers.add_parser("auto", help="Switch to the account with most quota available")
    auto_parser.add_argument("--json", action="store_true", help="Output as JSON")
    auto_parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Skip an account name while auto-selecting. Can be repeated or comma-separated.",
    )

    dedupe_parser = subparsers.add_parser("dedupe", help="Collapse duplicate account snapshots by token identity")
    dedupe_parser.add_argument("--apply", action="store_true", help="Delete redundant snapshots after refreshing the canonical copy")
    dedupe_parser.add_argument("--json", action="store_true", help="Output the dedupe report as JSON")

    compare_parser = subparsers.add_parser("compare", help="Compare decoded token claims between two saved accounts")
    compare_parser.add_argument("left", help="First account name")
    compare_parser.add_argument("right", help="Second account name")
    compare_parser.add_argument("--json", action="store_true", help="Output as JSON")

    subparsers.add_parser("sync", help="Sync saved accounts to OpenClaw auth profiles")

    args = parser.parse_args()

    # Always persist the currently active login back into its named snapshot.
    sync_current_login_to_snapshot()
    if args.command != "dedupe":
        sync_saved_openclaw_profiles()

    if args.command == "add":
        cmd_add(
            name_override=getattr(args, "name", None),
            use_device_auth=bool(getattr(args, "device_auth", False)),
            count=getattr(args, "count", None),
        )
    elif args.command == "use":
        cmd_use(args.name)
    elif args.command == "save":
        cmd_save(args.name, force=bool(getattr(args, "force", False)))
    elif args.command == "auto":
        cmd_auto(json_mode=bool(getattr(args, "json", False)), exclude_accounts=getattr(args, "exclude", []))
    elif args.command == "dedupe":
        cmd_dedupe(json_mode=bool(getattr(args, "json", False)), apply=bool(getattr(args, "apply", False)))
    elif args.command == "compare":
        cmd_compare(args.left, args.right, json_mode=bool(getattr(args, "json", False)))
    elif args.command == "sync":
        cmd_sync()
    else:
        cmd_list(
            verbose=bool(getattr(args, "verbose", False)),
            json_mode=bool(getattr(args, "json", False)),
        )

if __name__ == "__main__":
    main()
