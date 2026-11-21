from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from . import db
    from .services.auto_reframe import reframe_clip_to_vertical, render_clip_single_pass
    from .services.caption_burner import burn_captions_to_video
    from .services.downloader import (
        UPLOADS_DIR,
        download_video,
        fetch_video_metadata,
        save_uploaded_file_stream,
    )
    from .services.transcriber import transcribe_video
    from .services.translator import translate_caption_text
    from .services.viral_analyzer import (
        analyze_viral_clips,
        build_sentences,
        compute_overlap_ratio,
        extract_words_from_transcript,
    )
    from .services.webhooks import deliver_webhook_event, dispatch_job_webhooks
    from .services.youtube_auth import youtube_auth
except ImportError:
    import db
    from services.auto_reframe import reframe_clip_to_vertical, render_clip_single_pass
    from services.caption_burner import burn_captions_to_video
    from services.downloader import (
        UPLOADS_DIR,
        download_video,
        fetch_video_metadata,
        save_uploaded_file_stream,
    )
    from services.transcriber import transcribe_video
    from services.translator import translate_caption_text
    from services.viral_analyzer import (
        analyze_viral_clips,
        build_sentences,
        compute_overlap_ratio,
        extract_words_from_transcript,
    )
    from services.webhooks import deliver_webhook_event, dispatch_job_webhooks
    from services.youtube_auth import youtube_auth

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent if BACKEND_DIR.name == "backend" else BACKEND_DIR
load_dotenv(ROOT_DIR / ".env")
if BACKEND_DIR != ROOT_DIR:
    load_dotenv(BACKEND_DIR / ".env")

OUTPUTS_DIR = ROOT_DIR / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

TEMP_DOWNLOADS_DIR = ROOT_DIR / "temp" / "downloads"
TEMP_DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

MAX_CONCURRENT_JOBS = max(1, int(os.environ.get("MAX_CONCURRENT_JOBS", "2")))
MAX_RENDER_WORKERS = max(1, int(os.environ.get("MAX_RENDER_WORKERS", "2")))
JOB_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_JOBS, thread_name_prefix="scalereach-job")
_ACTIVE_JOBS_LOCK = threading.Lock()
_ACTIVE_JOB_IDS: set[str] = set()
_JOB_API_KEY_OVERRIDES: Dict[str, str] = {}

