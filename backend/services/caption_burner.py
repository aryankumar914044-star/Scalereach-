from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")

# All 8 UI caption styles with distinct ASS BGR color palettes, border/shadow, and casing/italic rules
STYLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "classic": {
        "base": "&H00FFFFFF",
        "highlight": "&H0000F2FF",  # Bright yellow (#FFF200 in BGR)
        "outline": "&H00000000",
        "back": "&H80000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 2,
        "uppercase": True,
    },
    "cyan-slide": {
        "base": "&H00FFFFFF",
        "highlight": "&H00FFB519",  # Vivid cyan (#19B5FF in BGR)
        "outline": "&H001A1000",
        "back": "&H88000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 3,
        "uppercase": True,
    },
    "italic-red": {
        "base": "&H00FFFFFF",
        "highlight": "&H001A2AFF",  # Punchy red (#FF2A1A in BGR)
        "outline": "&H00000000",
        "back": "&H88000000",
        "italic": -1,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 3,
        "uppercase": True,
    },
    "cream-blue": {
        "base": "&H00E8F4FF",       # Warm cream (#FFF4E8 in BGR)
        "highlight": "&H00FFA479",  # Soft sky blue (#79A4FF in BGR)
        "outline": "&H00181818",
        "back": "&H80000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 2,
        "uppercase": False,
    },
    "red-spin": {
        "base": "&H00F5F5F5",
        "highlight": "&H002020FF",  # Crimson pop (#FF2020 in BGR)
        "outline": "&H00000000",
        "back": "&HA0000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 6,
        "shadow": 3,
        "uppercase": True,
    },
    "violet": {
        "base": "&H00FFFFFF",
        "highlight": "&H00FF5A6A",  # Electric violet (#6A5AFF in BGR)
        "outline": "&H00240814",
        "back": "&H88000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 3,
        "uppercase": True,
    },
    "blue-glow": {
        "base": "&H00FFFFFF",
        "highlight": "&H00FFA03A",  # Bright glow blue (#3AA0FF in BGR)
        "outline": "&H00994400",
        "back": "&H90000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 6,
        "shadow": 4,
        "uppercase": False,
    },
    "toxic-green": {
        "base": "&H00E8FFE8",
        "highlight": "&H003AE03E",  # Neon toxic green (#3EE03A in BGR)
        "outline": "&H00001800",
        "back": "&H90000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 6,
        "shadow": 3,
        "uppercase": True,
    },
    "hormozi": {
        "base": "&H00FFFFFF",
        "highlight": "&H0000D7FF",  # Hormozi punchy gold-yellow (#FFD700 in BGR)
        "outline": "&H00000000",
        "back": "&HB0000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 7,
        "shadow": 4,
        "uppercase": True,
    },
    "minimal-clean": {
        "base": "&H00F8F8F8",
        "highlight": "&H00FFFFFF",  # Crisp pure white highlight with soft dark pill shadow
        "outline": "&H00141414",
        "back": "&H70000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 3,
        "shadow": 2,
        "uppercase": False,
    },
    "karaoke": {
        "base": "&H00D8D8D8",
        "highlight": "&H0000F2FF",  # Vibrant karaoke gold-yellow active word pop
        "outline": "&H00000000",
        "back": "&H90000000",
        "italic": 0,
        "border_style": 1,
        "outline_w": 5,
        "shadow": 3,
        "uppercase": True,
    },
}

STYLE_ALIASES: Dict[str, str] = {
    "hormozi bold pop": "hormozi",
    "hormozi-bold-pop": "hormozi",
    "hormozi_bold_pop": "hormozi",
    "minimal clean": "minimal-clean",
    "minimal_clean": "minimal-clean",
    "minimal": "minimal-clean",
    "karaoke highlight": "karaoke",
    "karaoke-highlight": "karaoke",
    "karaoke_highlight": "karaoke",
}


