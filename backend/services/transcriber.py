from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from faster_whisper import WhisperModel

DEFAULT_AUDIO_DIR = Path(__file__).resolve().parent.parent.parent / "temp" / "audio"

_WHISPER_MODEL: Optional[WhisperModel] = None
_WHISPER_MODEL_KEY: Optional[tuple[str, str, str]] = None

CHUNK_THRESHOLD_SEC = 1200.0  # Chunk audio longer than 20 minutes
CHUNK_DURATION_SEC = 900.0    # 15-minute chunks
CHUNK_OVERLAP_SEC = 5.0       # 5-second overlap to prevent word loss at boundaries


def get_whisper_model() -> WhisperModel:
    global _WHISPER_MODEL, _WHISPER_MODEL_KEY
    model_size = os.environ.get("WHISPER_MODEL_SIZE", "large-v3-turbo").strip() or "large-v3-turbo"
    device = os.environ.get("WHISPER_DEVICE", "auto").strip() or "auto"
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
    key = (model_size, device, compute_type)

    if _WHISPER_MODEL is None or _WHISPER_MODEL_KEY != key:
        _WHISPER_MODEL = WhisperModel(model_size, device=device, compute_type=compute_type)
        _WHISPER_MODEL_KEY = key
    return _WHISPER_MODEL


def resolve_language_params(language: Optional[str]) -> Dict[str, Optional[str]]:
    """
    Configure auto-detect and initial_prompt for Hindi / Hinglish / English / multilingual speech.
    """
    if not language or language.strip().lower() in {"auto", "detect", "auto-detect", ""}:
        return {
            "language": None,
            "initial_prompt": (
                "Natural conversational speech with proper punctuation. "
                "Supports English, Hindi (देवनागरी), and Hinglish (Hindi mixed with English)."
            ),
        }

    normalized = language.strip().lower()
    if normalized in {"hinglish", "hi-en", "hindi/hinglish"}:
        return {
            "language": None,
            "initial_prompt": (
                "Yeh ek Hinglish podcast aur conversation hai jisme Hindi aur English naturally mix hoti hai. "
                "Preserve accurate wording, punctuation, and natural Hindi-English code switching."
            ),
        }

    if normalized in {"hindi", "hi"}:
        return {
            "language": "hi",
            "initial_prompt": (
                "यह एक स्वाभाविक हिंदी और हिंग्लिश बातचीत है। सही विराम चिह्नों और स्पष्ट शब्दों के साथ लिखें।"
            ),
        }

    lang_map = {
        "english": "en",
        "en": "en",
        "spanish": "es",
        "es": "es",
        "french": "fr",
        "fr": "fr",
        "german": "de",
        "de": "de",
        "portuguese": "pt",
        "pt": "pt",
        "japanese": "ja",
        "ja": "ja",
        "korean": "ko",
        "ko": "ko",
    }
    return {
        "language": lang_map.get(normalized),
        "initial_prompt": "Natural speech with clear sentence punctuation.",
    }


def _probe_audio_duration(audio_path: Path) -> float:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        return 0.0
    try:
        return max(0.0, float((proc.stdout or "0").strip()))
    except ValueError:
        return 0.0


