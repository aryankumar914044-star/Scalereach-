from __future__ import annotations

import os
import subprocess
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

import cv2
import mediapipe as mp
import uvicorn
import yt_dlp
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Paths & App Setup (Port 7860 for Hugging Face Spaces)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DOWNLOADS_DIR = TEMP_DIR / "downloads"
TEMP_AUDIO_DIR = TEMP_DIR / "audio"
TEMP_REFRAME_DIR = TEMP_DIR / "reframed"
TEMP_JOBS_DIR = TEMP_DIR / "jobs"
OUTPUTS_DIR = BASE_DIR / "outputs"

for _dir in (
    TEMP_DOWNLOADS_DIR,
    TEMP_AUDIO_DIR,
    TEMP_REFRAME_DIR,
    TEMP_JOBS_DIR,
    OUTPUTS_DIR,
):
    _dir.mkdir(parents=True, exist_ok=True)

TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920

# ASS uses &HAABBGGRR (BGR hex order)
STYLE_PALETTES: Dict[str, Tuple[str, str, int]] = {
    "classic": ("&H00FFFFFF", "&H0000F2FF", 0),       # White + Bright Yellow
    "toxic-green": ("&H00FFFFFF", "&H003AE03E", 0),   # White + Bright Green
    "cyan-slide": ("&H00FFFFFF", "&H00FF9B19", 0),    # White + Cyan
    "italic-red": ("&H00FFFFFF", "&H001A2AFF", -1),   # White + Italic Red
    "cream-blue": ("&H00E8F4FF", "&H00FFA479", 0),    # Cream + Sky Blue
    "red-spin": ("&H00FFFFFF", "&H001A2AFF", 0),      # White + Red
    "violet": ("&H00FFFFFF", "&H00FF5A6A", 0),        # White + Violet
    "blue-glow": ("&H00FFFFFF", "&H00FFAA3A", 0),     # White + Electric Blue
}

app = FastAPI(title="Scalereach AI Video Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")

JOBS: Dict[str, Dict[str, Any]] = {}
_WHISPER_MODEL: Optional[WhisperModel] = None


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class ViralClipItem(BaseModel):
    clip_id: int = Field(ge=1)
    title: str
    virality_score: int = Field(ge=1, le=100)
    score_reason: str
    start_time: float = Field(ge=0.0)
    end_time: float = Field(gt=0.0)
    transcript_text: str


class ViralClipList(BaseModel):
    clips: List[ViralClipItem] = Field(min_length=1, max_length=6)


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
    language: str = "English"
    total_duration_sec: Optional[float] = None
    start_bound: float = 0.0
    end_bound: Optional[float] = None


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
    clipType: str = "Templates"
    preset: str = "Viral Clips"
    captionsEnabled: bool = True
    captionStyle: str = "classic"
    autoHook: bool = True
    smartReframe: bool = True
    aiMusic: bool = False
    durationRange: str = "Auto"
    aspectRatio: str = "9:16 Portrait"
    language: str = "English"
    splitScreen: bool = False
    backgroundVideo: str = "All"
    startSec: float = 0.0
    endSec: float = 0.0


class NoteUpdate(BaseModel):
    note: str


class ClipUpdate(BaseModel):
    title: Optional[str] = None
    favorite: Optional[bool] = None


# ---------------------------------------------------------------------------
# 1. Video Ingestion & Downloader (yt-dlp + FFmpeg)
# ---------------------------------------------------------------------------
def format_duration(seconds: Optional[float]) -> str:
    if not seconds or seconds <= 0:
        return "0:00"
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def fetch_video_metadata(url: str) -> Dict[str, Any]:
    clean_url = url.strip()
    if not clean_url:
        raise ValueError("Video URL cannot be empty.")

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(clean_url, download=False)

    if not info:
        raise ValueError("Unable to extract video metadata for the provided URL.")

    raw_duration = float(info.get("duration") or 0.0)
    extractor = str(info.get("extractor_key") or info.get("extractor") or "YouTube")
    platform = "YouTube" if "youtube" in extractor.lower() else extractor

    return {
        "video_id": str(info.get("id") or ""),
        "url": str(info.get("webpage_url") or clean_url),
        "title": str(info.get("title") or "Untitled Video"),
        "thumbnail": str(info.get("thumbnail") or ""),
        "duration": format_duration(raw_duration),
        "duration_sec": int(round(raw_duration)),
        "channel_name": str(info.get("channel") or info.get("uploader") or "Creator"),
        "platform": platform,
    }