def _format_ass_time(seconds: float) -> str:
    """Format seconds into ASS H:MM:SS.cc with exact centisecond rounding (max error <= 5ms)."""
    total_cs = max(0, int(round(seconds * 100.0)))
    hours, rem = divmod(total_cs, 360000)
    minutes, rem = divmod(rem, 6000)
    secs, cs = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _parse_ass_time(ts: str) -> float:
    parts = ts.strip().split(":")
    if len(parts) != 3:
        return 0.0
    h = int(parts[0])
    m = int(parts[1])
    s = float(parts[2])
    return h * 3600.0 + m * 60.0 + s


def _escape_ass_text(text: str) -> str:
    cleaned = text.replace("\\", " ").replace("{", "").replace("}", "").replace("\n", " ").strip()
    return re.sub(r"\s+", " ", cleaned)


def select_caption_font(text_sample: str, language: str = "Auto") -> str:
    """Pick a Devanagari-capable font whenever text contains Hindi/Devanagari script."""
    lang = (language or "").lower()
    if DEVANAGARI_RE.search(text_sample or "") or "hindi" in lang or lang == "hi":
        return "Noto Sans Devanagari"
    return "Liberation Sans"


def compute_safe_margins(res_w: int, res_h: int, split_screen: bool = False) -> Dict[str, int]:
    """
    Compute platform-safe margins so captions never collide with TikTok/Reels/Shorts
    right-hand interaction buttons or bottom description/progress overlays.
    """
    if split_screen and res_h >= res_w:
        # Center captions slightly above the bottom half seam so neither speaker nor gameplay hides text
        return {
            "margin_l": max(48, int(round(res_w * 0.08))),
            "margin_r": max(72, int(round(res_w * 0.11))),
            "margin_v": max(120, int(round(res_h * 0.44))),
            "hook_margin_v": max(64, int(round(res_h * 0.065))),
            "font_size": max(42, int(round(res_w * 0.058))),
            "hook_font_size": max(34, int(round(res_w * 0.044))),
        }

    if res_h > res_w:
        # 9:16 vertical (1080x1920): avoid right-side buttons (~120-150px) and bottom UI (~320-380px)
        return {
            "margin_l": max(56, int(round(res_w * 0.075))),
            "margin_r": max(96, int(round(res_w * 0.13))),
            "margin_v": max(220, int(round(res_h * 0.19))),
            "hook_margin_v": max(110, int(round(res_h * 0.10))),
            "font_size": max(44, int(round(res_w * 0.060))),
            "hook_font_size": max(36, int(round(res_w * 0.046))),
        }

    if res_w == res_h:
        # 1:1 square (1080x1080)
        return {
            "margin_l": max(56, int(round(res_w * 0.07))),
            "margin_r": max(56, int(round(res_w * 0.07))),
            "margin_v": max(110, int(round(res_h * 0.12))),
            "hook_margin_v": max(64, int(round(res_h * 0.07))),
            "font_size": max(42, int(round(res_w * 0.052))),
            "hook_font_size": max(34, int(round(res_w * 0.040))),
        }

    # 16:9 landscape (1920x1080)
    return {
        "margin_l": max(100, int(round(res_w * 0.08))),
        "margin_r": max(100, int(round(res_w * 0.08))),
        "margin_v": max(90, int(round(res_h * 0.10))),
        "hook_margin_v": max(56, int(round(res_h * 0.06))),
        "font_size": max(46, int(round(res_h * 0.056))),
        "hook_font_size": max(38, int(round(res_h * 0.044))),
    }


