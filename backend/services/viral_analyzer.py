from __future__ import annotations

import math
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

# Terminal punctuation across English, European languages, and Devanagari (Hindi danda । / ॥)
SENTENCE_END_RE = re.compile(r"[.!?।॥…]+[\"'\)\]]*$")

DURATION_RANGE_MAP: Dict[str, Tuple[float, float]] = {
    "auto": (30.0, 90.0),
    "0 - 30s": (15.0, 30.0),
    "0-30s": (15.0, 30.0),
    "15 - 30s": (15.0, 30.0),
    "15-30s": (15.0, 30.0),
    "under 30s": (15.0, 30.0),
    "30 - 60s": (30.0, 60.0),
    "30-60s": (30.0, 60.0),
    "60 - 90s": (60.0, 90.0),
    "60-90s": (60.0, 90.0),
    "1 - 2 min": (60.0, 120.0),
    "1-2 min": (60.0, 120.0),
    "2 - 3 min": (120.0, 180.0),
    "2-3 min": (120.0, 180.0),
}

# Weights for the final virality score computed strictly in CODE (sums to 1.00)
SCORE_WEIGHTS: Dict[str, float] = {
    "hook_strength": 0.26,
    "story_completeness": 0.24,
    "emotion_energy": 0.16,
    "standalone_clarity": 0.14,
    "pacing": 0.08,
    "speech_rate": 0.06,
    "audio_energy": 0.06,
}


# ---------------------------------------------------------------------------
# Structured Pydantic schemas for Pass 1 (candidates) and Pass 2 (rubric scores)
# ---------------------------------------------------------------------------


class Pass1Candidate(BaseModel):
    start_sentence: int = Field(ge=0)
    end_sentence: int = Field(ge=0)
    title: str = Field(min_length=3, max_length=110)
    hook_title: str = Field(min_length=3, max_length=90)
    arc_summary: str = Field(min_length=5, max_length=280)
    description: str = Field(default="", max_length=360)
    hashtags: List[str] = Field(default_factory=list)


class Pass1WindowResponse(BaseModel):
    candidates: List[Pass1Candidate] = Field(default_factory=list)


class Pass2RubricItem(BaseModel):
    candidate_index: int = Field(ge=0)
    hook_strength: int = Field(ge=0, le=100)
    story_completeness: int = Field(ge=0, le=100)
    emotion_energy: int = Field(ge=0, le=100)
    standalone_clarity: int = Field(ge=0, le=100)
    pacing: int = Field(ge=0, le=100)
    score_reason: str = Field(min_length=8, max_length=240)