app = FastAPI(title="Scalereach AI Video Backend", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


class FetchVideoRequest(BaseModel):
    url: str
    download: bool = False


class TranscribeRequest(BaseModel):
    video_path: str
    language: Optional[str] = None


class AnalyzeViralRequest(BaseModel):
    transcript: Any
    video_title: str = "Creator Video"
    preset: str = "Viral Clips"
    language: str = "Auto"
    duration_range: str = "Auto"
    total_duration_sec: Optional[float] = None
    start_bound: float = 0.0
    end_bound: Optional[float] = None
    max_clips: Optional[int] = None
    audio_path: Optional[str] = None


class ReframeClipRequest(BaseModel):
    source_video: str
    start_time: float
    end_time: float
    clip_id: int = 1
    rolling_window: int = 15


class GenerateRequest(BaseModel):
    url: str
    videoTitle: Optional[str] = None
    platform: Optional[str] = "YouTube"
    thumbnailUrl: Optional[str] = ""
    durationSec: Optional[float] = 0.0
    clipType: str = "Templates"
    preset: str = "Viral Clips"
    captionsEnabled: bool = True
    captionStyle: str = "classic"
    autoHook: bool = True
    smartReframe: bool = True
    aiMusic: bool = False
    durationRange: str = "Auto"
    aspectRatio: str = "9:16 Portrait"
    language: str = "Auto"
    splitScreen: bool = False
    backgroundVideo: str = "All"
    maxClips: Optional[int] = None
    startSec: float = 0.0
    endSec: float = 0.0
    ownsRights: bool = True
    webhookUrl: Optional[str] = None


class NoteUpdate(BaseModel):
    note: str


class ClipUpdate(BaseModel):
    title: Optional[str] = None
    favorite: Optional[bool] = None


class ClipRenderRequest(BaseModel):
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None
    edited_caption_text: Optional[str] = None
    caption_style: Optional[str] = None
    aspect_ratio: Optional[str] = None
    title: Optional[str] = None
    hook_title: Optional[str] = None
    auto_hook: Optional[bool] = None
    smart_reframe: Optional[bool] = None
    split_screen: Optional[bool] = None
    background_video: Optional[str] = None
    language: Optional[str] = None


class ClipExtendRequest(BaseModel):
    delta_start_sec: float = 0.0
    delta_end_sec: float = 0.0
    snap_to_sentence: bool = True


class ClipTranslateRequest(BaseModel):
    target_language: str = Field(min_length=2, max_length=60)


class CreateApiKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    workspace_id: str = "default"


class CreateWebhookRequest(BaseModel):
    url: str = Field(min_length=8, max_length=500)
    events: List[str] = Field(default_factory=lambda: ["job.completed", "job.failed"])
    secret: Optional[str] = None
    workspace_id: str = "default"


def _format_clip_duration(start_time: float, end_time: float) -> str:
    total = max(1, int(round(end_time - start_time)))
    mins, secs = divmod(total, 60)
    return f"{mins}:{secs:02d}"


def _submit_job_to_pool(job_id: str, api_key_override: Optional[str] = None) -> None:
    with _ACTIVE_JOBS_LOCK:
        if api_key_override and api_key_override.strip():
            _JOB_API_KEY_OVERRIDES[job_id] = api_key_override.strip()
        if job_id in _ACTIVE_JOB_IDS:
            return
        _ACTIVE_JOB_IDS.add(job_id)
    JOB_EXECUTOR.submit(run_complete_pipeline, job_id)


def _cleanup_job_scratch_files(work_dir: Path, source_video: Optional[Path] = None) -> None:
    """
    Clean up temporary audio extractions, whisper chunks, and subtitle scratch files
    so Cloud Run / ephemeral containers stay lean without breaking local re-render.
    Set CLEANUP_RAW_SOURCE=true on Cloud Run to also remove downloaded raw source video.
    """
    if work_dir.exists():
        for ext in ("*.wav", "*.vtt", "*.srt", "*.part", "*.ytdl"):
            for p in work_dir.glob(ext):
                try:
                    p.unlink()
                except OSError:
                    pass
    cleanup_raw = os.environ.get("CLEANUP_RAW_SOURCE", "").strip().lower() in {"1", "true", "yes"}
    if cleanup_raw and source_video and source_video.exists():
        try:
            # Only remove downloaded copies inside temp/jobs, never user uploads unless configured
            if work_dir in source_video.parents:
                source_video.unlink()
        except OSError:
            pass


@app.on_event("startup")
def _on_startup() -> None:
    db.init_db()
    db.mark_interrupted_jobs()
    for queued in db.list_queued_jobs():
        _submit_job_to_pool(queued["id"])


def run_complete_pipeline(job_id: str) -> None:
    """
    Full persisted ScaleReach pipeline running inside the ThreadPoolExecutor worker pool:
      queued -> downloading -> transcribing -> analyzing -> tracking -> rendering -> completed | failed
    """
    job_dir = OUTPUTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    work_dir = ROOT_DIR / "temp" / "jobs" / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    with _ACTIVE_JOBS_LOCK:
        api_key_override = _JOB_API_KEY_OVERRIDES.get(job_id)

    source_video: Optional[Path] = None
    try:
        job_row = db.get_job_row(job_id)
        if not job_row:
            return

        # 1. Downloading & ffprobe validation (6% -> 25%)
        db.update_job(
            job_id,
            status="downloading",
            stage=1,
            active_step_index=0,
            progress=6,
            current_step="Downloading Source Video (yt-dlp)",
            error=None,
        )
        db.append_job_log(job_id, "Starting download & ffprobe validation (yt-dlp)...")

        def _on_download_progress(frac: float) -> None:
            pct = 6 + int(round(max(0.0, min(1.0, frac)) * 18))
            db.update_job(job_id, progress=pct)

        downloaded = download_video(
            job_row["url"],
            output_dir=work_dir,
            progress_callback=_on_download_progress,
        )
        source_video = Path(downloaded["file_path"])
        video_title = (
            job_row["video_title"]
            if job_row["video_title"] and job_row["video_title"] != "Processing Video"
            else downloaded.get("title") or "Creator Video"
        )
        total_duration_sec = float(downloaded.get("duration_sec") or 0.0)
        db.append_job_log(
            job_id,
            f"Source ready: {video_title} ({_format_clip_duration(0, total_duration_sec) if total_duration_sec else 'verified'})",
        )

        # 2. Transcription via faster-whisper (26% -> 52%)
        db.update_job(
            job_id,
            source_path=str(source_video),
            video_title=video_title,
            platform=downloaded.get("platform") or job_row["platform"] or "Video",
            thumbnail_url=downloaded.get("thumbnail") or job_row["thumbnail_url"] or "",
            duration_sec=total_duration_sec,
            status="transcribing",
            stage=2,
            active_step_index=1,
            progress=26,
            current_step="Word-Level Transcription (faster-whisper)",
        )
        db.append_job_log(job_id, "Running word-level speech transcription (faster-whisper)...")

        def _on_transcribe_progress(frac: float) -> None:
            pct = 26 + int(round(max(0.0, min(1.0, frac)) * 25))
            db.update_job(job_id, progress=pct)

        transcript_result = transcribe_video(
            source_video,
            language=job_row["language"],
            audio_output_dir=work_dir,
            fallback_subtitles_path=downloaded.get("subtitles_path"),
            progress_callback=_on_transcribe_progress,
        )
        all_words = extract_words_from_transcript(transcript_result)
        sentences = build_sentences(all_words)
        transcript_result["sentences"] = sentences
        detected_lang = str(transcript_result.get("language") or job_row["language"] or "en")
        db.append_job_log(
            job_id,
            f"Transcribed {len(all_words)} words across {len(sentences)} sentences (lang={detected_lang})",
        )

        db.save_transcript(
            job_id,
            language=detected_lang,
            language_probability=float(transcript_result.get("language_probability") or 1.0),
            source=str(transcript_result.get("source") or "faster-whisper"),
            full_text=str(transcript_result.get("transcript") or ""),
            segments=transcript_result.get("segments") or [],
            words=all_words,
            sentences=sentences,
            audio_path=transcript_result.get("audio_path"),
        )

        # 3. Multi-pass viral moment analysis (53% -> 72%)
        db.update_job(
            job_id,
            status="analyzing",
            stage=3,
            active_step_index=2,
            progress=53,
            current_step="Viral Hook & Story Detection (Gemini API)",
        )
        db.append_job_log(job_id, "Detecting viral hooks, complete story arcs & scoring candidates (Gemini)...")

        def _on_analyze_progress(frac: float) -> None:
            pct = 53 + int(round(max(0.0, min(1.0, frac)) * 18))
            db.update_job(job_id, progress=pct)

        end_bound = float(job_row["end_bound"] or 0.0)
        viral_clips = analyze_viral_clips(
            transcript_data=transcript_result,
            video_title=video_title,
            preset=job_row["clip_preset"] or "Viral Clips",
            language=job_row["language"] or "Auto",
            duration_range=job_row["duration_range"] or "Auto",
            total_duration_sec=total_duration_sec or None,
            start_bound=float(job_row["start_bound"] or 0.0),
            end_bound=end_bound if end_bound > 0 else None,
            max_clips=job_row["max_clips"],
            audio_path=transcript_result.get("audio_path"),
            progress_callback=_on_analyze_progress,
            api_key_override=api_key_override,
        )
        db.append_job_log(job_id, f"Selected {len(viral_clips)} high-retention viral moments")

        clip_records_to_insert: List[Dict[str, Any]] = []
        for idx, clip in enumerate(viral_clips):
            start_t = float(clip["start_time"])
            end_t = float(clip["end_time"])
            clip_records_to_insert.append(
                {
                    "tag": f"#{idx + 1}",
                    "title": clip["title"],
                    "hook_title": clip.get("hook_title") or clip["title"],
                    "description": clip.get("description") or clip.get("score_reason") or "",
                    "hashtags": clip.get("hashtags") or [],
                    "hook_reason": clip.get("hook_reason") or clip.get("score_reason") or "",
                    "start_sec": start_t,
                    "end_sec": end_t,
                    "duration_str": _format_clip_duration(start_t, end_t),
                    "virality_score": int(clip["virality_score"]),
                    "sub_scores": clip.get("sub_scores") or {},
                    "score_reason": clip.get("score_reason") or "",
                    "transcript": clip.get("transcript_text") or "",
                    "caption_style": job_row["caption_style"] or "classic",
                    "aspect_ratio": job_row["aspect_ratio"] or "9:16 Portrait",
                    "language": detected_lang,
                    "status": "rendering",
                    "progress": 10,
                }
            )

        stored_clips = db.replace_job_clips(job_id, clip_records_to_insert)

        # 4. Active speaker face tracking + single-pass FFmpeg rendering (73% -> 99%)
        db.update_job(
            job_id,
            status="tracking",
            stage=4,
            active_step_index=3,
            progress=74,
            current_step="Active Speaker Face Tracking (MediaPipe)",
        )
        db.append_job_log(
            job_id,
            f"Tracking active speakers & framing {len(stored_clips)} clips ({job_row['aspect_ratio'] or '9:16 Portrait'})...",
        )

        total_clips = max(1, len(stored_clips))
        completed_counter = {"count": 0}
        started_render = {"flagged": False}
        counter_lock = threading.Lock()

        def _render_single_clip_worker(idx: int, clip_rec: Dict[str, Any]) -> None:
            db.update_clip_by_db_id(clip_rec["id"], status="rendering", progress=30)
            start_t = float(clip_rec["start_sec"])
            end_t = float(clip_rec["end_sec"])
            final_filename = f"clip_{idx + 1}.mp4"
            thumb_filename = f"clip_{idx + 1}_thumb.jpg"
            final_mp4 = job_dir / final_filename
            thumb_jpg = job_dir / thumb_filename

            with counter_lock:
                if not started_render["flagged"]:
                    started_render["flagged"] = True
                    db.update_job(
                        job_id,
                        status="rendering",
                        stage=5,
                        active_step_index=4,
                        progress=80,
                        current_step="9:16 Rendering & Animated Captions (FFmpeg)",
                    )
                    db.append_job_log(
                        job_id,
                        f"Encoding clips with animated {clip_rec['caption_style'] or 'classic'} captions (FFmpeg)...",
                    )

            render_info = render_clip_single_pass(
                source_video=source_video,
                start_time=start_t,
                end_time=end_t,
                output_path=final_mp4,
                words=all_words,
                aspect_ratio=clip_rec.get("aspect_ratio") or job_row["aspect_ratio"] or "9:16 Portrait",
                smart_reframe=bool(job_row["smart_reframe"]),
                split_screen=bool(job_row["split_screen"]),
                background_video=str(job_row["background_video"] or "All"),
                captions_enabled=bool(job_row["captions_enabled"]),
                caption_style=clip_rec["caption_style"] or job_row["caption_style"] or "classic",
                auto_hook=bool(job_row["auto_hook"]),
                hook_title=clip_rec["hook_title"] or clip_rec["title"],
                language=detected_lang,
                fallback_transcript=clip_rec["transcript"] or "",
                edited_caption_text=clip_rec.get("edited_caption_text"),
                thumbnail_path=thumb_jpg,
            )

            video_url = f"/outputs/{job_id}/{final_filename}"
            thumb_url = f"/outputs/{job_id}/{thumb_filename}" if render_info.get("thumbnail_path") else None
            download_url = f"/api/jobs/{job_id}/clips/{clip_rec['id']}/download"
            db.update_clip_by_db_id(
                clip_rec["id"],
                status="ready",
                progress=100,
                video_path=str(final_mp4),
                video_url=video_url,
                thumbnail_path=render_info.get("thumbnail_path"),
                thumbnail_url=thumb_url,
                download_url=download_url,
            )

            with counter_lock:
                completed_counter["count"] += 1
                done_now = completed_counter["count"]
                overall_pct = min(99, 80 + int(round((done_now / total_clips) * 19)))
                db.update_job(
                    job_id,
                    status="rendering",
                    stage=5,
                    active_step_index=4,
                    progress=overall_pct,
                    current_step=f"Rendered {done_now} of {total_clips} clips ({render_info.get('framing_mode', 'reframed')})",
                )
                db.append_job_log(
                    job_id,
                    f"Clip #{idx + 1} ready ({render_info.get('width')}x{render_info.get('height')}, {render_info.get('framing_mode')})",
                )

        render_workers = max(1, min(MAX_RENDER_WORKERS, len(stored_clips)))
        with ThreadPoolExecutor(max_workers=render_workers, thread_name_prefix=f"render-{job_id}") as render_pool:
            futures = [
                render_pool.submit(_render_single_clip_worker, idx, clip_rec)
                for idx, clip_rec in enumerate(stored_clips)
            ]
            for fut in futures:
                fut.result()

        _cleanup_job_scratch_files(work_dir, source_video=source_video)

        db.update_job(
            job_id,
            status="completed",
            stage=5,
            active_step_index=4,
            progress=100,
            current_step="Clips ready",
            error=None,
        )
        db.append_job_log(job_id, f"Pipeline complete: {len(stored_clips)} viral clips ready.")
        completed_payload = db.get_job_response(job_id)
        if completed_payload:
            dispatch_job_webhooks(
                "job.completed",
                completed_payload,
                extra_webhook_url=job_row.get("webhook_url"),
            )
    except Exception as exc:
        db.append_job_log(job_id, f"Error: {exc}")
        db.update_job(
            job_id,
            status="failed",
            current_step="Pipeline failed",
            error=str(exc),
        )
        failed_payload = db.get_job_response(job_id)
        if failed_payload:
            job_snapshot = db.get_job_row(job_id) or {}
            dispatch_job_webhooks(
                "job.failed",
                failed_payload,
                extra_webhook_url=job_snapshot.get("webhook_url"),
            )
    finally:
        with _ACTIVE_JOBS_LOCK:
            _ACTIVE_JOB_IDS.discard(job_id)
            _JOB_API_KEY_OVERRIDES.pop(job_id, None)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "engine": "fastapi-scalereach",
        "version": "3.0.0",
        "pythonConnected": True,
        "workers": MAX_CONCURRENT_JOBS,
        "pipeline": ["yt-dlp", "faster-whisper", "gemini", "mediapipe", "ffmpeg"],
    }