def extract_audio_16k(video_path: Path | str, output_dir: Optional[Path] = None) -> Path:
    """Extract 16kHz mono PCM WAV audio from a video file using FFmpeg."""
    src = Path(video_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"Source video file not found: {src}")

    target_dir = (output_dir or DEFAULT_AUDIO_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    audio_path = target_dir / f"{src.stem}_16k.wav"

    proc = subprocess.run(
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
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not audio_path.exists():
        raise RuntimeError(f"FFmpeg audio extraction failed: {(proc.stderr or '').strip()[:400]}")
    return audio_path


def _slice_audio_chunk(src_audio: Path, chunk_path: Path, start_sec: float, duration_sec: float) -> Path:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start_sec:.3f}",
            "-t",
            f"{duration_sec:.3f}",
            "-i",
            str(src_audio),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            str(chunk_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return chunk_path


def format_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    mins, secs = divmod(total, 60)
    hours, mins = divmod(mins, 60)
    if hours > 0:
        return f"{hours:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def _transcribe_single_wav(
    model: WhisperModel,
    wav_path: Path,
    params: Dict[str, Optional[str]],
    time_offset: float = 0.0,
) -> Dict[str, Any]:
    segments_iter, info = model.transcribe(
        str(wav_path),
        language=params["language"],
        initial_prompt=params["initial_prompt"],
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )

    segments: List[Dict[str, Any]] = []
    words: List[Dict[str, Any]] = []

    for seg in segments_iter:
        seg_text = (seg.text or "").strip()
        seg_start = round(float(seg.start) + time_offset, 3)
        seg_end = round(float(seg.end) + time_offset, 3)
        seg_words: List[Dict[str, Any]] = []

        if seg.words:
            for w in seg.words:
                word_txt = (w.word or "").strip()
                if not word_txt:
                    continue
                word_entry = {
                    "word": word_txt,
                    "start": round(float(w.start) + time_offset, 3),
                    "end": round(float(w.end) + time_offset, 3),
                }
                seg_words.append(word_entry)
                words.append(word_entry)

        if seg_text or seg_words:
            segments.append(
                {
                    "start": seg_start,
                    "end": seg_end,
                    "text": seg_text,
                    "words": seg_words,
                }
            )

    detected_lang = getattr(info, "language", None) or params["language"] or "en"
    lang_prob = round(float(getattr(info, "language_probability", 1.0) or 1.0), 4)
    return {
        "language": detected_lang,
        "language_probability": lang_prob,
        "segments": segments,
        "words": words,
    }


def _parse_subtitle_timestamp(raw: str) -> float:
    clean = raw.strip().replace(",", ".")
    parts = clean.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0


def parse_captions_fallback(subtitle_path: Path | str) -> Optional[Dict[str, Any]]:
    """
    Parse yt-dlp VTT/SRT captions ONLY as a fallback when faster-whisper fails or finds no words.
    """
    sub_file = Path(subtitle_path)
    if not sub_file.exists():
        return None

    text = sub_file.read_text(encoding="utf-8", errors="replace")
    time_pattern = re.compile(
        r"((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})"
    )

    segments: List[Dict[str, Any]] = []
    words: List[Dict[str, Any]] = []
    lines = text.splitlines()
    idx = 0
    while idx < len(lines):
        m = time_pattern.search(lines[idx])
        if not m:
            idx += 1
            continue
        start_s = _parse_subtitle_timestamp(m.group(1))
        end_s = max(start_s + 0.2, _parse_subtitle_timestamp(m.group(2)))
        idx += 1
        body_lines: List[str] = []
        while idx < len(lines) and lines[idx].strip():
            cleaned = re.sub(r"<[^>]+>", "", lines[idx]).strip()
            if cleaned and not cleaned.isdigit():
                body_lines.append(cleaned)
            idx += 1
        seg_text = re.sub(r"\s+", " ", " ".join(body_lines)).strip()
        if not seg_text:
            continue
        if segments and segments[-1]["text"] == seg_text:
            continue

        tokens = seg_text.split()
        step = (end_s - start_s) / max(1, len(tokens))
        seg_words: List[Dict[str, Any]] = []
        for t_idx, tok in enumerate(tokens):
            ws = round(start_s + t_idx * step, 3)
            we = round(min(end_s, ws + step), 3)
            entry = {"word": tok, "start": ws, "end": we}
            seg_words.append(entry)
            words.append(entry)

        segments.append(
            {
                "start": round(start_s, 3),
                "end": round(end_s, 3),
                "text": seg_text,
                "words": seg_words,
            }
        )

    if not words:
        return None

    transcript_lines = [
        f"[{format_timestamp(s['start'])} - {format_timestamp(s['end'])}] {s['text']}"
        for s in segments
    ]
    return {
        "language": "en",
        "language_probability": 0.5,
        "source": "youtube-captions-fallback",
        "transcript": "\n".join(transcript_lines),
        "segments": segments,
        "words": words,
    }


def transcribe_audio(
    audio_path: Path | str,
    language: Optional[str] = None,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """
    Transcribe audio with faster-whisper (word_timestamps=True, vad_filter=True).
    Automatically chunks long audio (>20 min) into overlapping 15-minute windows.
    """
    src_audio = Path(audio_path).resolve()
    if not src_audio.exists():
        raise FileNotFoundError(f"Audio file not found: {src_audio}")

    model = get_whisper_model()
    params = resolve_language_params(language)
    total_dur = _probe_audio_duration(src_audio)

    all_segments: List[Dict[str, Any]] = []
    all_words: List[Dict[str, Any]] = []
    detected_lang = params["language"] or "en"
    lang_prob = 1.0

    if total_dur <= CHUNK_THRESHOLD_SEC:
        res = _transcribe_single_wav(model, src_audio, params, time_offset=0.0)
        all_segments = res["segments"]
        all_words = res["words"]
        detected_lang = res["language"]
        lang_prob = res["language_probability"]
        if progress_callback:
            progress_callback(1.0)
    else:
        chunk_dir = src_audio.parent / f"{src_audio.stem}_chunks"
        chunk_dir.mkdir(parents=True, exist_ok=True)

        offsets: List[float] = []
        cursor = 0.0
        step = CHUNK_DURATION_SEC - CHUNK_OVERLAP_SEC
        while cursor < total_dur:
            offsets.append(cursor)
            if cursor + CHUNK_DURATION_SEC >= total_dur:
                break
            cursor += step

        last_word_end = -1.0
        for idx, offset in enumerate(offsets):
            chunk_len = min(CHUNK_DURATION_SEC, max(1.0, total_dur - offset))
            chunk_wav = chunk_dir / f"chunk_{idx:03d}.wav"
            try:
                _slice_audio_chunk(src_audio, chunk_wav, offset, chunk_len)
                chunk_res = _transcribe_single_wav(model, chunk_wav, params, time_offset=offset)
                if idx == 0:
                    detected_lang = chunk_res["language"]
                    lang_prob = chunk_res["language_probability"]
                    # Lock detected language for remaining chunks to avoid drift on long podcasts
                    if params["language"] is None and detected_lang:
                        params = {**params, "language": detected_lang}

                # Deduplicate overlap boundary words
                cutoff = offset + (CHUNK_OVERLAP_SEC * 0.5) if idx > 0 else -1.0
                for seg in chunk_res["segments"]:
                    if idx > 0 and seg["end"] <= cutoff:
                        continue
                    kept_words = [
                        w
                        for w in seg["words"]
                        if w["start"] >= max(cutoff, last_word_end - 0.05)
                    ]
                    if not kept_words and seg["words"]:
                        continue
                    if kept_words:
                        last_word_end = max(last_word_end, kept_words[-1]["end"])
                        all_words.extend(kept_words)
                        seg_copy = {
                            "start": kept_words[0]["start"],
                            "end": kept_words[-1]["end"],
                            "text": " ".join(w["word"] for w in kept_words).strip(),
                            "words": kept_words,
                        }
                        all_segments.append(seg_copy)
                    elif seg["text"]:
                        all_segments.append(seg)
            finally:
                chunk_wav.unlink(missing_ok=True)

            if progress_callback:
                progress_callback(min(1.0, (idx + 1) / max(1, len(offsets))))

    transcript_lines = [
        f"[{format_timestamp(seg['start'])} - {format_timestamp(seg['end'])}] {seg['text']}"
        for seg in all_segments
        if seg.get("text")
    ]

    return {
        "language": detected_lang,
        "language_probability": lang_prob,
        "source": "faster-whisper",
        "transcript": "\n".join(transcript_lines),
        "segments": all_segments,
        "words": all_words,
    }


def transcribe_video(
    video_path: Path | str,
    language: Optional[str] = None,
    audio_output_dir: Optional[Path] = None,
    fallback_subtitles_path: Optional[Path | str] = None,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """
    Extract 16kHz WAV audio, transcribe with faster-whisper (primary), save full transcript JSON,
    and fall back to YouTube captions ONLY if faster-whisper fails or produces zero words.
    """
    target_dir = (audio_output_dir or DEFAULT_AUDIO_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    audio_path = extract_audio_16k(video_path, output_dir=target_dir)

    whisper_error: Optional[Exception] = None
    result: Optional[Dict[str, Any]] = None
    try:
        result = transcribe_audio(
            audio_path,
            language=language,
            progress_callback=progress_callback,
        )
    except Exception as exc:
        whisper_error = exc

    if result is None or not result.get("words"):
        if fallback_subtitles_path:
            fallback = parse_captions_fallback(fallback_subtitles_path)
            if fallback and fallback.get("words"):
                result = fallback
        if result is None:
            if whisper_error is not None:
                raise RuntimeError(f"faster-whisper transcription failed: {whisper_error}") from whisper_error
            raise RuntimeError("Transcription produced no spoken words.")

    result["audio_path"] = str(audio_path)

    transcript_json_path = target_dir / "transcript.json"
    transcript_json_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    result["transcript_json_path"] = str(transcript_json_path)
    return result
