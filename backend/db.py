from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent if BACKEND_DIR.name == "backend" else BACKEND_DIR
DEFAULT_DB_PATH = BACKEND_DIR / "data" / "scalereach.db"

_DB_LOCK = threading.RLock()


def get_db_path() -> Path:
    custom = os.environ.get("SQLITE_DB_PATH", "").strip()
    path = Path(custom).resolve() if custom else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(get_db_path()), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    source_path TEXT,
                    video_title TEXT NOT NULL DEFAULT 'Processing Video',
                    platform TEXT NOT NULL DEFAULT 'YouTube',
                    thumbnail_url TEXT DEFAULT '',
                    duration_sec REAL DEFAULT 0,
                    aspect_ratio TEXT NOT NULL DEFAULT '9:16 Portrait',
                    clip_preset TEXT NOT NULL DEFAULT 'Viral Clips',
                    duration_range TEXT NOT NULL DEFAULT 'Auto',
                    language TEXT NOT NULL DEFAULT 'Auto',
                    captions_enabled INTEGER NOT NULL DEFAULT 1,
                    caption_style TEXT NOT NULL DEFAULT 'classic',
                    auto_hook INTEGER NOT NULL DEFAULT 1,
                    smart_reframe INTEGER NOT NULL DEFAULT 1,
                    split_screen INTEGER NOT NULL DEFAULT 0,
                    background_video TEXT NOT NULL DEFAULT 'All',
                    max_clips INTEGER,
                    start_bound REAL NOT NULL DEFAULT 0,
                    end_bound REAL NOT NULL DEFAULT 0,
                    owns_rights INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL DEFAULT 'queued',
                    stage INTEGER NOT NULL DEFAULT 1,
                    active_step_index INTEGER NOT NULL DEFAULT 0,
                    progress INTEGER NOT NULL DEFAULT 0,
                    current_step TEXT NOT NULL DEFAULT 'Queued for processing',
                    note TEXT NOT NULL DEFAULT '',
                    error TEXT,
                    webhook_url TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS clips (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    clip_index INTEGER NOT NULL,
                    tag TEXT NOT NULL,
                    title TEXT NOT NULL,
                    hook_title TEXT NOT NULL DEFAULT '',
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    duration_str TEXT NOT NULL DEFAULT '0:00',
                    virality_score INTEGER NOT NULL DEFAULT 0,
                    sub_scores_json TEXT NOT NULL DEFAULT '{}',
                    score_reason TEXT NOT NULL DEFAULT '',
                    transcript TEXT NOT NULL DEFAULT '',
                    edited_caption_text TEXT,
                    caption_style TEXT NOT NULL DEFAULT 'classic',
                    aspect_ratio TEXT NOT NULL DEFAULT '9:16 Portrait',
                    language TEXT NOT NULL DEFAULT 'Auto',
                    status TEXT NOT NULL DEFAULT 'rendering',
                    progress INTEGER NOT NULL DEFAULT 0,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    video_path TEXT,
                    video_url TEXT,
                    thumbnail_path TEXT,
                    thumbnail_url TEXT,
                    download_url TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_clips_job_id ON clips(job_id, clip_index);

                CREATE TABLE IF NOT EXISTS transcripts (
                    job_id TEXT PRIMARY KEY,
                    language TEXT NOT NULL DEFAULT 'en',
                    language_probability REAL NOT NULL DEFAULT 1.0,
                    source TEXT NOT NULL DEFAULT 'faster-whisper',
                    full_text TEXT NOT NULL DEFAULT '',
                    segments_json TEXT NOT NULL DEFAULT '[]',
                    words_json TEXT NOT NULL DEFAULT '[]',
                    sentences_json TEXT NOT NULL DEFAULT '[]',
                    audio_path TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS api_keys (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT 'default',
                    name TEXT NOT NULL,
                    key_prefix TEXT NOT NULL,
                    key_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    revoked INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS webhooks (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL DEFAULT 'default',
                    url TEXT NOT NULL,
                    secret TEXT NOT NULL DEFAULT '',
                    events_json TEXT NOT NULL DEFAULT '["job.completed","job.failed"]',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                """
            )
            # Safe idempotent migrations for existing SQLite databases
            job_cols = {r["name"] for r in conn.execute("PRAGMA table_info(jobs)").fetchall()}
            if "logs_json" not in job_cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN logs_json TEXT NOT NULL DEFAULT '[]'")

            clip_cols = {r["name"] for r in conn.execute("PRAGMA table_info(clips)").fetchall()}
            if "description" not in clip_cols:
                conn.execute("ALTER TABLE clips ADD COLUMN description TEXT NOT NULL DEFAULT ''")
            if "hashtags_json" not in clip_cols:
                conn.execute("ALTER TABLE clips ADD COLUMN hashtags_json TEXT NOT NULL DEFAULT '[]'")
            if "hook_reason" not in clip_cols:
                conn.execute("ALTER TABLE clips ADD COLUMN hook_reason TEXT NOT NULL DEFAULT ''")

            conn.commit()
        finally:
            conn.close()


def mark_interrupted_jobs() -> int:
    """On server startup, mark any mid-flight jobs as failed so clients get a clear retry prompt."""
    with _DB_LOCK:
        conn = _connect()
        try:
            cur = conn.execute(
                """
                UPDATE jobs
                SET status = 'failed',
                    current_step = 'Interrupted by restart',
                    error = 'Processing was interrupted by a backend restart. Click Retry to run again.',
                    updated_at = ?
                WHERE status IN ('downloading', 'transcribing', 'analyzing', 'rendering')
                """,
                (_utc_now(),),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def list_queued_jobs() -> List[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC"
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def create_job(job_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    now = _utc_now()
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, url, source_path, video_title, platform, thumbnail_url, duration_sec,
                    aspect_ratio, clip_preset, duration_range, language,
                    captions_enabled, caption_style, auto_hook, smart_reframe,
                    split_screen, background_video, max_clips, start_bound, end_bound,
                    owns_rights, status, stage, active_step_index, progress, current_step,
                    note, error, webhook_url, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    str(payload.get("url") or ""),
                    payload.get("sourcePath"),
                    str(payload.get("videoTitle") or "Processing Video"),
                    str(payload.get("platform") or "YouTube"),
                    str(payload.get("thumbnailUrl") or ""),
                    float(payload.get("durationSec") or 0.0),
                    str(payload.get("aspectRatio") or "9:16 Portrait"),
                    str(payload.get("preset") or "Viral Clips"),
                    str(payload.get("durationRange") or "Auto"),
                    str(payload.get("language") or "Auto"),
                    1 if payload.get("captionsEnabled", True) else 0,
                    str(payload.get("captionStyle") or "classic"),
                    1 if payload.get("autoHook", True) else 0,
                    1 if payload.get("smartReframe", True) else 0,
                    1 if payload.get("splitScreen", False) else 0,
                    str(payload.get("backgroundVideo") or "All"),
                    int(payload["maxClips"]) if payload.get("maxClips") else None,
                    float(payload.get("startSec") or 0.0),
                    float(payload.get("endSec") or 0.0),
                    1 if payload.get("ownsRights", True) else 0,
                    "queued",
                    1,
                    0,
                    2,
                    "Queued for processing",
                    "",
                    None,
                    payload.get("webhookUrl"),
                    now,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    return get_job_response(job_id) or {}


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {
        "source_path",
        "video_title",
        "platform",
        "thumbnail_url",
        "duration_sec",
        "status",
        "stage",
        "active_step_index",
        "progress",
        "current_step",
        "note",
        "error",
    }
    filtered = {k: v for k, v in fields.items() if k in allowed}
    if not filtered:
        return
    filtered["updated_at"] = _utc_now()
    assignments = ", ".join(f"{k} = ?" for k in filtered.keys())
    values = list(filtered.values()) + [job_id]
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()


def append_job_log(job_id: str, message: str) -> None:
    clean = (message or "").strip()
    if not clean:
        return
    entry = {"ts": _utc_now(), "message": clean}
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute("SELECT logs_json FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return
            existing = json.loads(row["logs_json"] or "[]")
            if not isinstance(existing, list):
                existing = []
            existing.append(entry)
            existing = existing[-60:]
            conn.execute(
                "UPDATE jobs SET logs_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(existing, ensure_ascii=False), _utc_now(), job_id),
            )
            conn.commit()
        finally:
            conn.close()


def save_transcript(
    job_id: str,
    *,
    language: str,
    language_probability: float,
    source: str,
    full_text: str,
    segments: List[Dict[str, Any]],
    words: List[Dict[str, Any]],
    sentences: List[Dict[str, Any]],
    audio_path: Optional[str] = None,
) -> None:
    now = _utc_now()
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO transcripts (
                    job_id, language, language_probability, source,
                    full_text, segments_json, words_json, sentences_json, audio_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    language=excluded.language,
                    language_probability=excluded.language_probability,
                    source=excluded.source,
                    full_text=excluded.full_text,
                    segments_json=excluded.segments_json,
                    words_json=excluded.words_json,
                    sentences_json=excluded.sentences_json,
                    audio_path=excluded.audio_path
                """,
                (
                    job_id,
                    language,
                    float(language_probability),
                    source,
                    full_text,
                    json.dumps(segments, ensure_ascii=False),
                    json.dumps(words, ensure_ascii=False),
                    json.dumps(sentences, ensure_ascii=False),
                    audio_path,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def get_transcript(job_id: str) -> Optional[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM transcripts WHERE job_id = ?", (job_id,)).fetchone()
            if not row:
                return None
            return {
                "job_id": row["job_id"],
                "language": row["language"],
                "language_probability": row["language_probability"],
                "source": row["source"],
                "transcript": row["full_text"],
                "segments": json.loads(row["segments_json"] or "[]"),
                "words": json.loads(row["words_json"] or "[]"),
                "sentences": json.loads(row["sentences_json"] or "[]"),
                "audio_path": row["audio_path"],
            }
        finally:
            conn.close()


def replace_job_clips(job_id: str, clips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    now = _utc_now()
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute("DELETE FROM clips WHERE job_id = ?", (job_id,))
            inserted_ids: List[int] = []
            for idx, clip in enumerate(clips):
                raw_tags = clip.get("hashtags") or []
                if isinstance(raw_tags, str):
                    raw_tags = [t.strip() for t in raw_tags.split() if t.strip()]
                cur = conn.execute(
                    """
                    INSERT INTO clips (
                        job_id, clip_index, tag, title, hook_title, description, hashtags_json, hook_reason,
                        start_sec, end_sec, duration_str, virality_score, sub_scores_json, score_reason,
                        transcript, edited_caption_text, caption_style, aspect_ratio, language,
                        status, progress, favorite, video_path, video_url,
                        thumbnail_path, thumbnail_url, download_url, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        idx,
                        clip.get("tag") or f"#{idx + 1}",
                        clip.get("title") or f"Clip #{idx + 1}",
                        clip.get("hook_title") or clip.get("title") or "",
                        str(clip.get("description") or ""),
                        json.dumps(raw_tags, ensure_ascii=False),
                        str(clip.get("hook_reason") or clip.get("score_reason") or ""),
                        float(clip.get("start_sec", clip.get("start_time", 0.0))),
                        float(clip.get("end_sec", clip.get("end_time", 0.0))),
                        clip.get("duration_str") or clip.get("duration") or "0:00",
                        int(clip.get("virality_score", clip.get("viral_score", 0))),
                        json.dumps(clip.get("sub_scores") or {}, ensure_ascii=False),
                        str(clip.get("score_reason") or ""),
                        str(clip.get("transcript") or clip.get("transcript_text") or clip.get("caption_text") or ""),
                        clip.get("edited_caption_text"),
                        str(clip.get("caption_style") or "classic"),
                        str(clip.get("aspect_ratio") or "9:16 Portrait"),
                        str(clip.get("language") or "Auto"),
                        str(clip.get("status") or "rendering"),
                        int(clip.get("progress", 10)),
                        1 if clip.get("favorite") else 0,
                        clip.get("video_path"),
                        clip.get("video_url"),
                        clip.get("thumbnail_path"),
                        clip.get("thumbnail_url"),
                        clip.get("download_url"),
                        now,
                        now,
                    ),
                )
                inserted_ids.append(int(cur.lastrowid))
            conn.commit()
        finally:
            conn.close()
    return get_clips_for_job(job_id)


def update_clip_by_db_id(clip_db_id: int, **fields: Any) -> Optional[Dict[str, Any]]:
    allowed = {
        "title",
        "hook_title",
        "description",
        "hashtags_json",
        "hook_reason",
        "start_sec",
        "end_sec",
        "duration_str",
        "virality_score",
        "sub_scores_json",
        "score_reason",
        "transcript",
        "edited_caption_text",
        "caption_style",
        "aspect_ratio",
        "language",
        "status",
        "progress",
        "favorite",
        "video_path",
        "video_url",
        "thumbnail_path",
        "thumbnail_url",
        "download_url",
    }
    filtered: Dict[str, Any] = {}
    for k, v in fields.items():
        if k == "sub_scores" and isinstance(v, dict):
            filtered["sub_scores_json"] = json.dumps(v, ensure_ascii=False)
        elif k == "hashtags" and isinstance(v, list):
            filtered["hashtags_json"] = json.dumps(v, ensure_ascii=False)
        elif k == "favorite" and isinstance(v, bool):
            filtered["favorite"] = 1 if v else 0
        elif k in allowed:
            filtered[k] = v
    if not filtered:
        return get_clip_by_id(clip_db_id)
    filtered["updated_at"] = _utc_now()
    assignments = ", ".join(f"{k} = ?" for k in filtered.keys())
    values = list(filtered.values()) + [clip_db_id]
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(f"UPDATE clips SET {assignments} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()
    return get_clip_by_id(clip_db_id)


def _format_clip_row(row: sqlite3.Row) -> Dict[str, Any]:
    row_keys = set(row.keys())
    sub_scores = json.loads(row["sub_scores_json"] or "{}")
    hashtags = json.loads(row["hashtags_json"] or "[]") if "hashtags_json" in row_keys else []
    description = row["description"] if "description" in row_keys else ""
    hook_reason = (row["hook_reason"] if "hook_reason" in row_keys else "") or row["score_reason"]
    score_val = int(row["virality_score"] or 0)
    caption_text = row["edited_caption_text"] or row["transcript"]
    return {
        "id": int(row["id"]),
        "db_id": int(row["id"]),
        "clip_index": int(row["clip_index"]),
        "clip_id": int(row["clip_index"]) + 1,
        "job_id": row["job_id"],
        "tag": row["tag"],
        "title": row["title"],
        "hookTitle": row["hook_title"] or row["title"],
        "hook_title": row["hook_title"] or row["title"],
        "description": description or "",
        "hashtags": hashtags if isinstance(hashtags, list) else [],
        "hook_reason": hook_reason or "",
        "hookReason": hook_reason or "",
        "startSec": float(row["start_sec"]),
        "endSec": float(row["end_sec"]),
        "start_sec": float(row["start_sec"]),
        "end_sec": float(row["end_sec"]),
        "start_time": float(row["start_sec"]),
        "end_time": float(row["end_sec"]),
        "duration": row["duration_str"],
        "duration_str": row["duration_str"],
        "score": str(score_val),
        "virality_score": score_val,
        "viral_score": score_val,
        "amberScore": score_val < 80,
        "sub_scores": sub_scores,
        "subScores": sub_scores,
        "score_reason": row["score_reason"],
        "scoreReason": row["score_reason"],
        "transcript": caption_text,
        "caption_text": caption_text,
        "raw_transcript": row["transcript"],
        "edited_caption_text": row["edited_caption_text"],
        "captionStyle": row["caption_style"],
        "caption_style": row["caption_style"],
        "aspectRatio": row["aspect_ratio"],
        "aspect_ratio": row["aspect_ratio"],
        "language": row["language"],
        "status": row["status"],
        "progress": int(row["progress"] or 0),
        "favorite": bool(row["favorite"]),
        "videoPath": row["video_path"],
        "video_path": row["video_path"],
        "videoUrl": row["video_url"],
        "video_url": row["video_url"],
        "thumbnailPath": row["thumbnail_path"],
        "thumbnailUrl": row["thumbnail_url"],
        "thumbnail_url": row["thumbnail_url"],
        "downloadUrl": row["download_url"],
        "download_url": row["download_url"],
    }


def get_clips_for_job(job_id: str) -> List[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT * FROM clips WHERE job_id = ? ORDER BY clip_index ASC",
                (job_id,),
            ).fetchall()
            return [_format_clip_row(r) for r in rows]
        finally:
            conn.close()


def get_clip_by_id(clip_db_id: int) -> Optional[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_db_id,)).fetchone()
            return _format_clip_row(row) if row else None
        finally:
            conn.close()


def find_clip_for_job(job_id: str, clip_identifier: int) -> Optional[Dict[str, Any]]:
    """Lookup clip by database id OR by clip_index for backwards compatibility."""
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT * FROM clips WHERE job_id = ? AND (id = ? OR clip_index = ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1",
                (job_id, clip_identifier, clip_identifier, clip_identifier),
            ).fetchone()
            return _format_clip_row(row) if row else None
        finally:
            conn.close()


def delete_clip_for_job(job_id: str, clip_identifier: int) -> bool:
    clip = find_clip_for_job(job_id, clip_identifier)
    if not clip:
        return False
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute("DELETE FROM clips WHERE id = ?", (clip["id"],))
            conn.commit()
            return True
        finally:
            conn.close()


def get_job_row(job_id: str) -> Optional[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def get_job_response(job_id: str) -> Optional[Dict[str, Any]]:
    row = get_job_row(job_id)
    if not row:
        return None
    clips = get_clips_for_job(job_id)
    return {
        "job_id": row["id"],
        "jobId": row["id"],
        "url": row["url"],
        "sourcePath": row["source_path"],
        "videoTitle": row["video_title"],
        "platform": row["platform"],
        "thumbnailUrl": row["thumbnail_url"],
        "durationSec": float(row["duration_sec"] or 0.0),
        "aspectRatio": row["aspect_ratio"],
        "clipPreset": row["clip_preset"],
        "durationRange": row["duration_range"],
        "language": row["language"],
        "captionsEnabled": bool(row["captions_enabled"]),
        "captionStyle": row["caption_style"],
        "autoHook": bool(row["auto_hook"]),
        "smartReframe": bool(row["smart_reframe"]),
        "splitScreen": bool(row["split_screen"]),
        "backgroundVideo": row["background_video"],
        "status": row["status"],
        "stage": int(row["stage"]),
        "activeStepIndex": int(row["active_step_index"]),
        "progress": int(row["progress"]),
        "current_step": row["current_step"],
        "logs": json.loads(row["logs_json"] or "[]") if "logs_json" in row else [],
        "note": row["note"] or "",
        "clips": clips,
        "error": row["error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_recent_jobs(limit: int = 30) -> List[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        finally:
            conn.close()
    result: List[Dict[str, Any]] = []
    for r in rows:
        item = get_job_response(r["id"])
        if item:
            result.append(item)
    return result


# --- Phase 3 workspace API keys & webhooks helpers ---


def create_api_key(key_id: str, workspace_id: str, name: str, key_prefix: str, key_hash: str) -> Dict[str, Any]:
    now = _utc_now()
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO api_keys (id, workspace_id, name, key_prefix, key_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (key_id, workspace_id, name, key_prefix, key_hash, now),
            )
            conn.commit()
        finally:
            conn.close()
    return {
        "id": key_id,
        "workspace_id": workspace_id,
        "name": name,
        "key_prefix": key_prefix,
        "created_at": now,
        "revoked": False,
    }


def list_api_keys(workspace_id: str = "default") -> List[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id, workspace_id, name, key_prefix, created_at, last_used_at, revoked FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC",
                (workspace_id,),
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "workspace_id": r["workspace_id"],
                    "name": r["name"],
                    "key_prefix": r["key_prefix"],
                    "created_at": r["created_at"],
                    "last_used_at": r["last_used_at"],
                    "revoked": bool(r["revoked"]),
                }
                for r in rows
            ]
        finally:
            conn.close()


def revoke_api_key(key_id: str) -> bool:
    with _DB_LOCK:
        conn = _connect()
        try:
            cur = conn.execute("UPDATE api_keys SET revoked = 1 WHERE id = ?", (key_id,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def verify_api_key_hash(key_hash: str) -> Optional[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0",
                (key_hash,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
                (_utc_now(), row["id"]),
            )
            conn.commit()
            return dict(row)
        finally:
            conn.close()


def create_webhook(webhook_id: str, workspace_id: str, url: str, secret: str, events: List[str]) -> Dict[str, Any]:
    now = _utc_now()
    with _DB_LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO webhooks (id, workspace_id, url, secret, events_json, active, created_at)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                """,
                (webhook_id, workspace_id, url, secret, json.dumps(events), now),
            )
            conn.commit()
        finally:
            conn.close()
    return {
        "id": webhook_id,
        "workspace_id": workspace_id,
        "url": url,
        "events": events,
        "active": True,
        "created_at": now,
    }


def list_webhooks(workspace_id: str = "default") -> List[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at DESC",
                (workspace_id,),
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "workspace_id": r["workspace_id"],
                    "url": r["url"],
                    "secret": r["secret"],
                    "events": json.loads(r["events_json"] or "[]"),
                    "active": bool(r["active"]),
                    "created_at": r["created_at"],
                }
                for r in rows
            ]
        finally:
            conn.close()


def get_webhook_by_id(webhook_id: str) -> Optional[Dict[str, Any]]:
    with _DB_LOCK:
        conn = _connect()
        try:
            r = conn.execute("SELECT * FROM webhooks WHERE id = ?", (webhook_id,)).fetchone()
            if not r:
                return None
            return {
                "id": r["id"],
                "workspace_id": r["workspace_id"],
                "url": r["url"],
                "secret": r["secret"],
                "events": json.loads(r["events_json"] or "[]"),
                "active": bool(r["active"]),
                "created_at": r["created_at"],
            }
        finally:
            conn.close()


def delete_webhook(webhook_id: str) -> bool:
    with _DB_LOCK:
        conn = _connect()
        try:
            cur = conn.execute("DELETE FROM webhooks WHERE id = ?", (webhook_id,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