def _collect_clip_words(
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    fallback_transcript: str = "",
    edited_caption_text: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Build exact clip-relative word timestamps.
    If edited_caption_text is supplied by the user (Phase 3 edit/translate), map the edited
    tokens smoothly across the clip's real spoken time span.
    """
    clip_dur = max(0.5, float(clip_end) - float(clip_start))
    clipped: List[Dict[str, Any]] = []

    for w in words or []:
        text = _escape_ass_text(str(w.get("word", "")))
        if not text:
            continue
        w_start = float(w.get("start", 0.0))
        w_end = float(w.get("end", w_start + 0.2))
        if w_end <= clip_start + 0.01 or w_start >= clip_end - 0.01:
            continue
        rel_s = max(0.0, w_start - clip_start)
        rel_e = min(clip_dur, max(rel_s + 0.05, w_end - clip_start))
        clipped.append({"word": text, "start": rel_s, "end": rel_e})

    if edited_caption_text and edited_caption_text.strip():
        tokens = [_escape_ass_text(tok) for tok in edited_caption_text.strip().split()]
        tokens = [t for t in tokens if t]
        if tokens:
            span_start = clipped[0]["start"] if clipped else 0.05
            span_end = clipped[-1]["end"] if clipped else max(0.5, clip_dur - 0.1)
            span_dur = max(0.4, span_end - span_start)
            # Weight duration slightly by character length for natural reading sync
            weights = [max(2, len(t)) for t in tokens]
            total_w = float(sum(weights))
            cursor = span_start
            remapped: List[Dict[str, Any]] = []
            for tok, wt in zip(tokens, weights):
                seg_d = span_dur * (wt / total_w)
                remapped.append(
                    {
                        "word": tok,
                        "start": round(cursor, 3),
                        "end": round(min(clip_dur, cursor + seg_d), 3),
                    }
                )
                cursor += seg_d
            return remapped

    if clipped:
        return clipped

    # Only if word timestamps were completely absent, distribute fallback transcript across clip
    tokens = [_escape_ass_text(tok) for tok in (fallback_transcript or "").split()]
    tokens = [t for t in tokens if t]
    if not tokens:
        return []
    step = clip_dur / len(tokens)
    return [
        {
            "word": tok,
            "start": round(idx * step, 3),
            "end": round(min(clip_dur, (idx + 1) * step), 3),
        }
        for idx, tok in enumerate(tokens)
    ]


def group_words_for_captions(
    timed_words: List[Dict[str, Any]],
    min_words: int = 3,
    max_words: int = 4,
    pause_break_sec: float = 0.55,
    max_chars_per_group: int = 32,
) -> List[List[Dict[str, Any]]]:
    """
    Partition timed words into crisp 3-4 word groups (never exceeding max_words),
    breaking cleanly on sentence punctuation or noticeable pauses.
    """
    groups: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_chars = 0

    for item in timed_words:
        word = item["word"]
        if current:
            gap = float(item["start"]) - float(current[-1]["end"])
            if (
                len(current) >= max_words
                or gap >= pause_break_sec
                or (len(current) >= min_words and current_chars + len(word) + 1 > max_chars_per_group)
            ):
                groups.append(current)
                current = []
                current_chars = 0

        current.append(item)
        current_chars += len(word) + (1 if current_chars > 0 else 0)

        if re.search(r"[.!?।॥]$", word) and len(current) >= 2:
            groups.append(current)
            current = []
            current_chars = 0

    if current:
        groups.append(current)

    return groups


def _format_group_max_two_lines(
    group: List[Dict[str, Any]],
    active_idx: int,
    base_color: str,
    highlight_color: str,
    uppercase: bool,
    has_devanagari: bool,
    max_line_chars: int = 18,
) -> str:
    """
    Format a 3-4 word group with active word highlight and at most 2 lines (max one \\N).
    Never uppercases Devanagari script.
    """
    rendered_tokens: List[str] = []
    plain_words: List[str] = []

    for j, item in enumerate(group):
        w = item["word"]
        display_w = w.upper() if (uppercase and not has_devanagari) else w
        plain_words.append(display_w)
        if j == active_idx:
            rendered_tokens.append(
                f"{{\\c{highlight_color}\\fscx108\\fscy108}}{display_w}{{\\c{base_color}\\fscx100\\fscy100}}"
            )
        else:
            rendered_tokens.append(f"{{\\c{base_color}}}{display_w}")

    total_len = sum(len(w) for w in plain_words) + max(0, len(plain_words) - 1)
    if len(rendered_tokens) <= 2 or total_len <= max_line_chars:
        return " ".join(rendered_tokens)

    # Split cleanly into exactly 2 balanced lines
    split_at = (len(rendered_tokens) + 1) // 2
    line1 = " ".join(rendered_tokens[:split_at])
    line2 = " ".join(rendered_tokens[split_at:])
    return f"{line1}\\N{line2}"


def _wrap_hook_max_two_lines(hook_text: str, max_chars_per_line: int = 26) -> str:
    clean = _escape_ass_text(hook_text)
    if not clean:
        return ""
    words = clean.split()
    if len(clean) <= max_chars_per_line or len(words) <= 2:
        return clean
    mid = (len(words) + 1) // 2
    return " ".join(words[:mid]) + "\\N" + " ".join(words[mid:])


def generate_ass_subtitles(
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    output_ass_path: str | Path,
    caption_style: str = "classic",
    res_w: int = 1080,
    res_h: int = 1920,
    language: str = "Auto",
    captions_enabled: bool = True,
    auto_hook: bool = False,
    hook_title: str = "",
    split_screen: bool = False,
    fallback_transcript: str = "",
    edited_caption_text: Optional[str] = None,
) -> Path:
    """
    Generate a production-grade ASS file with:
      - Exact word-by-word highlight (<100ms sync error)
      - 3-4 words per group, max 2 lines
      - Platform-safe margins avoiding TikTok/Reels/Shorts overlays
      - All 8 UI styles
      - Automatic Noto Sans Devanagari font selection for Hindi/Devanagari
      - Optional Hook overlay strictly limited to the first ~3.0 seconds
    """
    out_path = Path(output_ass_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    raw_style_key = (caption_style or "classic").strip().lower()
    style_key = STYLE_ALIASES.get(raw_style_key, raw_style_key)
    style_cfg = STYLE_PRESETS.get(style_key, STYLE_PRESETS["classic"])
    clip_dur = max(0.5, float(clip_end) - float(clip_start))

    timed_words = (
        _collect_clip_words(
            words=words,
            clip_start=clip_start,
            clip_end=clip_end,
            fallback_transcript=fallback_transcript,
            edited_caption_text=edited_caption_text,
        )
        if captions_enabled
        else []
    )

    combined_text = " ".join(w["word"] for w in timed_words) + " " + (hook_title or "")
    has_devanagari = bool(DEVANAGARI_RE.search(combined_text))
    font_name = select_caption_font(combined_text, language=language)
    margins = compute_safe_margins(res_w, res_h, split_screen=split_screen)

    header = [
        "[Script Info]",
        "Title: Scalereach Viral Captions",
        "ScriptType: v4.00+",
        f"PlayResX: {res_w}",
        f"PlayResY: {res_h}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            f"Style: Caption,{font_name},{margins['font_size']},"
            f"{style_cfg['base']},{style_cfg['highlight']},{style_cfg['outline']},{style_cfg['back']},"
            f"-1,{style_cfg['italic']},0,0,100,100,0.5,0,{style_cfg['border_style']},"
            f"{style_cfg['outline_w']},{style_cfg['shadow']},2,"
            f"{margins['margin_l']},{margins['margin_r']},{margins['margin_v']},1"
        ),
        (
            f"Style: Hook,{font_name},{margins['hook_font_size']},"
            f"&H00FFFFFF,&H0000F2FF,&H00000000,&HB0000000,"
            f"-1,0,0,0,100,100,0.5,0,3,10,0,8,"
            f"{margins['margin_l']},{margins['margin_r']},{margins['hook_margin_v']},1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    events: List[str] = []

    # Opening Hook overlay ONLY in the first ~3.0 seconds
    if auto_hook and hook_title and hook_title.strip():
        hook_end = min(3.0, clip_dur)
        hook_display = hook_title.strip()
        if not has_devanagari:
            hook_display = hook_display.upper()
        wrapped_hook = _wrap_hook_max_two_lines(hook_display)
        if wrapped_hook:
            events.append(
                f"Dialogue: 1,{_format_ass_time(0.0)},{_format_ass_time(hook_end)},"
                f"Hook,,0,0,0,,{{\\fad(120,180)}}{wrapped_hook}"
            )

    # Word-by-word highlighted captions in 3-4 word groups
    if captions_enabled and timed_words:
        groups = group_words_for_captions(timed_words, min_words=3, max_words=4)
        for g_idx, group in enumerate(groups):
            next_group_start = (
                float(groups[g_idx + 1][0]["start"]) if g_idx + 1 < len(groups) else clip_dur
            )
            for active_idx, active_word in enumerate(group):
                w_start = float(active_word["start"])
                if active_idx + 1 < len(group):
                    w_end = float(group[active_idx + 1]["start"])
                else:
                    w_end = min(next_group_start, max(float(active_word["end"]), w_start + 0.08))
                w_end = min(clip_dur, max(w_start + 0.05, w_end))

                text_line = _format_group_max_two_lines(
                    group=group,
                    active_idx=active_idx,
                    base_color=style_cfg["base"],
                    highlight_color=style_cfg["highlight"],
                    uppercase=bool(style_cfg["uppercase"]),
                    has_devanagari=has_devanagari,
                )
                events.append(
                    f"Dialogue: 0,{_format_ass_time(w_start)},{_format_ass_time(w_end)},"
                    f"Caption,,0,0,0,,{text_line}"
                )

    out_path.write_text("\n".join(header + events) + "\n", encoding="utf-8")
    return out_path


def measure_caption_sync_error_ms(
    ass_path: str | Path,
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
) -> Dict[str, float]:
    """
    Verify generated ASS Caption Dialogue start timestamps against the original
    word timestamps (target max error < 100ms).
    """
    timed_words = _collect_clip_words(words, clip_start, clip_end)
    dialogue_starts: List[float] = []
    for line in Path(ass_path).read_text(encoding="utf-8").splitlines():
        if line.startswith("Dialogue:") and ",Caption," in line:
            fields = line.split(",", 9)
            if len(fields) >= 3:
                dialogue_starts.append(_parse_ass_time(fields[1]))

    if not timed_words or not dialogue_starts:
        return {"count": 0.0, "mean_error_ms": 0.0, "max_error_ms": 0.0}

    n = min(len(timed_words), len(dialogue_starts))
    errors_ms = [
        abs(dialogue_starts[i] - float(timed_words[i]["start"])) * 1000.0
        for i in range(n)
    ]
    return {
        "count": float(n),
        "mean_error_ms": round(sum(errors_ms) / n, 2),
        "max_error_ms": round(max(errors_ms), 2),
    }


def escape_ffmpeg_filter_path(path: Path) -> str:
    raw = str(path).replace("\\", "/")
    return raw.replace(":", "\\:").replace("'", "\\'")


def burn_captions_to_video(
    input_video_path: str | Path,
    output_video_path: str | Path,
    words: List[Dict[str, Any]],
    clip_start: float,
    clip_end: float,
    caption_style: str = "classic",
    captions_enabled: bool = True,
    auto_hook: bool = True,
    hook_title: str = "",
    res_w: int = 1080,
    res_h: int = 1920,
    language: str = "Auto",
    split_screen: bool = False,
    fallback_transcript: str = "",
    edited_caption_text: Optional[str] = None,
) -> Path:
    """
    Standalone caption burn helper (kept for API/backward compatibility; the main
    pipeline uses single-pass FFmpeg via auto_reframe.render_clip_single_pass).
    """
    src = Path(input_video_path).resolve()
    dst = Path(output_video_path).resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        raise FileNotFoundError(f"Input video not found: {src}")

    clip_dur = max(1.0, float(clip_end) - float(clip_start))
    timeout_sec = max(120, int(clip_dur * 8) + 90)

    ass_path = dst.with_suffix(".ass")
    generate_ass_subtitles(
        words=words,
        clip_start=clip_start,
        clip_end=clip_end,
        output_ass_path=ass_path,
        caption_style=caption_style,
        res_w=res_w,
        res_h=res_h,
        language=language,
        captions_enabled=captions_enabled,
        auto_hook=auto_hook,
        hook_title=hook_title,
        split_screen=split_screen,
        fallback_transcript=fallback_transcript,
        edited_caption_text=edited_caption_text,
    )

    vf = f"ass='{escape_ffmpeg_filter_path(ass_path)}'"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size < 10_000:
        raise RuntimeError(f"FFmpeg caption burn failed: {proc.stderr[-600:]}")
    return dst
