from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
TOKEN_FILE = DATA_DIR / "youtube_oauth.json"

YTTV_URL = "https://www.youtube.com/tv"
DEVICE_CODE_URL = "https://www.youtube.com/o/oauth2/device/code"
TOKEN_URL = "https://www.youtube.com/o/oauth2/token"
REVOKE_URL = "https://www.youtube.com/o/oauth2/revoke"
TV_USER_AGENT = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
TV_SCOPE = "http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content"

TV_SCRIPT_RE = re.compile(r'<script\s+id="base-js"\s+src="([^"]+)"[^>]*></script>')
CLIENT_IDENTITY_RE = re.compile(r'clientId:"(?P<client_id>[^"]+)",[^"]*?:"(?P<client_secret>[^"]+)"')


class YouTubeAuthManager:
    """
    Manages real YouTube TV OAuth2 Device Code verification, background token polling,
    disk persistence, automatic token refresh, and revocation.
    """

    def __init__(self, token_path: Path = TOKEN_FILE) -> None:
        self._lock = threading.RLock()
        self._token_path = token_path
        self._client_identity: Optional[Tuple[str, str]] = None
        self._tokens: Optional[Dict[str, Any]] = None
        self._pending: Optional[Dict[str, Any]] = None
        self._last_error: Optional[str] = None
        self._poll_generation = 0
        self._load_tokens()

    def _load_tokens(self) -> None:
        try:
            if self._token_path.exists():
                raw = json.loads(self._token_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and raw.get("access_token") and raw.get("refresh_token"):
                    self._tokens = raw
                    if raw.get("client_id") and raw.get("client_secret"):
                        self._client_identity = (str(raw["client_id"]), str(raw["client_secret"]))
        except Exception:
            self._tokens = None

    def _save_tokens(self, tokens: Dict[str, Any]) -> None:
        self._token_path.parent.mkdir(parents=True, exist_ok=True)
        self._token_path.write_text(json.dumps(tokens, indent=2), encoding="utf-8")

    def _clear_saved_tokens(self) -> None:
        try:
            if self._token_path.exists():
                self._token_path.unlink()
        except OSError:
            pass

    def _fetch_client_identity(self) -> Tuple[str, str]:
        with self._lock:
            if self._client_identity is not None:
                return self._client_identity

        env_cid = os.environ.get("YOUTUBE_OAUTH_CLIENT_ID", "").strip()
        env_csec = os.environ.get("YOUTUBE_OAUTH_CLIENT_SECRET", "").strip()
        if env_cid and env_csec:
            with self._lock:
                self._client_identity = (env_cid, env_csec)
            return (env_cid, env_csec)

        req = urllib.request.Request(
            YTTV_URL,
            headers={
                "User-Agent": TV_USER_AGENT,
                "Referer": YTTV_URL,
                "Accept-Language": "en-US",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        script_match = TV_SCRIPT_RE.search(html)
        if not script_match:
            raise RuntimeError("Could not locate YouTube TV script URL for device verification.")

        script_src = script_match.group(1)
        script_url = script_src if script_src.startswith("http") else f"https://www.youtube.com{script_src}"
        js_req = urllib.request.Request(
            script_url,
            headers={"User-Agent": TV_USER_AGENT, "Referer": YTTV_URL},
        )
        with urllib.request.urlopen(js_req, timeout=20) as js_resp:
            js_body = js_resp.read().decode("utf-8", errors="ignore")

        client_match = CLIENT_IDENTITY_RE.search(js_body)
        if not client_match:
            raise RuntimeError("Could not extract YouTube device OAuth client credentials.")

        identity = (client_match.group("client_id"), client_match.group("client_secret"))
        with self._lock:
            self._client_identity = identity
        return identity

    def _post_json(self, url: str, payload: Dict[str, Any], timeout: int = 15) -> Dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": TV_USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", errors="ignore") or "{}")
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="ignore")
            try:
                parsed = json.loads(err_body)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
            raise RuntimeError(f"YouTube OAuth HTTP {exc.code}: {err_body[:200]}") from exc

    def start_device_auth(self) -> Dict[str, Any]:
        with self._lock:
            if self._tokens and self._tokens.get("access_token"):
                return {"connected": True, "pending": None}
            if self._pending and time.time() < float(self._pending.get("expiresAtSec", 0)) - 15:
                return {
                    "connected": False,
                    "pending": {
                        "verificationUrl": self._pending["verificationUrl"],
                        "userCode": self._pending["userCode"],
                        "expiresAt": self._pending["expiresAt"],
                    },
                }

        client_id, client_secret = self._fetch_client_identity()
        data = self._post_json(
            DEVICE_CODE_URL,
            {
                "client_id": client_id,
                "scope": TV_SCOPE,
                "device_id": str(uuid.uuid4()),
                "device_model": "ytlr::",
            },
        )
        if data.get("error") or data.get("error_code") or not data.get("device_code") or not data.get("user_code"):
            detail = data.get("error_description") or data.get("error") or "YouTube did not return a device code."
            raise RuntimeError(str(detail))

        expires_in = max(60, int(data.get("expires_in") or 1800))
        interval = max(3, int(data.get("interval") or 5))
        expires_at_sec = time.time() + expires_in
        verification_url = str(data.get("verification_url") or "https://www.google.com/device")
        user_code = str(data["user_code"])
        device_code = str(data["device_code"])

        with self._lock:
            self._poll_generation += 1
            gen = self._poll_generation
            self._last_error = None
            self._pending = {
                "verificationUrl": verification_url,
                "userCode": user_code,
                "deviceCode": device_code,
                "expiresAt": int(expires_at_sec * 1000),
                "expiresAtSec": expires_at_sec,
                "interval": interval,
                "client_id": client_id,
                "client_secret": client_secret,
            }

        thread = threading.Thread(
            target=self._poll_loop,
            args=(gen, device_code, client_id, client_secret, interval, expires_at_sec),
            daemon=True,
            name="yt-oauth-poll",
        )
        thread.start()

        return {
            "connected": False,
            "pending": {
                "verificationUrl": verification_url,
                "userCode": user_code,
                "expiresAt": int(expires_at_sec * 1000),
            },
        }

    def _poll_loop(
        self,
        generation: int,
        device_code: str,
        client_id: str,
        client_secret: str,
        interval: int,
        expires_at_sec: float,
    ) -> None:
        sleep_sec = max(3, interval)
        while time.time() < expires_at_sec:
            time.sleep(sleep_sec)
            with self._lock:
                if self._poll_generation != generation or self._pending is None:
                    return
            try:
                resp = self._post_json(
                    TOKEN_URL,
                    {
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "code": device_code,
                        "grant_type": "http://oauth.net/grant_type/device/1.0",
                    },
                )
            except Exception:
                continue

            err = resp.get("error")
            if err:
                if err == "authorization_pending":
                    continue
                if err == "slow_down":
                    sleep_sec = min(15, sleep_sec + 3)
                    continue
                with self._lock:
                    if self._poll_generation == generation:
                        self._pending = None
                        if err == "access_denied":
                            self._last_error = "YouTube verification was declined in Google."
                        elif err == "expired_token":
                            self._last_error = "Google device code expired. Click Connect to get a new code."
                        else:
                            self._last_error = str(resp.get("error_description") or f"YouTube OAuth error: {err}")
                return

            access_token = resp.get("access_token")
            refresh_token = resp.get("refresh_token")
            if access_token:
                expires_in = int(resp.get("expires_in") or 3600)
                token_record = {
                    "access_token": access_token,
                    "refresh_token": refresh_token or "",
                    "token_type": resp.get("token_type") or "Bearer",
                    "expires_at": time.time() + max(60, expires_in - 60),
                    "client_id": client_id,
                    "client_secret": client_secret,
                }
                with self._lock:
                    if self._poll_generation == generation:
                        self._tokens = token_record
                        self._pending = None
                        self._last_error = None
                        self._save_tokens(token_record)
                return

        with self._lock:
            if self._poll_generation == generation and self._pending is not None:
                self._pending = None
                self._last_error = "Google device code expired. Click Connect to try again."

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            if self._pending and time.time() >= float(self._pending.get("expiresAtSec", 0)):
                self._pending = None
                self._last_error = "Google device code expired. Click Connect to try again."

            connected = bool(self._tokens and self._tokens.get("access_token"))
            pending_public = (
                {
                    "verificationUrl": self._pending["verificationUrl"],
                    "userCode": self._pending["userCode"],
                    "expiresAt": self._pending["expiresAt"],
                }
                if self._pending
                else None
            )
            err = self._last_error
            if err and not pending_public and not connected:
                # Consume one-shot error after reporting
                self._last_error = None
            return {
                "connected": connected,
                "pending": pending_public,
                "error": err,
            }

    def disconnect(self) -> Dict[str, Any]:
        token_to_revoke: Optional[str] = None
        with self._lock:
            self._poll_generation += 1
            self._pending = None
            self._last_error = None
            if self._tokens:
                token_to_revoke = str(self._tokens.get("access_token") or "")
            self._tokens = None
            self._clear_saved_tokens()

        if token_to_revoke:
            try:
                revoke_url = f"{REVOKE_URL}?{urllib.parse.urlencode({'token': token_to_revoke})}"
                req = urllib.request.Request(revoke_url, method="POST")
                urllib.request.urlopen(req, timeout=10).close()
            except Exception:
                pass
        return {"ok": True, "connected": False}

    def get_valid_access_token(self) -> Optional[str]:
        with self._lock:
            if not self._tokens or not self._tokens.get("access_token"):
                return None
            expires_at = float(self._tokens.get("expires_at") or 0)
            if time.time() < expires_at:
                return str(self._tokens["access_token"])
            refresh_token = str(self._tokens.get("refresh_token") or "")
            client_id = str(self._tokens.get("client_id") or "")
            client_secret = str(self._tokens.get("client_secret") or "")

        if not refresh_token:
            return None

        try:
            if not client_id or not client_secret:
                client_id, client_secret = self._fetch_client_identity()
            resp = self._post_json(
                TOKEN_URL,
                {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            new_access = resp.get("access_token")
            if not new_access:
                return None
            expires_in = int(resp.get("expires_in") or 3600)
            with self._lock:
                if self._tokens is None:
                    return None
                self._tokens["access_token"] = new_access
                self._tokens["expires_at"] = time.time() + max(60, expires_in - 60)
                self._save_tokens(self._tokens)
                return str(new_access)
        except Exception:
            return None


youtube_auth = YouTubeAuthManager()
