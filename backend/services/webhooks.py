from __future__ import annotations

import hashlib
import hmac
import json
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

try:
    from .. import db
except ImportError:
    import db


def sign_webhook_payload(secret: str, raw_body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def deliver_webhook_event(
    url: str,
    secret: str,
    event_type: str,
    payload: Dict[str, Any],
    timeout_sec: float = 8.0,
) -> Dict[str, Any]:
    envelope = {
        "event": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": payload,
    }
    raw_body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Scalereach-Webhooks/1.0",
        "X-Scalereach-Event": event_type,
    }
    if secret:
        headers["X-Scalereach-Signature"] = sign_webhook_payload(secret, raw_body)

    try:
        resp = httpx.post(url, content=raw_body, headers=headers, timeout=timeout_sec)
        return {
            "url": url,
            "ok": 200 <= resp.status_code < 300,
            "status_code": resp.status_code,
        }
    except Exception as exc:
        return {
            "url": url,
            "ok": False,
            "status_code": 0,
            "error": str(exc),
        }


def dispatch_job_webhooks(
    event_type: str,
    job_payload: Dict[str, Any],
    extra_webhook_url: Optional[str] = None,
    workspace_id: str = "default",
) -> None:
    """
    Dispatch signed webhooks asynchronously for registered workspace webhooks
    plus any per-job `webhookUrl`.
    """
    targets: List[Dict[str, str]] = []
    seen_urls: set[str] = set()

    for wh in db.list_webhooks(workspace_id=workspace_id):
        if not wh.get("active"):
            continue
        events = wh.get("events") or []
        if events and event_type not in events and "*" not in events:
            continue
        url = str(wh.get("url") or "").strip()
        if url and url not in seen_urls:
            seen_urls.add(url)
            targets.append({"url": url, "secret": str(wh.get("secret") or "")})

    if extra_webhook_url and extra_webhook_url.strip():
        clean = extra_webhook_url.strip()
        if clean not in seen_urls:
            seen_urls.add(clean)
            targets.append({"url": clean, "secret": ""})

    if not targets:
        return

    def _worker() -> None:
        for t in targets:
            deliver_webhook_event(t["url"], t["secret"], event_type, job_payload)

    threading.Thread(target=_worker, daemon=True, name=f"webhook-{event_type}").start()