@app.get("/api/youtube/auth/status")
def youtube_auth_status() -> Dict[str, Any]:
    return youtube_auth.get_status()


@app.post("/api/youtube/auth/start")
def youtube_auth_start() -> Dict[str, Any]:
    try:
        return youtube_auth.start_device_auth()
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not start YouTube verification: {exc}",
        ) from exc


@app.post("/api/youtube/auth/disconnect")
def youtube_auth_disconnect() -> Dict[str, Any]:
    return youtube_auth.disconnect()


@app.post("/api/upload-video")
async def upload_video_endpoint(video: UploadFile = File(...)) -> Dict[str, Any]:
    try:
        return save_uploaded_file_stream(video.file, video.filename or "video.mp4", UPLOADS_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Video upload failed: {exc}") from exc
    finally:
        await video.close()


@app.post("/api/fetch-video")
def fetch_video(req: FetchVideoRequest) -> Dict[str, Any]:
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="Video URL is required.")
    try:
        if req.download:
            return download_video(url, TEMP_DOWNLOADS_DIR)
        return fetch_video_metadata(url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not fetch video metadata: {exc}") from exc


@app.post("/api/videos/inspect")
def inspect_video(req: FetchVideoRequest) -> Dict[str, Any]:
    return fetch_video(req)


@app.post("/api/transcribe")
def transcribe_endpoint(req: TranscribeRequest) -> Dict[str, Any]:
    try:
        return transcribe_video(req.video_path, language=req.language)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc


@app.post("/api/analyze-viral")
def analyze_viral_endpoint(req: AnalyzeViralRequest) -> List[Dict[str, Any]]:
    try:
        return analyze_viral_clips(
            transcript_data=req.transcript,
            video_title=req.video_title,
            preset=req.preset,
            language=req.language,
            duration_range=req.duration_range,
            total_duration_sec=req.total_duration_sec,
            start_bound=req.start_bound,
            end_bound=req.end_bound,
            max_clips=req.max_clips,
            audio_path=req.audio_path,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Viral clip analysis failed: {exc}") from exc


@app.post("/api/reframe-clip")
def reframe_clip_endpoint(req: ReframeClipRequest) -> Dict[str, Any]:
    try:
        return reframe_clip_to_vertical(
            source_video=req.source_video,
            start_time=req.start_time,
            end_time=req.end_time,
            clip_id=req.clip_id,
            rolling_window=req.rolling_window,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Auto-reframe failed: {exc}") from exc


def _parse_bool_flag(raw: Any, default: bool = True) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


@app.post("/api/generate-clips")
def generate_clips_endpoint(
    req: GenerateRequest,
    x_gemini_api_key: Optional[str] = Header(default=None, alias="X-Gemini-Api-Key"),
) -> Dict[str, Any]:
    clean_url = req.url.strip()
    if not clean_url:
        raise HTTPException(status_code=400, detail="Video URL or uploaded file path is required.")
    if not clean_url.startswith("/uploads/") and not req.ownsRights:
        raise HTTPException(
            status_code=400,
            detail="You must confirm that you own the rights to process this video URL.",
        )

    job_id = uuid.uuid4().hex[:12]
    db.create_job(job_id, req.model_dump())
    _submit_job_to_pool(job_id, api_key_override=x_gemini_api_key)
    return {"job_id": job_id, "jobId": job_id, "status": "queued"}


@app.post("/api/process-video")
async def process_video_endpoint(
    request: Request,
    x_gemini_api_key: Optional[str] = Header(default=None, alias="X-Gemini-Api-Key"),
) -> Dict[str, Any]:
    """
    Unified ScaleReach Cloud Run entrypoint accepting EITHER:
      - `application/json` with `{ url, durationRange, aspectRatio, captionStyle, ... }`
      - `multipart/form-data` with uploaded `file`/`video` OR form field `url` + options
    Optional `X-Gemini-Api-Key` header overrides the server GEMINI_API_KEY in memory only.
    """
    content_type = (request.headers.get("content-type") or "").lower()
    payload: Dict[str, Any] = {}

    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        upload = form.get("file") or form.get("video")
        if upload is not None and hasattr(upload, "file"):
            try:
                saved = save_uploaded_file_stream(
                    upload.file,
                    getattr(upload, "filename", None) or "video.mp4",
                    UPLOADS_DIR,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            finally:
                if hasattr(upload, "close"):
                    await upload.close()
            payload["url"] = saved["url"]
            payload["videoTitle"] = str(form.get("videoTitle") or saved.get("title") or "Uploaded Video")
            payload["platform"] = "Local Upload"
            payload["durationSec"] = float(saved.get("duration_sec") or 0.0)
            payload["ownsRights"] = True
        else:
            payload["url"] = str(form.get("url") or "").strip()
            payload["videoTitle"] = str(form.get("videoTitle") or "").strip() or None
            payload["platform"] = str(form.get("platform") or "YouTube")
            payload["ownsRights"] = _parse_bool_flag(form.get("ownsRights"), True)

        payload["durationRange"] = str(form.get("durationRange") or form.get("duration_range") or "Auto")
        payload["aspectRatio"] = str(form.get("aspectRatio") or form.get("aspect_ratio") or "9:16 Portrait")
        payload["captionStyle"] = str(form.get("captionStyle") or form.get("caption_style") or "hormozi")
        payload["language"] = str(form.get("language") or "Auto")
        payload["preset"] = str(form.get("preset") or "Viral Clips")
        payload["captionsEnabled"] = _parse_bool_flag(form.get("captionsEnabled"), True)
        payload["autoHook"] = _parse_bool_flag(form.get("autoHook"), True)
        payload["smartReframe"] = _parse_bool_flag(form.get("smartReframe"), True)
        payload["splitScreen"] = _parse_bool_flag(form.get("splitScreen"), False)
        payload["backgroundVideo"] = str(form.get("backgroundVideo") or "All")
        raw_max = form.get("maxClips")
        if raw_max is not None and str(raw_max).strip().isdigit():
            payload["maxClips"] = int(str(raw_max).strip())
        if not x_gemini_api_key and form.get("apiKey"):
            x_gemini_api_key = str(form.get("apiKey")).strip()
    else:
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Expected JSON body or multipart form data.") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Request payload must be a JSON object.")
        payload = dict(body)
        if not x_gemini_api_key and isinstance(body.get("apiKey"), str):
            x_gemini_api_key = body.get("apiKey", "").strip()

    req = GenerateRequest(
        url=str(payload.get("url") or "").strip(),
        videoTitle=payload.get("videoTitle"),
        platform=str(payload.get("platform") or "YouTube"),
        thumbnailUrl=str(payload.get("thumbnailUrl") or ""),
        durationSec=float(payload.get("durationSec") or 0.0),
        preset=str(payload.get("preset") or "Viral Clips"),
        captionsEnabled=_parse_bool_flag(payload.get("captionsEnabled"), True),
        captionStyle=str(payload.get("captionStyle") or payload.get("caption_style") or "hormozi"),
        autoHook=_parse_bool_flag(payload.get("autoHook"), True),
        smartReframe=_parse_bool_flag(payload.get("smartReframe"), True),
        durationRange=str(payload.get("durationRange") or payload.get("duration_range") or "Auto"),
        aspectRatio=str(payload.get("aspectRatio") or payload.get("aspect_ratio") or "9:16 Portrait"),
        language=str(payload.get("language") or "Auto"),
        splitScreen=_parse_bool_flag(payload.get("splitScreen"), False),
        backgroundVideo=str(payload.get("backgroundVideo") or "All"),
        maxClips=payload.get("maxClips"),
        startSec=float(payload.get("startSec") or 0.0),
        endSec=float(payload.get("endSec") or 0.0),
        ownsRights=_parse_bool_flag(payload.get("ownsRights"), True),
        webhookUrl=payload.get("webhookUrl"),
    )
    return generate_clips_endpoint(req, x_gemini_api_key=x_gemini_api_key)


@app.post("/api/clips/generate")
def generate_clips_legacy(
    req: GenerateRequest,
    x_gemini_api_key: Optional[str] = Header(default=None, alias="X-Gemini-Api-Key"),
) -> Dict[str, Any]:
    return generate_clips_endpoint(req, x_gemini_api_key=x_gemini_api_key)


@app.get("/api/jobs")
def list_jobs_endpoint() -> Dict[str, Any]:
    return {"jobs": db.list_recent_jobs(limit=30)}


@app.get("/api/job-status/{job_id}")
def get_job_status(job_id: str) -> Dict[str, Any]:
    job = db.get_job_response(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/status/{job_id}")
def get_job_status_alias(job_id: str) -> Dict[str, Any]:
    return get_job_status(job_id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    return get_job_status(job_id)


@app.patch("/api/jobs/{job_id}/note")
def update_note(job_id: str, body: NoteUpdate) -> Dict[str, Any]:
    job = db.get_job_row(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    db.update_job(job_id, note=body.note)
    return {"ok": True, "note": body.note}


@app.patch("/api/jobs/{job_id}/clips/{clip_id}")
def update_clip(job_id: str, clip_id: int, body: ClipUpdate) -> Dict[str, Any]:
    clip = db.find_clip_for_job(job_id, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found.")
    patch: Dict[str, Any] = {}
    if body.title is not None:
        patch["title"] = body.title
    if body.favorite is not None:
        patch["favorite"] = body.favorite
    updated = db.update_clip_by_db_id(clip["id"], **patch)
    if not updated:
        raise HTTPException(status_code=404, detail="Clip not found.")
    return updated


@app.delete("/api/jobs/{job_id}/clips/{clip_id}")
def delete_clip(job_id: str, clip_id: int) -> Dict[str, Any]:
    deleted = db.delete_clip_for_job(job_id, clip_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Clip not found.")
    return {"ok": True}


@app.get("/api/jobs/{job_id}/clips/{clip_id}/download")
def download_clip(job_id: str, clip_id: int) -> FileResponse:
    clip = db.find_clip_for_job(job_id, clip_id)
    file_path: Optional[Path] = None
    if clip and clip.get("video_path"):
        candidate = Path(clip["video_path"])
        if candidate.exists():
            file_path = candidate
    if file_path is None:
        fallback = OUTPUTS_DIR / job_id / f"clip_{clip_id + 1}.mp4"
        if fallback.exists():
            file_path = fallback
    if file_path is None or not file_path.exists():
        raise HTTPException(status_code=404, detail="Rendered clip file not found.")
    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=f"scalereach_{job_id}_{file_path.name}",
    )


# ---------------------------------------------------------------------------
# Phase 3: Re-render, Extend (+/-10s), Regenerate, Translate, ZIP export,
#          Workspace API Keys & Webhooks
# ---------------------------------------------------------------------------


def _slice_transcript_for_window(
    words: List[Dict[str, Any]],
    sentences: List[Dict[str, Any]],
    start_sec: float,
    end_sec: float,
) -> str:
    if words:
        sliced = [
            str(w.get("word") or "").strip()
            for w in words
            if float(w.get("end", 0.0)) >= start_sec and float(w.get("start", 0.0)) <= end_sec
        ]
        joined = " ".join(tok for tok in sliced if tok).strip()
        if joined:
            return joined
    if sentences:
        sliced_s = [
            str(s.get("text") or "").strip()
            for s in sentences
            if float(s.get("end", 0.0)) >= start_sec and float(s.get("start", 0.0)) <= end_sec
        ]
        return " ".join(t for t in sliced_s if t).strip()
    return ""


def _rerender_clip_record(
    clip_rec: Dict[str, Any],
    job_row: Dict[str, Any],
    transcript: Optional[Dict[str, Any]],
    *,
    start_sec: Optional[float] = None,
    end_sec: Optional[float] = None,
    edited_caption_text: Any = ...,
    caption_style: Optional[str] = None,
    aspect_ratio: Optional[str] = None,
    title: Optional[str] = None,
    hook_title: Optional[str] = None,
    auto_hook: Optional[bool] = None,
    smart_reframe: Optional[bool] = None,
    split_screen: Optional[bool] = None,
    background_video: Optional[str] = None,
    language: Optional[str] = None,
    extra_updates: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    source_path_str = job_row.get("source_path")
    if not source_path_str:
        raise HTTPException(status_code=400, detail="Source video file is unavailable for re-rendering.")
    source_video = Path(source_path_str)
    if not source_video.exists():
        raise HTTPException(status_code=404, detail="Source video file no longer exists on disk.")

    job_id = str(clip_rec["job_id"])
    clip_db_id = int(clip_rec["id"])
    clip_num = int(clip_rec.get("clip_index", 0)) + 1

    video_dur = float(job_row.get("duration_sec") or 0.0)
    new_start = float(clip_rec["start_sec"] if start_sec is None else start_sec)
    new_end = float(clip_rec["end_sec"] if end_sec is None else end_sec)
    new_start = max(0.0, new_start)
    if video_dur > 0:
        new_end = min(video_dur, new_end)
    if new_end <= new_start + 0.8:
        raise HTTPException(status_code=400, detail="Clip end_sec must be at least 0.8s after start_sec.")

    new_title = title.strip() if isinstance(title, str) and title.strip() else str(clip_rec["title"])
    new_hook = (
        hook_title.strip()
        if isinstance(hook_title, str) and hook_title.strip()
        else str(clip_rec.get("hook_title") or new_title)
    )
    new_style = caption_style or str(clip_rec.get("caption_style") or job_row.get("caption_style") or "classic")
    new_aspect = aspect_ratio or str(clip_rec.get("aspect_ratio") or job_row.get("aspect_ratio") or "9:16 Portrait")
    new_lang = language or str(clip_rec.get("language") or (transcript or {}).get("language") or job_row.get("language") or "Auto")
    use_auto_hook = bool(job_row.get("auto_hook", 1)) if auto_hook is None else bool(auto_hook)
    use_smart_reframe = bool(job_row.get("smart_reframe", 1)) if smart_reframe is None else bool(smart_reframe)
    use_split_screen = bool(job_row.get("split_screen", 0)) if split_screen is None else bool(split_screen)
    use_bg_video = background_video or str(job_row.get("background_video") or "All")

    all_words = (transcript or {}).get("words") or []
    all_sentences = (transcript or {}).get("sentences") or []

    if edited_caption_text is ...:
        new_edited_caption = clip_rec.get("edited_caption_text")
    elif edited_caption_text is None:
        new_edited_caption = None
    else:
        cleaned = str(edited_caption_text).strip()
        new_edited_caption = cleaned if cleaned else None

    raw_transcript = str(clip_rec.get("raw_transcript") or clip_rec.get("transcript") or "")
    if start_sec is not None or end_sec is not None:
        sliced = _slice_transcript_for_window(all_words, all_sentences, new_start, new_end)
        if sliced:
            raw_transcript = sliced

    job_dir = OUTPUTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    final_filename = f"clip_{clip_num}.mp4"
    thumb_filename = f"clip_{clip_num}_thumb.jpg"
    final_mp4 = job_dir / final_filename
    thumb_jpg = job_dir / thumb_filename

    db.update_clip_by_db_id(clip_db_id, status="rendering", progress=35)
    try:
        render_info = render_clip_single_pass(
            source_video=source_video,
            start_time=new_start,
            end_time=new_end,
            output_path=final_mp4,
            words=all_words,
            aspect_ratio=new_aspect,
            smart_reframe=use_smart_reframe,
            split_screen=use_split_screen,
            background_video=use_bg_video,
            captions_enabled=bool(job_row.get("captions_enabled", 1)),
            caption_style=new_style,
            auto_hook=use_auto_hook,
            hook_title=new_hook,
            language=new_lang,
            fallback_transcript=raw_transcript,
            edited_caption_text=new_edited_caption,
            thumbnail_path=thumb_jpg,
        )
    except Exception as exc:
        db.update_clip_by_db_id(clip_db_id, status="ready", progress=100)
        raise HTTPException(status_code=500, detail=f"Clip re-render failed: {exc}") from exc

    cache_bust = int(time.time() * 1000)
    video_url = f"/outputs/{job_id}/{final_filename}?v={cache_bust}"
    thumb_url = (
        f"/outputs/{job_id}/{thumb_filename}?v={cache_bust}"
        if render_info.get("thumbnail_path")
        else clip_rec.get("thumbnail_url")
    )
    download_url = f"/api/jobs/{job_id}/clips/{clip_db_id}/download"

    patch: Dict[str, Any] = {
        "title": new_title,
        "hook_title": new_hook,
        "start_sec": round(new_start, 3),
        "end_sec": round(new_end, 3),
        "duration_str": _format_clip_duration(new_start, new_end),
        "transcript": raw_transcript,
        "edited_caption_text": new_edited_caption,
        "caption_style": new_style,
        "aspect_ratio": new_aspect,
        "language": new_lang,
        "status": "ready",
        "progress": 100,
        "video_path": str(final_mp4),
        "video_url": video_url,
        "thumbnail_path": render_info.get("thumbnail_path"),
        "thumbnail_url": thumb_url,
        "download_url": download_url,
    }
    if extra_updates:
        patch.update(extra_updates)

    updated = db.update_clip_by_db_id(clip_db_id, **patch)
    if not updated:
        raise HTTPException(status_code=404, detail="Clip not found after update.")
    return updated


@app.post("/api/clips/{clip_id}/render")
def rerender_clip_endpoint(clip_id: int, body: ClipRenderRequest) -> Dict[str, Any]:
    clip_rec = db.get_clip_by_id(clip_id)
    if not clip_rec:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job_row = db.get_job_row(str(clip_rec["job_id"]))
    if not job_row:
        raise HTTPException(status_code=404, detail="Parent job not found.")
    transcript = db.get_transcript(str(clip_rec["job_id"]))

    return _rerender_clip_record(
        clip_rec,
        job_row,
        transcript,
        start_sec=body.start_sec,
        end_sec=body.end_sec,
        edited_caption_text=body.edited_caption_text if body.edited_caption_text is not None else ...,
        caption_style=body.caption_style,
        aspect_ratio=body.aspect_ratio,
        title=body.title,
        hook_title=body.hook_title,
        auto_hook=body.auto_hook,
        smart_reframe=body.smart_reframe,
        split_screen=body.split_screen,
        background_video=body.background_video,
        language=body.language,
    )


@app.post("/api/clips/{clip_id}/extend")
def extend_clip_endpoint(clip_id: int, body: ClipExtendRequest) -> Dict[str, Any]:
    clip_rec = db.get_clip_by_id(clip_id)
    if not clip_rec:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job_row = db.get_job_row(str(clip_rec["job_id"]))
    if not job_row:
        raise HTTPException(status_code=404, detail="Parent job not found.")
    transcript = db.get_transcript(str(clip_rec["job_id"]))

    video_dur = float(job_row.get("duration_sec") or 0.0)
    cur_start = float(clip_rec["start_sec"])
    cur_end = float(clip_rec["end_sec"])

    target_start = max(0.0, cur_start + float(body.delta_start_sec))
    target_end = cur_end + float(body.delta_end_sec)
    if video_dur > 0:
        target_end = min(video_dur, target_end)

    sentences = (transcript or {}).get("sentences") or []
    if body.snap_to_sentence and sentences:
        if body.delta_start_sec != 0.0:
            nearest_start = min(sentences, key=lambda s: abs(float(s["start"]) - target_start))
            snapped = max(0.0, float(nearest_start["start"]) - 0.3)
            if (body.delta_start_sec < 0 and snapped < cur_start) or (
                body.delta_start_sec > 0 and snapped > cur_start
            ):
                target_start = snapped
        if body.delta_end_sec != 0.0:
            nearest_end = min(sentences, key=lambda s: abs(float(s["end"]) - target_end))
            snapped = float(nearest_end["end"]) + 0.5
            if video_dur > 0:
                snapped = min(video_dur, snapped)
            if (body.delta_end_sec > 0 and snapped > cur_end) or (
                body.delta_end_sec < 0 and snapped < cur_end
            ):
                target_end = snapped

    if target_end <= target_start + 1.0:
        raise HTTPException(
            status_code=400,
            detail="Cannot shrink clip below 1 second. Try extending instead.",
        )

    return _rerender_clip_record(
        clip_rec,
        job_row,
        transcript,
        start_sec=target_start,
        end_sec=target_end,
        edited_caption_text=None if not clip_rec.get("edited_caption_text") else clip_rec.get("edited_caption_text"),
    )


@app.post("/api/clips/{clip_id}/regenerate")
def regenerate_clip_endpoint(clip_id: int) -> Dict[str, Any]:
    clip_rec = db.get_clip_by_id(clip_id)
    if not clip_rec:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job_id = str(clip_rec["job_id"])
    job_row = db.get_job_row(job_id)
    if not job_row:
        raise HTTPException(status_code=404, detail="Parent job not found.")
    transcript = db.get_transcript(job_id)
    if not transcript or not (transcript.get("words") or transcript.get("segments")):
        raise HTTPException(
            status_code=400,
            detail="Stored transcript is unavailable for this job, so the clip cannot be regenerated.",
        )

    existing_clips = db.get_clips_for_job(job_id)
    other_clips = [c for c in existing_clips if int(c["id"]) != int(clip_rec["id"])]
    current_interval = (float(clip_rec["start_sec"]), float(clip_rec["end_sec"]))

    end_bound = float(job_row.get("end_bound") or 0.0)
    try:
        candidates = analyze_viral_clips(
            transcript_data=transcript,
            video_title=str(job_row.get("video_title") or "Creator Video"),
            preset=str(job_row.get("clip_preset") or "Viral Clips"),
            language=str(job_row.get("language") or "Auto"),
            duration_range=str(job_row.get("duration_range") or "Auto"),
            total_duration_sec=float(job_row.get("duration_sec") or 0.0) or None,
            start_bound=float(job_row.get("start_bound") or 0.0),
            end_bound=end_bound if end_bound > 0 else None,
            max_clips=max(len(existing_clips) + 4, 8),
            audio_path=transcript.get("audio_path"),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Clip regeneration analysis failed: {exc}") from exc

    if not candidates:
        raise HTTPException(status_code=422, detail="No alternative viral moments found in this video.")

    def _overlaps_any(cand: Dict[str, Any], intervals: List[tuple[float, float]]) -> bool:
        cs = float(cand["start_time"])
        ce = float(cand["end_time"])
        return any(compute_overlap_ratio(cs, ce, os_, oe_) > 0.30 for os_, oe_ in intervals)

    other_intervals = [(float(c["start_sec"]), float(c["end_sec"])) for c in other_clips]
    all_intervals = other_intervals + [current_interval]

    # Prefer a fresh moment that overlaps neither other clips nor the current clip
    chosen = next((c for c in candidates if not _overlaps_any(c, all_intervals)), None)
    # Fallback: a moment that doesn't overlap other clips
    if chosen is None:
        chosen = next((c for c in candidates if not _overlaps_any(c, other_intervals)), None)
    # Final fallback: highest-scored candidate differing most from current interval
    if chosen is None:
        chosen = min(
            candidates,
            key=lambda c: compute_overlap_ratio(
                float(c["start_time"]), float(c["end_time"]), current_interval[0], current_interval[1]
            ),
        )

    return _rerender_clip_record(
        clip_rec,
        job_row,
        transcript,
        start_sec=float(chosen["start_time"]),
        end_sec=float(chosen["end_time"]),
        edited_caption_text=None,
        title=str(chosen["title"]),
        hook_title=str(chosen.get("hook_title") or chosen["title"]),
        extra_updates={
            "virality_score": int(chosen["virality_score"]),
            "sub_scores": chosen.get("sub_scores") or {},
            "score_reason": str(chosen.get("score_reason") or ""),
            "description": str(chosen.get("description") or chosen.get("score_reason") or ""),
            "hashtags": chosen.get("hashtags") or [],
            "hook_reason": str(chosen.get("hook_reason") or chosen.get("score_reason") or ""),
            "transcript": str(chosen.get("transcript_text") or ""),
        },
    )


@app.post("/api/clips/{clip_id}/translate")
def translate_clip_endpoint(clip_id: int, body: ClipTranslateRequest) -> Dict[str, Any]:
    clip_rec = db.get_clip_by_id(clip_id)
    if not clip_rec:
        raise HTTPException(status_code=404, detail="Clip not found.")
    job_id = str(clip_rec["job_id"])
    job_row = db.get_job_row(job_id)
    if not job_row:
        raise HTTPException(status_code=404, detail="Parent job not found.")
    transcript = db.get_transcript(job_id)

    source_text = str(clip_rec.get("edited_caption_text") or clip_rec.get("transcript") or "").strip()
    if not source_text:
        raise HTTPException(status_code=400, detail="Clip has no caption text to translate.")

    try:
        translated = translate_caption_text(
            transcript_text=source_text,
            target_language=body.target_language,
            hook_title=str(clip_rec.get("hook_title") or clip_rec.get("title") or ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Caption translation failed: {exc}") from exc

    return _rerender_clip_record(
        clip_rec,
        job_row,
        transcript,
        edited_caption_text=translated["translated_transcript"],
        hook_title=translated["translated_hook_title"] or str(clip_rec.get("hook_title") or clip_rec["title"]),
        language=translated["target_language"],
    )


@app.get("/api/jobs/{job_id}/download-zip")
def download_all_clips_zip(job_id: str) -> FileResponse:
    job_row = db.get_job_row(job_id)
    if not job_row:
        raise HTTPException(status_code=404, detail="Job not found.")
    clips = db.get_clips_for_job(job_id)
    ready_files: List[tuple[Path, str]] = []
    for idx, clip in enumerate(clips):
        vp = clip.get("video_path")
        if vp and Path(vp).exists():
            safe_slug = "".join(
                ch if ch.isalnum() or ch in ("-", "_") else "_"
                for ch in str(clip.get("title") or f"clip_{idx + 1}")
            ).strip("_")[:48]
            arcname = f"{idx + 1:02d}_{safe_slug or f'clip_{idx + 1}'}.mp4"
            ready_files.append((Path(vp), arcname))

    if not ready_files:
        raise HTTPException(status_code=404, detail="No rendered clips are ready to download yet.")

    job_dir = OUTPUTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    zip_path = job_dir / f"scalereach_{job_id}_clips.zip"
    with zipfile.ZipFile(zip_path, mode="w", compression=zipfile.ZIP_STORED) as zf:
        for file_path, arcname in ready_files:
            zf.write(file_path, arcname=arcname)

    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=f"scalereach_{job_id}_clips.zip",
    )


@app.get("/api/workspace/api-keys")
def list_workspace_api_keys(workspace_id: str = Query(default="default")) -> Dict[str, Any]:
    return {"keys": db.list_api_keys(workspace_id=workspace_id)}


@app.post("/api/workspace/api-keys")
def create_workspace_api_key(body: CreateApiKeyRequest) -> Dict[str, Any]:
    raw_key = f"sr_live_{secrets.token_urlsafe(24)}"
    key_prefix = raw_key[:14]
    key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
    key_id = f"key_{uuid.uuid4().hex[:10]}"
    meta = db.create_api_key(
        key_id=key_id,
        workspace_id=body.workspace_id.strip() or "default",
        name=body.name.strip(),
        key_prefix=key_prefix,
        key_hash=key_hash,
    )
    return {**meta, "api_key": raw_key}


@app.delete("/api/workspace/api-keys/{key_id}")
def revoke_workspace_api_key(key_id: str) -> Dict[str, Any]:
    if not db.revoke_api_key(key_id):
        raise HTTPException(status_code=404, detail="API key not found.")
    return {"ok": True, "id": key_id}


@app.get("/api/workspace/api-keys/verify")
def verify_workspace_api_key(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")) -> Dict[str, Any]:
    if not x_api_key or not x_api_key.strip():
        raise HTTPException(status_code=401, detail="Missing X-API-Key header.")
    key_hash = hashlib.sha256(x_api_key.strip().encode("utf-8")).hexdigest()
    matched = db.verify_api_key_hash(key_hash)
    if not matched:
        raise HTTPException(status_code=401, detail="Invalid or revoked workspace API key.")
    return {
        "valid": True,
        "id": matched["id"],
        "workspace_id": matched["workspace_id"],
        "name": matched["name"],
    }


def _mask_secret(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 6:
        return "••••"
    return f"{secret[:6]}••••{secret[-4:]}"


@app.get("/api/workspace/webhooks")
def list_workspace_webhooks(workspace_id: str = Query(default="default")) -> Dict[str, Any]:
    hooks = db.list_webhooks(workspace_id=workspace_id)
    sanitized = [
        {
            "id": h["id"],
            "workspace_id": h["workspace_id"],
            "url": h["url"],
            "secret_preview": _mask_secret(str(h.get("secret") or "")),
            "events": h["events"],
            "active": h["active"],
            "created_at": h["created_at"],
        }
        for h in hooks
    ]
    return {"webhooks": sanitized}


@app.post("/api/workspace/webhooks")
def create_workspace_webhook(body: CreateWebhookRequest) -> Dict[str, Any]:
    clean_url = body.url.strip()
    if not (clean_url.startswith("http://") or clean_url.startswith("https://")):
        raise HTTPException(status_code=400, detail="Webhook URL must start with http:// or https://.")
    secret = (body.secret or "").strip() or f"whsec_{secrets.token_urlsafe(20)}"
    events = [e.strip() for e in body.events if e.strip()] or ["job.completed", "job.failed"]
    webhook_id = f"wh_{uuid.uuid4().hex[:10]}"
    meta = db.create_webhook(
        webhook_id=webhook_id,
        workspace_id=body.workspace_id.strip() or "default",
        url=clean_url,
        secret=secret,
        events=events,
    )
    return {**meta, "secret": secret, "secret_preview": _mask_secret(secret)}


@app.delete("/api/workspace/webhooks/{webhook_id}")
def delete_workspace_webhook(webhook_id: str) -> Dict[str, Any]:
    if not db.delete_webhook(webhook_id):
        raise HTTPException(status_code=404, detail="Webhook not found.")
    return {"ok": True, "id": webhook_id}


@app.post("/api/workspace/webhooks/{webhook_id}/test")
def test_workspace_webhook(webhook_id: str) -> Dict[str, Any]:
    wh = db.get_webhook_by_id(webhook_id)
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found.")
    result = deliver_webhook_event(
        url=wh["url"],
        secret=str(wh.get("secret") or ""),
        event_type="webhook.test",
        payload={
            "webhook_id": wh["id"],
            "workspace_id": wh["workspace_id"],
            "message": "Test delivery from ScaleReach workspace webhooks.",
        },
    )
    return result