def download_video(url: str, output_dir: Optional[Path] = None) -> Dict[str, Any]:
    clean_url = url.strip()
    if not clean_url:
        raise ValueError("Video URL cannot be empty.")

    target_dir = (output_dir or TEMP_DOWNLOADS_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": (
            "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
            "bestvideo[height<=1080]+bestaudio/"
            "best[ext=mp4]/best"
        ),
        "merge_output_format": "mp4",
        "outtmpl": str(target_dir / "%(id)s.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegVideoConvertor",
                "preferedformat": "mp4",
            }
        ],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(clean_url, download=True)
        prepared = Path(ydl.prepare_filename(info))

    video_id = str(info.get("id") or prepared.stem)
    mp4_path = target_dir / f"{video_id}.mp4"
    if not mp4_path.exists():
        if prepared.exists():
            mp4_path = prepared
        else:
            matches = sorted(target_dir.glob(f"{video_id}.*"))
            if not matches:
                raise FileNotFoundError(f"Downloaded media file missing for video_id={video_id}")
            mp4_path = matches[0]

    raw_duration = float(info.get("duration") or 0.0)
    return {
        "video_id": video_id,
        "url": str(info.get("webpage_url") or clean_url),
        "title": str(info.get("title") or "Untitled Video"),
        "thumbnail": str(info.get("thumbnail") or ""),
        "duration": format_duration(raw_duration),
        "duration_sec": int(round(raw_duration)),
        "channel_name": str(info.get("channel") or info.get("uploader") or "Creator"),
        "file_path": str(mp4_path),
    }


# ---------------------------------------------------------------------------
# 2. Word-Level Audio Transcription (faster-whisper + FFmpeg)
# ---------------------------------------------------------------------------
def get_whisper_model() -> WhisperModel:
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")
        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
        _WHISPER_MODEL = WhisperModel(model_size, device=device, compute_type=compute_type)
    return _WHISPER_MODEL


def resolve_language_params(language: Optional[str]) -> Dict[str, Optional[str]]:
    if not language or language.strip().lower() in {"auto", "detect", ""}:
        return {
            "language": None,
            "initial_prompt": "Natural speech in English, Hindi, or Hinglish.",
        }

    normalized = language.strip().lower()
    if normalized == "hinglish":
        return {
            "language": None,
            "initial_prompt": "Hinglish conversation mixing Hindi and English words naturally.",
        }

    lang_map = {
        "english": "en",
        "en": "en",
        "hindi": "hi",
        "hi": "hi",
        "spanish": "es",
        "es": "es",
        "french": "fr",
        "fr": "fr",
    }
    return {
        "language": lang_map.get(normalized),
        "initial_prompt": None,
    }