class Pass2RubricBatchResponse(BaseModel):
    evaluations: List[Pass2RubricItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Step 5e: Duration mapping
# ---------------------------------------------------------------------------


def map_duration_range(duration_range: Optional[str]) -> Tuple[float, float]:
    """
    Honor the UI Clip Duration selector:
      Auto -> 30-90s
      0 - 30s -> 15-30s
      30 - 60s -> 30-60s
      1 - 2 min -> 60-120s
      2 - 3 min -> 120-180s
    """
    key = re.sub(r"\s+", " ", (duration_range or "Auto").strip().lower())
    if key in DURATION_RANGE_MAP:
        return DURATION_RANGE_MAP[key]
    if "2" in key and "3" in key:
        return (120.0, 180.0)
    if "60" in key and "90" in key:
        return (60.0, 90.0)
    if "1" in key and "2" in key:
        return (60.0, 120.0)
    if "30" in key and "60" in key:
        return (30.0, 60.0)
    if ("0" in key or "15" in key) and "30" in key:
        return (15.0, 30.0)
    return (30.0, 90.0)


def auto_target_clip_count(video_duration_sec: float, user_max_clips: Optional[int] = None) -> int:
    """
    Auto target: ~1 clip per 4-5 minutes of video, clamped to [3, 15].
    If the user explicitly provides max_clips, honor it (clamped 1..20).
    """
    if user_max_clips is not None and user_max_clips > 0:
        return max(1, min(20, int(user_max_clips)))
    if video_duration_sec <= 0:
        return 3
    estimated = int(round(video_duration_sec / 270.0))  # 1 clip per 4.5 min -> 60 min gives ~13 clips
    return max(3, min(15, estimated))


# ---------------------------------------------------------------------------
# Step 5a: Build sentence units from word timestamps
# ---------------------------------------------------------------------------


def build_sentences(
    words: List[Dict[str, Any]],
    pause_threshold_sec: float = 0.7,
    max_words_per_sentence: int = 38,
) -> List[Dict[str, Any]]:
    """
    Group word-level timestamps into sentence units using:
      1. Terminal punctuation (. ! ? । ॥)
      2. Spoken pause > pause_threshold_sec (default 0.7s)
      3. Safety split if an unpunctuated stream exceeds max_words_per_sentence
    Returns a list of dicts: {index, start, end, text, words}.
    """
    cleaned_words: List[Dict[str, Any]] = []
    for raw in words:
        token = str(raw.get("word") or "").strip()
        if not token:
            continue
        w_start = float(raw.get("start", 0.0))
        w_end = max(w_start, float(raw.get("end", w_start)))
        cleaned_words.append({"word": token, "start": round(w_start, 3), "end": round(w_end, 3)})

    if not cleaned_words:
        return []

    sentences: List[Dict[str, Any]] = []
    buffer: List[Dict[str, Any]] = []

    def _flush() -> None:
        if not buffer:
            return
        text = " ".join(w["word"] for w in buffer).strip()
        if text:
            sentences.append(
                {
                    "index": len(sentences),
                    "start": round(float(buffer[0]["start"]), 3),
                    "end": round(float(buffer[-1]["end"]), 3),
                    "text": text,
                    "words": list(buffer),
                }
            )
        buffer.clear()

    for i, w in enumerate(cleaned_words):
        if buffer:
            gap = w["start"] - buffer[-1]["end"]
            if gap > pause_threshold_sec:
                _flush()

        buffer.append(w)

        is_terminal = bool(SENTENCE_END_RE.search(w["word"]))
        too_long = len(buffer) >= max_words_per_sentence
        is_last = i == len(cleaned_words) - 1
        if is_terminal or too_long or is_last:
            _flush()

    return sentences


def extract_words_from_transcript(transcript_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract normalized word list from transcript dict (preferring word timestamps)."""
    words = transcript_data.get("words") or []
    if words:
        return list(words)

    # Synthesize word timestamps from segments ONLY if segments exist without words
    synthesized: List[Dict[str, Any]] = []
    for seg in transcript_data.get("segments") or []:
        seg_words = seg.get("words") or []
        if seg_words:
            synthesized.extend(seg_words)
            continue
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        s = float(seg.get("start", 0.0))
        e = max(s + 0.2, float(seg.get("end", s + 1.0)))
        tokens = text.split()
        step = (e - s) / max(1, len(tokens))
        for idx, tok in enumerate(tokens):
            ws = round(s + idx * step, 3)
            we = round(min(e, ws + step), 3)
            synthesized.append({"word": tok, "start": ws, "end": we})
    return synthesized


# ---------------------------------------------------------------------------
# Step 5b helper: Sliding windows (~8 min with 60s overlap)
# ---------------------------------------------------------------------------


def build_sliding_windows(
    sentences: List[Dict[str, Any]],
    window_sec: float = 480.0,
    overlap_sec: float = 60.0,
    start_bound: float = 0.0,
    end_bound: Optional[float] = None,
) -> List[List[Dict[str, Any]]]:
    """
    Partition sentences into overlapping ~8 minute windows with 60s overlap
    covering the full video (beginning, middle, and end).
    """
    filtered = [
        s
        for s in sentences
        if s["end"] >= start_bound and (end_bound is None or end_bound <= start_bound or s["start"] <= end_bound)
    ]
    if not filtered:
        return []

    first_t = filtered[0]["start"]
    last_t = filtered[-1]["end"]
    if (last_t - first_t) <= window_sec:
        return [filtered]

    stride = max(60.0, window_sec - overlap_sec)
    windows: List[List[Dict[str, Any]]] = []
    win_start = first_t

    while win_start < last_t:
        win_end = win_start + window_sec
        chunk = [s for s in filtered if s["end"] > win_start and s["start"] < win_end]
        if chunk:
            if not windows or chunk[-1]["index"] > windows[-1][-1]["index"]:
                windows.append(chunk)
        if win_end >= last_t:
            break
        win_start += stride

    return windows


# ---------------------------------------------------------------------------
# Step 5d: Sentence-aligned boundary snapping & duration refinement
# ---------------------------------------------------------------------------


def snap_and_refine_boundaries(
    sentences: List[Dict[str, Any]],
    start_sentence_idx: int,
    end_sentence_idx: int,
    min_sec: float,
    max_sec: float,
    total_duration_sec: float,
    pad_start: float = 0.3,
    pad_end: float = 0.5,
) -> Optional[Dict[str, Any]]:
    """
    Snap start to sentences[start_idx].start - 0.3s and end to sentences[end_idx].end + 0.5s.
    Adjust ONLY by whole sentence indices (NEVER cut mid-sentence by clamping raw seconds!).
      - If too short (< min_sec): extend end_idx forward to the next complete sentence
        (or start_idx backward if near video end).
      - If too long (> max_sec): shrink end_idx backward to an earlier complete sentence
        (or advance start_idx forward if needed).
    Returns None if no valid whole-sentence span can satisfy the duration constraints.
    """
    if not sentences:
        return None

    n = len(sentences)
    s_idx = max(0, min(n - 1, int(start_sentence_idx)))
    e_idx = max(s_idx, min(n - 1, int(end_sentence_idx)))

    max_time = max(total_duration_sec, sentences[-1]["end"])

    def _bounds(si: int, ei: int) -> Tuple[float, float, float]:
        raw_start = sentences[si]["start"]
        raw_end = sentences[ei]["end"]
        snapped_s = max(0.0, raw_start - pad_start)
        snapped_e = min(max_time, raw_end + pad_end)
        # Keep padding from pushing a valid sentence span slightly over max_sec
        if (snapped_e - snapped_s) > max_sec and (raw_end - raw_start) <= max_sec:
            extra = (snapped_e - snapped_s) - max_sec
            trim_end = min(pad_end, extra)
            snapped_e -= trim_end
            extra -= trim_end
            if extra > 0:
                snapped_s += min(pad_start, extra)
        return round(snapped_s, 3), round(snapped_e, 3), round(snapped_e - snapped_s, 3)

    # 1. Extend if too short (whole sentences only)
    _, _, dur = _bounds(s_idx, e_idx)
    while dur < min_sec and e_idx < n - 1:
        next_dur = _bounds(s_idx, e_idx + 1)[2]
        if next_dur > max_sec and dur >= min_sec * 0.85:
            break
        e_idx += 1
        dur = next_dur

    while dur < min_sec and s_idx > 0:
        prev_dur = _bounds(s_idx - 1, e_idx)[2]
        if prev_dur > max_sec and dur >= min_sec * 0.85:
            break
        s_idx -= 1
        dur = prev_dur

    # 2. Shrink if too long (whole sentences only — pick earlier complete sentence)
    while dur > max_sec and e_idx > s_idx:
        e_idx -= 1
        dur = _bounds(s_idx, e_idx)[2]

    while dur > max_sec and s_idx < e_idx:
        s_idx += 1
        dur = _bounds(s_idx, e_idx)[2]

    snapped_s, snapped_e, dur = _bounds(s_idx, e_idx)

    # If the entire available transcript is shorter than min_sec, allow full available span
    full_span = max_time - sentences[0]["start"]
    if full_span >= min_sec:
        if dur < min_sec or dur > max_sec:
            # Try one greedy search from s_idx to find an exact-fit end_idx
            found = False
            for try_end in range(s_idx, n):
                ts, te, td = _bounds(s_idx, try_end)
                if min_sec <= td <= max_sec:
                    e_idx = try_end
                    snapped_s, snapped_e, dur = ts, te, td
                    found = True
                    break
            if not found:
                # Try sliding start backward to fit min_sec..max_sec
                for try_start in range(s_idx, -1, -1):
                    ts, te, td = _bounds(try_start, e_idx)
                    if min_sec <= td <= max_sec:
                        s_idx = try_start
                        snapped_s, snapped_e, dur = ts, te, td
                        found = True
                        break
            if not found:
                return None

    span_sentences = sentences[s_idx : e_idx + 1]
    transcript_text = " ".join(s["text"] for s in span_sentences).strip()
    word_count = sum(len(s.get("words") or s["text"].split()) for s in span_sentences)

    return {
        "start_sentence": s_idx,
        "end_sentence": e_idx,
        "start_time": snapped_s,
        "end_time": snapped_e,
        "duration_sec": round(snapped_e - snapped_s, 3),
        "sentence_start_time": sentences[s_idx]["start"],
        "sentence_end_time": sentences[e_idx]["end"],
        "transcript_text": transcript_text,
        "word_count": word_count,
    }


# ---------------------------------------------------------------------------
# Step 5c: Local speech rate + librosa RMS audio energy + weighted final score
# ---------------------------------------------------------------------------


def compute_speech_rate_score(word_count: int, duration_sec: float) -> Tuple[float, int]:
    """
    Compute speech rate (words per second) and map it to 0-100.
    Engaging conversational cadence sits around 2.2-3.6 words/sec.
    """
    if duration_sec <= 0.1 or word_count <= 0:
        return 0.0, 20
    wps = word_count / duration_sec
    if 2.2 <= wps <= 3.6:
        score = 92 + int(round(8 * (1.0 - abs(wps - 2.9) / 0.7)))
    elif wps < 2.2:
        score = int(round(20 + 72 * max(0.0, wps / 2.2)))
    else:
        over = min(2.5, wps - 3.6)
        score = int(round(92 - (over / 2.5) * 32))
    return round(wps, 2), max(0, min(100, score))


def compute_audio_energy_scores(
    audio_path: Optional[Path | str],
    candidates: List[Dict[str, Any]],
) -> List[int]:
    """
    Compute local audio energy scores (0-100) per candidate using librosa RMS energy
    and peak/laughter burst contrast relative to the full audio baseline.
    """
    if not candidates:
        return []
    if not audio_path or not Path(audio_path).exists():
        return [50 for _ in candidates]

    try:
        import librosa

        y, sr = librosa.load(str(audio_path), sr=16000, mono=True)
        if y.size == 0:
            return [50 for _ in candidates]

        hop = 512
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
        if rms.size == 0:
            return [50 for _ in candidates]

        global_median = float(np.median(rms)) + 1e-6
        global_p90 = float(np.percentile(rms, 90)) + 1e-6
        frame_rate = sr / hop

        scores: List[int] = []
        for cand in candidates:
            s_frame = max(0, int(round(float(cand["start_time"]) * frame_rate)))
            e_frame = min(len(rms), max(s_frame + 1, int(round(float(cand["end_time"]) * frame_rate))))
            seg_rms = rms[s_frame:e_frame]
            if seg_rms.size == 0:
                scores.append(50)
                continue

            mean_ratio = float(np.mean(seg_rms)) / global_median
            peak_burst_ratio = float(np.mean(seg_rms > global_p90))
            dynamic_range = float(np.std(seg_rms)) / global_median

            # Blend loudness vs baseline + vocal bursts (laughter/excitement) + expressiveness
            raw_score = (
                40.0
                + min(30.0, max(-25.0, (mean_ratio - 1.0) * 35.0))
                + min(20.0, peak_burst_ratio * 100.0)
                + min(10.0, dynamic_range * 12.0)
            )
            scores.append(max(0, min(100, int(round(raw_score)))))
        return scores
    except Exception:
        return [50 for _ in candidates]


def compute_weighted_final_score(sub_scores: Dict[str, Any]) -> int:
    """Compute final virality score strictly in CODE as a weighted sum of rubric + acoustic signals."""
    total = 0.0
    for key, weight in SCORE_WEIGHTS.items():
        val = float(sub_scores.get(key, 50))
        val = max(0.0, min(100.0, val))
        total += weight * val
    return max(1, min(100, int(round(total))))


# ---------------------------------------------------------------------------
# Step 5f: Overlap removal (>30%) and timeline spread selection
# ---------------------------------------------------------------------------


def compute_overlap_ratio(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    if inter <= 0.0:
        return 0.0
    shorter = min(max(0.001, a_end - a_start), max(0.001, b_end - b_start))
    return inter / shorter


def select_non_overlapping_spread(
    scored_candidates: List[Dict[str, Any]],
    target_k: int,
    total_duration_sec: float,
    max_overlap_ratio: float = 0.30,
) -> List[Dict[str, Any]]:
    """
    1. Sort by final virality_score descending.
    2. Partition the video timeline into buckets so clips are spread across beginning,
       middle, and end (when candidates exist across the video).
    3. Pick the top non-overlapping candidate from each bucket first, then fill up to
       target_k by highest overall score while rejecting any candidate with >30% overlap.
    """
    if not scored_candidates or target_k <= 0:
        return []

    ranked = sorted(
        scored_candidates,
        key=lambda c: (-int(c["virality_score"]), float(c["start_time"])),
    )

    def _conflicts(cand: Dict[str, Any], chosen: List[Dict[str, Any]]) -> bool:
        for existing in chosen:
            if (
                compute_overlap_ratio(
                    float(cand["start_time"]),
                    float(cand["end_time"]),
                    float(existing["start_time"]),
                    float(existing["end_time"]),
                )
                > max_overlap_ratio
            ):
                return True
        return False

    selected: List[Dict[str, Any]] = []
    span = max(1.0, total_duration_sec)
    num_buckets = min(target_k, max(3, min(8, int(math.ceil(span / 480.0)))))

    # Round 1: pick best candidate from each timeline bucket for even coverage
    bucket_size = span / num_buckets
    for b in range(num_buckets):
        if len(selected) >= target_k:
            break
        b_start = b * bucket_size
        b_end = (b + 1) * bucket_size
        bucket_cands = [
            c
            for c in ranked
            if b_start <= ((float(c["start_time"]) + float(c["end_time"])) * 0.5) < (b_end + (1.0 if b == num_buckets - 1 else 0.0))
        ]
        for cand in bucket_cands:
            if not _conflicts(cand, selected):
                selected.append(cand)
                break

    # Round 2: fill remaining slots up to target_k by highest score
    for cand in ranked:
        if len(selected) >= target_k:
            break
        if cand in selected:
            continue
        if not _conflicts(cand, selected):
            selected.append(cand)

    # Final ordering: highest score first
    selected.sort(key=lambda c: (-int(c["virality_score"]), float(c["start_time"])))
    return selected[:target_k]


# ---------------------------------------------------------------------------
# Gemini client + exponential backoff retry wrapper
# ---------------------------------------------------------------------------


def _get_gemini_client(api_key_override: Optional[str] = None) -> Tuple[genai.Client, str]:
    api_key = (api_key_override or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY environment variable (or X-Gemini-Api-Key header) is required for viral moment detection."
        )
    model_name = os.environ.get("GEMINI_MODEL", "gemini-4-hydrogen").strip() or "gemini-4-hydrogen"
    client = genai.Client(
        api_key=api_key,
        http_options={"headers": {"User-Agent": "aistudio-build"}},
    )
    return client, model_name


def _call_gemini_structured(
    client: genai.Client,
    model_name: str,
    prompt: str,
    schema_cls: type[BaseModel],
    max_retries: int = 4,
) -> Any:
    """Call Gemini structured JSON generation with exponential backoff; raise real error on failure."""
    last_exc: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema_cls,
                ),
            )
            if not response.text:
                raise RuntimeError("Gemini returned an empty structured JSON response.")
            return schema_cls.model_validate_json(response.text)
        except Exception as exc:
            last_exc = exc
            err_text = str(exc)
            # Non-retryable auth/config errors fail immediately with clear message
            if any(
                tok in err_text
                for tok in (
                    "API_KEY_INVALID",
                    "API key not valid",
                    "UNAUTHENTICATED",
                    "PERMISSION_DENIED",
                    "NOT_FOUND",
                )
            ):
                raise RuntimeError(f"Gemini API error ({model_name}): {err_text}") from exc

            if attempt < max_retries - 1:
                sleep_s = min(16.0, (1.5 * (2**attempt)))
                time.sleep(sleep_s)

    raise RuntimeError(
        f"Gemini structured analysis failed after {max_retries} attempts: {last_exc}"
    ) from last_exc


# ---------------------------------------------------------------------------
# Main multi-pass viral moment pipeline
# ---------------------------------------------------------------------------


def analyze_viral_clips(
    transcript_data: Dict[str, Any],
    video_title: str = "Creator Video",
    preset: str = "Viral Clips",
    language: str = "Auto",
    duration_range: str = "Auto",
    total_duration_sec: Optional[float] = None,
    start_bound: float = 0.0,
    end_bound: Optional[float] = None,
    max_clips: Optional[int] = None,
    audio_path: Optional[Path | str] = None,
    llm_caller: Optional[Callable[[str, type[BaseModel]], Any]] = None,
    progress_callback: Optional[Callable[[float], None]] = None,
    api_key_override: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Multi-pass sentence-aligned viral clip analyzer:
      1. Build sentence units from word timestamps (punctuation + pauses > 0.7s).
      2. Pass 1: Sliding ~8 min windows (60s overlap) over the entire video asking the LLM
         for complete-arc (hook -> setup -> payoff) start_sentence/end_sentence candidates.
      3. Boundary refinement: snap to whole sentence boundaries (-0.3s/+0.5s) honoring duration_range.
      4. Pass 2: Rubric scoring (0-100 across 5 dimensions + 1-sentence reason) + local
         speech_rate + librosa RMS audio_energy. Final score computed strictly in CODE.
      5. Selection: remove >30% overlaps, spread across timeline, return top K.
    """
    words = extract_words_from_transcript(transcript_data)
    sentences = transcript_data.get("sentences") or build_sentences(words)
    if not sentences:
        raise ValueError("Transcript has no sentence units; cannot detect viral moments.")

    inferred_dur = max(float(total_duration_sec or 0.0), float(sentences[-1]["end"]))
    effective_end = end_bound if (end_bound is not None and end_bound > start_bound) else inferred_dur
    effective_span = max(1.0, effective_end - start_bound)

    min_clip_sec, max_clip_sec = map_duration_range(duration_range)
    target_k = auto_target_clip_count(effective_span, user_max_clips=max_clips)

    if llm_caller is None:
        client, model_name = _get_gemini_client(api_key_override=api_key_override)

        def _default_caller(prompt: str, schema: type[BaseModel]) -> Any:
            return _call_gemini_structured(client, model_name, prompt, schema)

        invoke_llm = _default_caller
    else:
        invoke_llm = llm_caller

    # --- Pass 1: Sliding windows over the WHOLE video ---
    windows = build_sliding_windows(
        sentences,
        window_sec=480.0,
        overlap_sec=60.0,
        start_bound=start_bound,
        end_bound=effective_end,
    )
    if not windows:
        raise ValueError("No transcript sentences fall within the requested timeframe.")

    raw_candidates: List[Dict[str, Any]] = []
    candidates_per_window = max(2, min(5, int(math.ceil((target_k * 1.8) / max(1, len(windows))))))

    for w_idx, window_sentences in enumerate(windows):
        first_idx = window_sentences[0]["index"]
        last_idx = window_sentences[-1]["index"]
        lines = [
            f"[S{s['index']}] ({s['start']:.1f}s-{s['end']:.1f}s) {s['text']}"
            for s in window_sentences
        ]
        window_text = "\n".join(lines)

        pass1_prompt = (
            "You are an editorial story producer identifying self-contained short-form video clips.\n"
            f"Video Title: {video_title}\n"
            f"Style Preset: {preset} | Language: {language}\n"
            f"Window {w_idx + 1} of {len(windows)} (Sentence indices S{first_idx} to S{last_idx})\n"
            f"Target clip duration: between {int(min_clip_sec)} and {int(max_clip_sec)} seconds.\n\n"
            f"Select up to {candidates_per_window} distinct, compelling moments from this window.\n"
            "REQUIREMENTS:\n"
            "1. Reference segments ONLY by integer start_sentence and end_sentence indices shown in [S#].\n"
            "2. Every candidate MUST tell a complete narrative arc: hook -> setup -> payoff/resolution.\n"
            "3. Start on an attention-grabbing opening sentence and end on a decisive closing thought.\n"
            "4. Never start mid-explanation or cut off before the punchline or conclusion.\n"
            "5. Provide a concise, specific clip title, a short punchy hook_title (max 8 words) for the opening banner, "
            "a one-sentence arc_summary explaining the hook, setup, and payoff, a 1-2 sentence social media description, "
            "and 4-6 relevant viral hashtags (e.g. ['#shorts', '#podcast']).\n\n"
            f"Transcript Sentences:\n{window_text}"
        )

        p1_result: Pass1WindowResponse = invoke_llm(pass1_prompt, Pass1WindowResponse)
        for cand in p1_result.candidates:
            snapped = snap_and_refine_boundaries(
                sentences=sentences,
                start_sentence_idx=cand.start_sentence,
                end_sentence_idx=cand.end_sentence,
                min_sec=min_clip_sec,
                max_sec=max_clip_sec,
                total_duration_sec=effective_end,
            )
            if snapped is None:
                continue
            normalized_tags: List[str] = []
            for raw_t in cand.hashtags or []:
                cleaned_t = re.sub(r"[^a-zA-Z0-9_\u0900-\u097F]+", "", str(raw_t).lstrip("#"))
                if cleaned_t:
                    tag_str = f"#{cleaned_t}"
                    if tag_str not in normalized_tags:
                        normalized_tags.append(tag_str)
            if not normalized_tags:
                normalized_tags = ["#shorts", "#viral", "#clips"]

            raw_candidates.append(
                {
                    **snapped,
                    "title": cand.title.strip()[:90],
                    "hook_title": cand.hook_title.strip()[:72],
                    "arc_summary": cand.arc_summary.strip(),
                    "description": (cand.description or cand.arc_summary or "").strip()[:320],
                    "hashtags": normalized_tags[:6],
                }
            )

        if progress_callback:
            progress_callback(0.55 * ((w_idx + 1) / max(1, len(windows))))

    if not raw_candidates:
        raise RuntimeError(
            f"No complete sentence-aligned clips matched the requested {int(min_clip_sec)}-{int(max_clip_sec)}s duration range."
        )

    # Deduplicate near-identical candidates from overlapping windows before Pass 2 scoring
    deduped_candidates: List[Dict[str, Any]] = []
    for cand in raw_candidates:
        is_dup = any(
            abs(cand["start_sentence"] - existing["start_sentence"]) <= 1
            and abs(cand["end_sentence"] - existing["end_sentence"]) <= 1
            for existing in deduped_candidates
        )
        if not is_dup:
            deduped_candidates.append(cand)

    # Compute local audio energy (librosa RMS) & speech rate for every candidate
    energy_scores = compute_audio_energy_scores(audio_path, deduped_candidates)
    for idx, cand in enumerate(deduped_candidates):
        wps, sr_score = compute_speech_rate_score(cand["word_count"], cand["duration_sec"])
        cand["speech_rate_wps"] = wps
        cand["speech_rate_score"] = sr_score
        cand["audio_energy_score"] = energy_scores[idx] if idx < len(energy_scores) else 50

    # --- Pass 2: Rubric scoring in batches (never asking LLM for final score) ---
    batch_size = 10
    rubric_by_idx: Dict[int, Pass2RubricItem] = {}
    total_batches = max(1, math.ceil(len(deduped_candidates) / batch_size))

    for b_idx in range(total_batches):
        start_i = b_idx * batch_size
        batch = deduped_candidates[start_i : start_i + batch_size]

        blocks: List[str] = []
        for local_offset, cand in enumerate(batch):
            global_i = start_i + local_offset
            blocks.append(
                f"Candidate {global_i} ({cand['start_time']:.1f}s - {cand['end_time']:.1f}s, "
                f"{cand['duration_sec']:.1f}s) | Title: {cand['title']}\n"
                f"Arc: {cand['arc_summary']}\n"
                f"Transcript: {cand['transcript_text'][:1600]}"
            )

        pass2_prompt = (
            "You are a strict short-form video retention evaluator.\n"
            f"Video Title: {video_title} | Style Preset: {preset}\n\n"
            "Evaluate each candidate independently using the full 0-100 scale on these 5 rubric dimensions:\n"
            "- hook_strength: How immediately compelling the first sentence is to a cold viewer.\n"
            "- story_completeness: Whether it has a genuine beginning, development, and satisfying payoff.\n"
            "- emotion_energy: Emotional resonance, stakes, humor, surprise, or conviction.\n"
            "- standalone_clarity: How easy it is to understand without watching the rest of the video.\n"
            "- pacing: Narrative momentum and absence of filler or dead weight.\n\n"
            "Be discriminating: weak or average moments should receive lower scores while standout moments earn higher ones.\n"
            "Do NOT compute an overall score. Provide a concise one-sentence score_reason grounded in the actual transcript.\n\n"
            + "\n\n---\n\n".join(blocks)
        )

        p2_result: Pass2RubricBatchResponse = invoke_llm(pass2_prompt, Pass2RubricBatchResponse)
        for item in p2_result.evaluations:
            rubric_by_idx[item.candidate_index] = item

        if progress_callback:
            progress_callback(0.55 + 0.40 * ((b_idx + 1) / total_batches))

    scored_candidates: List[Dict[str, Any]] = []
    for idx, cand in enumerate(deduped_candidates):
        ev = rubric_by_idx.get(idx)
        if ev is None:
            raise RuntimeError(f"LLM rubric scoring omitted candidate index {idx}.")

        sub_scores = {
            "hook_strength": int(ev.hook_strength),
            "story_completeness": int(ev.story_completeness),
            "emotion_energy": int(ev.emotion_energy),
            "standalone_clarity": int(ev.standalone_clarity),
            "pacing": int(ev.pacing),
            "speech_rate": int(cand["speech_rate_score"]),
            "audio_energy": int(cand["audio_energy_score"]),
            "speech_rate_wps": float(cand["speech_rate_wps"]),
        }
        final_score = compute_weighted_final_score(sub_scores)
        scored_candidates.append(
            {
                **cand,
                "virality_score": final_score,
                "sub_scores": sub_scores,
                "score_reason": ev.score_reason.strip(),
            }
        )

    selected = select_non_overlapping_spread(
        scored_candidates=scored_candidates,
        target_k=target_k,
        total_duration_sec=effective_end,
        max_overlap_ratio=0.30,
    )

    if progress_callback:
        progress_callback(1.0)

    final_clips: List[Dict[str, Any]] = []
    for rank, clip in enumerate(selected, start=1):
        final_clips.append(
            {
                "clip_id": rank,
                "tag": f"#{rank}",
                "title": clip["title"],
                "hook_title": clip["hook_title"],
                "description": clip.get("description") or clip.get("arc_summary") or "",
                "hashtags": clip.get("hashtags") or ["#shorts", "#viral", "#clips"],
                "hook_reason": clip["score_reason"],
                "start_time": clip["start_time"],
                "end_time": clip["end_time"],
                "start_sec": clip["start_time"],
                "end_sec": clip["end_time"],
                "start_sentence": clip["start_sentence"],
                "end_sentence": clip["end_sentence"],
                "duration_sec": clip["duration_sec"],
                "virality_score": clip["virality_score"],
                "viral_score": clip["virality_score"],
                "sub_scores": clip["sub_scores"],
                "score_reason": clip["score_reason"],
                "transcript_text": clip["transcript_text"],
                "caption_text": clip["transcript_text"],
            }
        )

    return final_clips