def extract_audio_16k(video_path: Path | str, output_dir: Optional[Path] = None) -> Path:
    src = Path(video_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"Source video file not found: {src}")

    target_dir = (output_dir or TEMP_AUDIO_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    audio_path = target_dir / f"{src.stem}_16k.wav"

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            str(audio_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return audio_path


def format_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    mins, secs = divmod(total, 60)
    hours, mins = divmod(mins, 60)
    if hours > 0:
        return f"{hours:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def transcribe_audio(audio_path: Path | str, language: Optional[str] = None) -> Dict[str, Any]:
    src_audio = Path(audio_path).resolve()
    if not src_audio.exists():
        raise FileNotFoundError(f"Audio file not found: {src_audio}")

    model = get_whisper_model()
    params = resolve_language_params(language)

    segments_iter, info = model.transcribe(
        str(src_audio),
        language=params["language"],
        initial_prompt=params["initial_prompt"],
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )

    segments: List[Dict[str, Any]] = []
    all_words: List[Dict[str, Any]] = []
    transcript_lines: List[str] = []

    for seg in segments_iter:
        seg_text = (seg.text or "").strip()
        seg_start = round(float(seg.start), 3)
        seg_end = round(float(seg.end), 3)
        seg_words: List[Dict[str, Any]] = []

        if seg.words:
            for w in seg.words:
                word_txt = (w.word or "").strip()
                if not word_txt:
                    continue
                word_entry = {
                    "word": word_txt,
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                }
                seg_words.append(word_entry)
                all_words.append(word_entry)

        if seg_text or seg_words:
            segments.append(
                {
                    "start": seg_start,
                    "end": seg_end,
                    "text": seg_text,
                    "words": seg_words,
                }
            )
            transcript_lines.append(
                f"[{format_timestamp(seg_start)} - {format_timestamp(seg_end)}] {seg_text}"
            )

    detected_lang = getattr(info, "language", None) or params["language"] or "en"
    lang_prob = round(float(getattr(info, "language_probability", 1.0) or 1.0), 4)

    return {
        "language": detected_lang,
        "language_probability": lang_prob,
        "transcript": "\n".join(transcript_lines),
        "segments": segments,
        "words": all_words,
    }


def transcribe_video(
    video_path: Path | str,
    language: Optional[str] = None,
    audio_output_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    audio_path = extract_audio_16k(video_path, output_dir=audio_output_dir)
    result = transcribe_audio(audio_path, language=language)
    result["audio_path"] = str(audio_path)
    return result


# ---------------------------------------------------------------------------
# 3. AI Viral Clip Detector & Virality Scoring (google-genai)
# ---------------------------------------------------------------------------
def _format_transcript_input(
    transcript_data: Dict[str, Any] | str,
    start_bound: float = 0.0,
    end_bound: Optional[float] = None,
) -> str:
    if isinstance(transcript_data, str):
        return transcript_data.strip()

    segments = transcript_data.get("segments") or []
    if segments:
        lines: List[str] = []
        for seg in segments:
            s = float(seg.get("start", 0.0))
            e = float(seg.get("end", 0.0))
            if end_bound is not None and end_bound > start_bound:
                if e < start_bound or s > end_bound:
                    continue
            text = str(seg.get("text") or "").strip()
            if text:
                lines.append(f"[{s:.2f}s - {e:.2f}s] {text}")
        if lines:
            return "\n".join(lines)

    return str(transcript_data.get("transcript") or "").strip()


def _extract_clip_transcript(
    transcript_data: Dict[str, Any] | str,
    start_time: float,
    end_time: float,
    fallback_text: str,
) -> str:
    if isinstance(transcript_data, dict):
        segments = transcript_data.get("segments") or []
        matched = [
            str(seg.get("text") or "").strip()
            for seg in segments
            if float(seg.get("end", 0.0)) >= start_time and float(seg.get("start", 0.0)) <= end_time
        ]
        joined = " ".join(part for part in matched if part).strip()
        if joined:
            return joined
    return fallback_text.strip()


def analyze_viral_clips(
    transcript_data: Dict[str, Any] | str,
    video_title: str = "Creator Video",
    preset: str = "Viral Clips",
    language: str = "English",
    total_duration_sec: Optional[float] = None,
    start_bound: float = 0.0,
    end_bound: Optional[float] = None,
    min_clip_sec: float = 30.0,
    max_clip_sec: float = 60.0,
) -> List[Dict[str, Any]]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY environment variable is required.")

    transcript_block = _format_transcript_input(
        transcript_data,
        start_bound=start_bound,
        end_bound=end_bound,
    )
    if not transcript_block:
        raise ValueError("Transcript input is empty; cannot analyze viral clips.")

    max_duration = float(total_duration_sec or 0.0)
    if max_duration <= 0 and isinstance(transcript_data, dict):
        segs = transcript_data.get("segments") or []
        if segs:
            max_duration = max(float(seg.get("end", 0.0)) for seg in segs)

    effective_end = end_bound if (end_bound is not None and end_bound > start_bound) else max_duration
    bounds_note = (
        f"Allowed timeframe: {start_bound:.2f}s to {effective_end:.2f}s."
        if effective_end > start_bound
        else f"Start at or after {start_bound:.2f}s."
    )

    prompt = (
        "You are an elite viral short-form video strategist at ScaleReach.ai.\n"
        f"Video Title: {video_title}\n"
        f"Clip Style Preset: {preset} | Language: {language}\n"
        f"{bounds_note}\n\n"
        "Analyze the timestamped transcript below and extract the top 3 to 6 most engaging, "
        "viral-worthy moments for YouTube Shorts, Reels, and TikTok.\n\n"
        "STRICT RULES:\n"
        f"1. Every clip duration (end_time - start_time) MUST be strictly between {int(min_clip_sec)} and {int(max_clip_sec)} seconds.\n"
        "2. Every clip MUST open on a compelling hook (curiosity gap, bold claim, contrarian take, or emotional peak).\n"
        "3. Every clip MUST end cleanly on a complete spoken sentence without cutting off mid-thought.\n"
        "4. Assign consecutive integer clip_id values starting at 1.\n"
        "5. Assign a realistic virality_score (integer 1-100, typically 72-98) and a concise score_reason.\n"
        "6. Include the exact transcript_text spoken between start_time and end_time.\n\n"
        f"Timestamped Transcript:\n{transcript_block}"
    )

    client = genai.Client(
        api_key=api_key,
        http_options={"headers": {"User-Agent": "aistudio-build"}},
    )
    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    try:
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ViralClipList,
            ),
        )
    except Exception as exc:
        err_text = str(exc)
        if any(
            token in err_text
            for token in (
                "401",
                "403",
                "API_KEY_INVALID",
                "API key not valid",
                "ACCESS_TOKEN_TYPE_UNSUPPORTED",
                "UNAUTHENTICATED",
                "PERMISSION_DENIED",
            )
        ):
            raise RuntimeError(
                "Gemini API key is not valid or unsupported. Please check or select a valid GEMINI_API_KEY in Settings > Secrets."
            ) from exc
        if "429" in err_text or "RESOURCE_EXHAUSTED" in err_text:
            raise RuntimeError(
                "Gemini API quota or rate limit exceeded. Please try again shortly or check your API key billing tier."
            ) from exc
        raise

    if not response.text:
        raise RuntimeError("Gemini returned an empty response for viral clip analysis.")

    parsed = ViralClipList.model_validate_json(response.text)

    normalized_clips: List[Dict[str, Any]] = []
    for idx, clip in enumerate(parsed.clips[:6], start=1):
        start_t = max(start_bound, float(clip.start_time))
        end_t = float(clip.end_time)

        dur = end_t - start_t
        if dur < min_clip_sec:
            end_t = start_t + min_clip_sec
        elif dur > max_clip_sec:
            end_t = start_t + max_clip_sec

        if effective_end > 0 and end_t > effective_end:
            end_t = effective_end
            if (end_t - start_t) > max_clip_sec:
                start_t = max(start_bound, end_t - max_clip_sec)

        spoken_text = _extract_clip_transcript(
            transcript_data,
            start_time=start_t,
            end_time=end_t,
            fallback_text=clip.transcript_text,
        )

        validated = ViralClipItem(
            clip_id=idx,
            title=clip.title.strip()[:80],
            virality_score=max(1, min(100, int(clip.virality_score))),
            score_reason=clip.score_reason.strip(),
            start_time=round(start_t, 2),
            end_time=round(end_t, 2),
            transcript_text=spoken_text,
        )
        normalized_clips.append(validated.model_dump())

    return normalized_clips


# ---------------------------------------------------------------------------
# 4. Smart 9:16 Auto-Reframe & Face Tracking (MediaPipe + OpenCV + FFmpeg)
# ---------------------------------------------------------------------------
def _detect_primary_face_x(detector: Any, rgb_frame: Any) -> Optional[float]:
    results = detector.process(rgb_frame)
    if not results or not results.detections:
        return None

    best = max(
        results.detections,
        key=lambda det: (
            det.location_data.relative_bounding_box.width
            * det.location_data.relative_bounding_box.height
        ),
    )
    box = best.location_data.relative_bounding_box
    cx = float(box.xmin + (box.width * 0.5))
    return max(0.0, min(1.0, cx))


def reframe_clip_to_vertical(
    source_video: Path | str,
    start_time: float,
    end_time: float,
    output_path: Optional[Path | str] = None,
    clip_id: int = 1,
    rolling_window: int = 15,
    detect_every_n_frames: int = 3,
    smart_reframe: bool = True,
) -> Dict[str, Any]:
    src_path = Path(source_video).resolve()
    if not src_path.exists():
        raise FileNotFoundError(f"Source video not found: {src_path}")

    start_sec = max(0.0, float(start_time))
    end_sec = float(end_time)
    duration_sec = max(1.0, end_sec - start_sec)

    if output_path:
        out_mp4 = Path(output_path).resolve()
        out_mp4.parent.mkdir(parents=True, exist_ok=True)
    else:
        TEMP_REFRAME_DIR.mkdir(parents=True, exist_ok=True)
        out_mp4 = (TEMP_REFRAME_DIR / f"{src_path.stem}_clip_{clip_id}_9x16.mp4").resolve()

    cap = cv2.VideoCapture(str(src_path))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV could not open source video: {src_path}")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    if fps <= 0 or fps > 120:
        fps = 30.0

    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)

    scale = max(TARGET_HEIGHT / max(1, orig_h), TARGET_WIDTH / max(1, orig_w))
    scaled_w = max(TARGET_WIDTH, int(round(orig_w * scale)))
    scaled_h = max(TARGET_HEIGHT, int(round(orig_h * scale)))
    if scaled_w % 2 != 0:
        scaled_w += 1
    if scaled_h % 2 != 0:
        scaled_h += 1

    max_crop_x = max(0, scaled_w - TARGET_WIDTH)
    center_crop_x = max_crop_x // 2
    crop_y = max(0, (scaled_h - TARGET_HEIGHT) // 2)

    start_frame = int(round(start_sec * fps))
    total_frames = max(1, int(round(duration_sec * fps)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    ffmpeg_cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{TARGET_WIDTH}x{TARGET_HEIGHT}",
        "-r",
        f"{fps:.3f}",
        "-i",
        "-",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(src_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(out_mp4),
    ]

    proc = subprocess.Popen(
        ffmpeg_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    face_detector = (
        mp.solutions.face_detection.FaceDetection(
            model_selection=1,
            min_detection_confidence=0.5,
        )
        if smart_reframe
        else None
    )

    x_history: Deque[float] = deque(maxlen=max(1, rolling_window))
    last_raw_x: float = 0.5
    frames_written = 0
    faces_detected_count = 0

    try:
        for idx in range(total_frames):
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            if face_detector is not None and idx % max(1, detect_every_n_frames) == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                detected_x = _detect_primary_face_x(face_detector, rgb)
                if detected_x is not None:
                    last_raw_x = detected_x
                    faces_detected_count += 1
                else:
                    last_raw_x = (last_raw_x * 0.85) + (0.5 * 0.15)

            x_history.append(last_raw_x)
            smoothed_norm_x = sum(x_history) / len(x_history)

            resized = cv2.resize(frame, (scaled_w, scaled_h), interpolation=cv2.INTER_LINEAR)

            if not smart_reframe or faces_detected_count == 0:
                crop_x = center_crop_x
            else:
                desired_center = int(round(smoothed_norm_x * scaled_w))
                crop_x = max(0, min(max_crop_x, desired_center - (TARGET_WIDTH // 2)))

            cropped = resized[crop_y : crop_y + TARGET_HEIGHT, crop_x : crop_x + TARGET_WIDTH]
            if cropped.shape[0] != TARGET_HEIGHT or cropped.shape[1] != TARGET_WIDTH:
                cropped = cv2.resize(cropped, (TARGET_WIDTH, TARGET_HEIGHT))

            if proc.stdin is not None:
                proc.stdin.write(cropped.tobytes())
                frames_written += 1

        if proc.stdin is not None:
            proc.stdin.close()

        _, stderr_bytes = proc.communicate(timeout=300)
        if proc.returncode != 0:
            err_msg = stderr_bytes.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"FFmpeg auto-reframe failed (code {proc.returncode}): {err_msg}")
    finally:
        if face_detector is not None:
            face_detector.close()
        cap.release()
        if proc.poll() is None:
            proc.kill()

    return {
        "clip_id": clip_id,
        "output_path": str(out_mp4),
        "width": TARGET_WIDTH,
        "height": TARGET_HEIGHT,
        "start_time": round(start_sec, 2),
        "end_time": round(end_sec, 2),
        "frames_processed": frames_written,
        "face_tracked": faces_detected_count > 0,
    }


# ---------------------------------------------------------------------------
# 5. Animated Word-by-Word Captions Burner (FFmpeg .ass)
# ---------------------------------------------------------------------------
def _ass_timestamp(seconds: float) -> str:
    s = max(0.0, float(seconds))
    hours = int(s // 3600)
    minutes = int((s % 3600) // 60)
    secs = int(s % 60)
    cs = min(99, int(round((s - int(s)) * 100)))
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _sanitize_ass_word(text: str) -> str:
    return text.replace("{", "").replace("}", "").replace("\n", " ").strip().upper()


def _normalize_clip_words(
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    fallback_transcript: str = "",
) -> List[Dict[str, Any]]:
    relative_words: List[Dict[str, Any]] = []
    clip_len = max(1.0, clip_end - clip_start)

    for w in words:
        w_start = float(w.get("start", 0.0))
        w_end = float(w.get("end", 0.0))
        if w_end <= clip_start or w_start >= clip_end:
            continue
        clean = _sanitize_ass_word(str(w.get("word") or ""))
        if not clean:
            continue
        rel_s = max(0.0, w_start - clip_start)
        rel_e = min(clip_len, max(rel_s + 0.08, w_end - clip_start))
        relative_words.append({"word": clean, "start": rel_s, "end": rel_e})

    if not relative_words and fallback_transcript.strip():
        tokens = [_sanitize_ass_word(t) for t in fallback_transcript.split() if _sanitize_ass_word(t)]
        if tokens:
            step = clip_len / len(tokens)
            for idx, tok in enumerate(tokens):
                relative_words.append(
                    {
                        "word": tok,
                        "start": idx * step,
                        "end": min(clip_len, (idx + 1) * step),
                    }
                )

    return relative_words


def generate_ass_subtitles(
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    ass_output_path: Path | str,
    caption_style: str = "classic",
    fallback_transcript: str = "",
    play_res_x: int = 1080,
    play_res_y: int = 1920,
    words_per_group: int = 3,
) -> Path:
    out_ass = Path(ass_output_path).resolve()
    out_ass.parent.mkdir(parents=True, exist_ok=True)

    base_color, highlight_color, italic_flag = STYLE_PALETTES.get(
        caption_style, STYLE_PALETTES["classic"]
    )
    font_size = max(68, int(round(play_res_y * 0.044)))
    margin_v = int(round(play_res_y * 0.22))

    header = (
        "[Script Info]\n"
        "Title: ScaleReach Animated Captions\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {play_res_x}\n"
        f"PlayResY: {play_res_y}\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Liberation Sans,{font_size},{base_color},{highlight_color},&H00000000,&H80000000,"
        f"-1,{italic_flag},0,0,100,100,1,0,1,6,2,2,60,60,{margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    rel_words = _normalize_clip_words(words, clip_start, clip_end, fallback_transcript)
    group_size = max(3, min(4, int(words_per_group)))
    events: List[str] = []

    for g_idx in range(0, len(rel_words), group_size):
        chunk = rel_words[g_idx : g_idx + group_size]
        if not chunk:
            continue

        for active_idx, active_word in enumerate(chunk):
            ev_start = float(active_word["start"])
            if active_idx + 1 < len(chunk):
                ev_end = max(ev_start + 0.06, float(chunk[active_idx + 1]["start"]))
            else:
                ev_end = max(ev_start + 0.12, float(active_word["end"]))

            rendered_tokens: List[str] = []
            for j, token in enumerate(chunk):
                word_str = str(token["word"])
                if j == active_idx:
                    rendered_tokens.append(
                        f"{{\\c{highlight_color}\\fscx112\\fscy112}}{word_str}{{\\c{base_color}\\fscx100\\fscy100}}"
                    )
                else:
                    rendered_tokens.append(f"{{\\c{base_color}}}{word_str}")

            line_text = " ".join(rendered_tokens)
            events.append(
                f"Dialogue: 0,{_ass_timestamp(ev_start)},{_ass_timestamp(ev_end)},Default,,0,0,0,,{line_text}"
            )

    out_ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_ass


def _escape_ffmpeg_filter_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _escape_drawtext(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "")
        .replace("%", "\\%")
    )


def burn_captions_to_video(
    input_video_path: Path | str,
    output_video_path: Path | str,
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    caption_style: str = "classic",
    captions_enabled: bool = True,
    auto_hook: bool = False,
    hook_title: str = "",
    fallback_transcript: str = "",
) -> Path:
    src = Path(input_video_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"Reframed clip video not found: {src}")

    out_mp4 = Path(output_video_path).resolve()
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    vf_filters: List[str] = []

    if auto_hook and hook_title.strip():
        safe_hook = _escape_drawtext(hook_title.strip().upper())
        vf_filters.append(
            f"drawtext=font='Liberation Sans':text='{safe_hook}':fontcolor=white:fontsize=48:"
            "box=1:boxcolor=black@0.72:boxborderw=18:x=(w-text_w)/2:y=160"
        )

    if captions_enabled:
        ass_path = out_mp4.with_suffix(".ass")
        generate_ass_subtitles(
            words=words,
            clip_start=clip_start,
            clip_end=clip_end,
            ass_output_path=ass_path,
            caption_style=caption_style,
            fallback_transcript=fallback_transcript,
        )
        vf_filters.append(f"ass='{_escape_ffmpeg_filter_path(ass_path)}'")

    if not vf_filters:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(out_mp4)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return out_mp4

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-vf",
            ",".join(vf_filters),
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return out_mp4


# ---------------------------------------------------------------------------
# End-to-End Pipeline Runner (FastAPI BackgroundTasks)
# ---------------------------------------------------------------------------
def _update_job(job_id: str, patch: Dict[str, Any]) -> None:
    if job_id in JOBS:
        JOBS[job_id].update(patch)


def _format_clip_duration(start_time: float, end_time: float) -> str:
    total = max(1, int(round(end_time - start_time)))
    mins, secs = divmod(total, 60)
    return f"{mins}:{secs:02d}"


def run_complete_pipeline(job_id: str, payload: Dict[str, Any]) -> None:
    job_dir = OUTPUTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    work_dir = TEMP_JOBS_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        _update_job(
            job_id,
            {
                "stage": 1,
                "activeStepIndex": 0,
                "progress": 14,
                "current_step": "Fetching your video",
            },
        )
        downloaded = download_video(payload["url"], output_dir=work_dir)
        source_video = Path(downloaded["file_path"])
        video_title = payload.get("videoTitle") or downloaded.get("title") or "Creator Video"
        total_duration_sec = int(downloaded.get("duration_sec") or 0)

        _update_job(
            job_id,
            {
                "stage": 1,
                "activeStepIndex": 1,
                "progress": 36,
                "current_step": "Preparing your video",
                "videoTitle": video_title,
            },
        )

        _update_job(
            job_id,
            {
                "stage": 1,
                "activeStepIndex": 2,
                "progress": 56,
                "current_step": "Listening to the audio",
            },
        )
        transcript_result = transcribe_video(
            source_video,
            language=payload.get("language"),
            audio_output_dir=work_dir,
        )
        all_words: List[Dict[str, Any]] = transcript_result.get("words") or []

        _update_job(
            job_id,
            {
                "stage": 2,
                "activeStepIndex": 3,
                "progress": 78,
                "current_step": "Finding the best moments",
            },
        )
        end_bound = float(payload.get("endSec") or 0.0)
        viral_clips = analyze_viral_clips(
            transcript_data=transcript_result,
            video_title=video_title,
            preset=payload.get("preset", "Viral Clips"),
            language=payload.get("language", "English"),
            total_duration_sec=total_duration_sec or None,
            start_bound=float(payload.get("startSec") or 0.0),
            end_bound=end_bound if end_bound > 0 else None,
        )

        clip_states: List[Dict[str, Any]] = []
        for idx, clip in enumerate(viral_clips):
            start_t = float(clip["start_time"])
            end_t = float(clip["end_time"])
            score_val = int(clip["virality_score"])
            clip_states.append(
                {
                    "id": idx,
                    "clip_id": int(clip["clip_id"]),
                    "tag": f"#{idx + 1}",
                    "title": clip["title"],
                    "score": str(score_val),
                    "virality_score": score_val,
                    "score_reason": clip["score_reason"],
                    "amberScore": score_val < 90,
                    "progress": 20,
                    "status": "rendering",
                    "startSec": start_t,
                    "endSec": end_t,
                    "duration": _format_clip_duration(start_t, end_t),
                    "transcript": clip["transcript_text"],
                    "videoUrl": None,
                    "video_url": None,
                    "downloadUrl": None,
                    "download_url": None,
                }
            )

        _update_job(
            job_id,
            {
                "stage": 3,
                "progress": 84,
                "current_step": "Reframing & burning captions",
                "clips": clip_states,
            },
        )

        total_clips = max(1, len(viral_clips))
        use_smart_reframe = bool(payload.get("smartReframe", True))
        for idx, clip in enumerate(viral_clips):
            clip_states[idx]["progress"] = 50
            _update_job(job_id, {"clips": [dict(c) for c in clip_states]})

            start_t = float(clip["start_time"])
            end_t = float(clip["end_time"])
            reframed_path = work_dir / f"reframed_{idx + 1}.mp4"
            reframe_clip_to_vertical(
                source_video=source_video,
                start_time=start_t,
                end_time=end_t,
                output_path=reframed_path,
                clip_id=idx + 1,
                smart_reframe=use_smart_reframe,
            )

            clip_states[idx]["progress"] = 78
            _update_job(job_id, {"clips": [dict(c) for c in clip_states]})

            final_filename = f"clip_{idx + 1}.mp4"
            final_mp4 = job_dir / final_filename
            burn_captions_to_video(
                input_video_path=reframed_path,
                output_video_path=final_mp4,
                words=all_words,
                clip_start=start_t,
                clip_end=end_t,
                caption_style=payload.get("captionStyle", "classic"),
                captions_enabled=bool(payload.get("captionsEnabled", True)),
                auto_hook=bool(payload.get("autoHook", True)),
                hook_title=clip["title"],
                fallback_transcript=clip["transcript_text"],
            )

            video_url = f"/outputs/{job_id}/{final_filename}"
            download_url = f"/api/jobs/{job_id}/clips/{idx}/download"
            clip_states[idx]["progress"] = 100
            clip_states[idx]["status"] = "ready"
            clip_states[idx]["videoUrl"] = video_url
            clip_states[idx]["video_url"] = video_url
            clip_states[idx]["downloadUrl"] = download_url
            clip_states[idx]["download_url"] = download_url

            overall_pct = min(100, 84 + int(round(((idx + 1) / total_clips) * 16)))
            _update_job(
                job_id,
                {
                    "progress": overall_pct,
                    "current_step": "Clips ready" if idx + 1 == total_clips else "Reframing & burning captions",
                    "clips": [dict(c) for c in clip_states],
                },
            )

    except Exception as exc:
        _update_job(job_id, {"error": str(exc), "current_step": "Pipeline error"})


# ---------------------------------------------------------------------------
# FastAPI Routes
# ---------------------------------------------------------------------------
@app.get("/")
def root() -> Dict[str, str]:
    return {"status": "ok", "service": "scalereach-ai-backend"}


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "engine": "fastapi-scalereach-hf"}


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
            total_duration_sec=req.total_duration_sec,
            start_bound=req.start_bound,
            end_bound=req.end_bound,
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


@app.post("/api/generate-clips")
def generate_clips_endpoint(req: GenerateRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "job_id": job_id,
        "jobId": job_id,
        "url": req.url,
        "videoTitle": req.videoTitle or "Processing Video",
        "platform": req.platform or "YouTube",
        "aspectRatio": req.aspectRatio,
        "clipPreset": req.preset,
        "stage": 1,
        "activeStepIndex": 0,
        "progress": 11,
        "current_step": "Fetching your video",
        "note": "",
        "clips": [],
        "error": None,
    }
    background_tasks.add_task(run_complete_pipeline, job_id, req.model_dump())
    return {"job_id": job_id, "jobId": job_id}


@app.post("/api/clips/generate")
def generate_clips_legacy(req: GenerateRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    return generate_clips_endpoint(req, background_tasks)


@app.get("/api/job-status/{job_id}")
def get_job_status(job_id: str) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    return get_job_status(job_id)


@app.patch("/api/jobs/{job_id}/note")
def update_note(job_id: str, body: NoteUpdate) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job["note"] = body.note
    return {"ok": True, "note": job["note"]}


@app.patch("/api/jobs/{job_id}/clips/{clip_id}")
def update_clip(job_id: str, clip_id: int, body: ClipUpdate) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    clips: List[Dict[str, Any]] = job.get("clips", [])
    for clip in clips:
        if clip["id"] == clip_id or clip.get("clip_id") == clip_id:
            if body.title is not None:
                clip["title"] = body.title
            if body.favorite is not None:
                clip["favorite"] = body.favorite
            return clip
    raise HTTPException(status_code=404, detail="Clip not found.")


@app.delete("/api/jobs/{job_id}/clips/{clip_id}")
def delete_clip(job_id: str, clip_id: int) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job["clips"] = [c for c in job.get("clips", []) if c["id"] != clip_id]
    return {"ok": True}


@app.get("/api/jobs/{job_id}/clips/{clip_id}/download")
def download_clip(job_id: str, clip_id: int) -> FileResponse:
    file_path = OUTPUTS_DIR / job_id / f"clip_{clip_id + 1}.mp4"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Rendered clip file not found.")
    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=f"scalereach_{job_id}_clip_{clip_id + 1}.mp4",
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
