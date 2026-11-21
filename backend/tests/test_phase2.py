from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List

import cv2
import numpy as np
import pytest

from backend.services.auto_reframe import (
    compute_ffmpeg_timeout,
    probe_video_stream,
    render_clip_single_pass,
    resolve_aspect_dimensions,
)
from backend.services.caption_burner import (
    STYLE_PRESETS,
    generate_ass_subtitles,
    measure_caption_sync_error_ms,
    select_caption_font,
)


def _create_synthetic_landscape_video(out_path: Path, duration_sec: float = 5.0) -> Path:
    """
    Create a real 1280x720 H.264 + AAC video with distinct left/center/right color bands
    so aspect-ratio, blurred-fit (no-face smartReframe), center-crop, and split-screen
    all produce measurable, visibly different frames.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size=1280x720:rate=25:duration={duration_sec}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:sample_rate=44100:duration={duration_sec}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(out_path),
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
    return out_path


def _read_mid_frame(video_path: Path) -> np.ndarray:
    cap = cv2.VideoCapture(str(video_path))
    assert cap.isOpened()
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 30)
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(1, total // 2))
    ok, frame = cap.read()
    cap.release()
    assert ok and frame is not None
    return frame


def test_aspect_ratio_dimensions_and_scaled_timeout() -> None:
    assert resolve_aspect_dimensions("9:16 Portrait") == (1080, 1920)
    assert resolve_aspect_dimensions("1:1 Square") == (1080, 1080)
    assert resolve_aspect_dimensions("16:9 Landscape") == (1920, 1080)
    assert compute_ffmpeg_timeout(10.0) >= 120
    assert compute_ffmpeg_timeout(180.0) > 180  # No longer capped at 180s


def test_ass_captions_8_styles_hindi_devanagari_hook_3s_and_sync_under_100ms(tmp_path: Path) -> None:
    # Hindi + Hinglish words with exact timestamps
    hindi_words: List[Dict[str, Any]] = [
        {"word": "नमस्ते", "start": 10.00, "end": 10.42},
        {"word": "दोस्तों,", "start": 10.45, "end": 10.90},
        {"word": "आज", "start": 10.95, "end": 11.20},
        {"word": "हम", "start": 11.22, "end": 11.45},
        {"word": "सीखेंगे", "start": 11.48, "end": 12.05},
        {"word": "वायरल", "start": 12.10, "end": 12.55},
        {"word": "क्लिप्स", "start": 12.60, "end": 13.05},
        {"word": "कैसे", "start": 13.10, "end": 13.45},
        {"word": "बनाएं।", "start": 13.50, "end": 14.00},
    ]

    assert select_caption_font("नमस्ते दुनिया", "Hindi") == "Noto Sans Devanagari"
    assert select_caption_font("Hello world", "English") == "Liberation Sans"

    # Verify all 8 original UI styles (plus ScaleReach presets) exist and render distinct palettes
    assert len(STYLE_PRESETS) >= 8
    seen_highlights = set()
    for style_id in (
        "classic",
        "cyan-slide",
        "italic-red",
        "cream-blue",
        "red-spin",
        "violet",
        "blue-glow",
        "toxic-green",
    ):
        ass_file = tmp_path / f"hindi_{style_id}.ass"
        generate_ass_subtitles(
            words=hindi_words,
            clip_start=10.0,
            clip_end=15.0,
            output_ass_path=ass_file,
            caption_style=style_id,
            res_w=1080,
            res_h=1920,
            language="Hindi",
            captions_enabled=True,
            auto_hook=True,
            hook_title="यह तरीका ज़रूर देखें",
        )
        content = ass_file.read_text(encoding="utf-8")
        assert "Noto Sans Devanagari" in content
        seen_highlights.add(STYLE_PRESETS[style_id]["highlight"])

        # Hook must appear ONLY in the first ~3.0 seconds
        hook_lines = [ln for ln in content.splitlines() if ",Hook," in ln]
        assert len(hook_lines) == 1
        fields = hook_lines[0].split(",", 9)
        assert fields[1] == "0:00:00.00"
        assert fields[2] == "0:00:03.00"

        # Every caption dialogue must have <= 2 lines (at most one \N) and <= 4 words
        cap_lines = [ln for ln in content.splitlines() if ",Caption," in ln]
        assert len(cap_lines) == len(hindi_words)
        for ln in cap_lines:
            text_part = ln.split(",", 9)[9]
            assert text_part.count("\\N") <= 1
            plain = re.sub(r"\{[^}]*\}", "", text_part).replace("\\N", " ").strip()
            assert 1 <= len(plain.split()) <= 4

        # Check caption sync accuracy against word timestamps (< 100ms)
        sync = measure_caption_sync_error_ms(ass_file, hindi_words, clip_start=10.0, clip_end=15.0)
        assert sync["count"] == len(hindi_words)
        assert sync["max_error_ms"] < 100.0, f"Caption sync error too high: {sync}"

    assert len(seen_highlights) >= 7


def test_render_aspect_ratios_smart_reframe_and_split_screen_visibly_change_output(tmp_path: Path) -> None:
    src_video = _create_synthetic_landscape_video(tmp_path / "source.mp4", duration_sec=4.0)
    sample_words = [
        {"word": "First", "start": 0.2, "end": 0.7},
        {"word": "viral", "start": 0.75, "end": 1.2},
        {"word": "moment", "start": 1.25, "end": 1.8},
        {"word": "payoff", "start": 1.9, "end": 2.6},
    ]

    # 1. 9:16 Portrait with smartReframe=True (no faces -> blurred-bg fit layout)
    out_916_smart = tmp_path / "clip_916_smart.mp4"
    res_916_smart = render_clip_single_pass(
        source_video=src_video,
        start_time=0.0,
        end_time=3.5,
        output_path=out_916_smart,
        words=sample_words,
        aspect_ratio="9:16 Portrait",
        smart_reframe=True,
        split_screen=False,
        captions_enabled=True,
        caption_style="classic",
        auto_hook=True,
        hook_title="TEST HOOK",
    )
    info_916 = probe_video_stream(out_916_smart)
    assert (info_916["width"], info_916["height"]) == (1080, 1920)
    assert info_916["has_audio"] is True
    assert res_916_smart["framing_mode"] == "blurred_fit"
    assert res_916_smart["thumbnail_path"] and Path(res_916_smart["thumbnail_path"]).exists()

    # 2. 9:16 Portrait with smartReframe=False (blind center crop) -> visibly different pixels from blurred_fit
    out_916_center = tmp_path / "clip_916_center.mp4"
    res_916_center = render_clip_single_pass(
        source_video=src_video,
        start_time=0.0,
        end_time=3.5,
        output_path=out_916_center,
        words=sample_words,
        aspect_ratio="9:16 Portrait",
        smart_reframe=False,
        split_screen=False,
        captions_enabled=False,
        auto_hook=False,
    )
    assert res_916_center["framing_mode"] == "center_crop"
    frame_smart = _read_mid_frame(out_916_smart)
    frame_center = _read_mid_frame(out_916_center)
    diff_smart_vs_center = float(np.mean(cv2.absdiff(frame_smart, frame_center)))
    assert diff_smart_vs_center > 10.0, f"smartReframe ON vs OFF did not visibly change output (diff={diff_smart_vs_center})"

    # 3. 1:1 Square -> 1080x1080
    out_11 = tmp_path / "clip_11.mp4"
    render_clip_single_pass(
        source_video=src_video,
        start_time=0.0,
        end_time=3.5,
        output_path=out_11,
        words=sample_words,
        aspect_ratio="1:1 Square",
        smart_reframe=False,
        split_screen=False,
        captions_enabled=True,
        caption_style="toxic-green",
        auto_hook=False,
    )
    info_11 = probe_video_stream(out_11)
    assert (info_11["width"], info_11["height"]) == (1080, 1080)

    # 4. 16:9 Landscape -> 1920x1080
    out_169 = tmp_path / "clip_169.mp4"
    render_clip_single_pass(
        source_video=src_video,
        start_time=0.0,
        end_time=3.5,
        output_path=out_169,
        words=sample_words,
        aspect_ratio="16:9 Landscape",
        smart_reframe=False,
        split_screen=False,
        captions_enabled=True,
        caption_style="blue-glow",
        auto_hook=False,
    )
    info_169 = probe_video_stream(out_169)
    assert (info_169["width"], info_169["height"]) == (1920, 1080)

    # 5. Split-screen mode -> 1080x1920 with speaker top + background video bottom (visibly differs in bottom half!)
    out_split = tmp_path / "clip_split.mp4"
    res_split = render_clip_single_pass(
        source_video=src_video,
        start_time=0.0,
        end_time=3.5,
        output_path=out_split,
        words=sample_words,
        aspect_ratio="9:16 Portrait",
        smart_reframe=True,
        split_screen=True,
        background_video="⛏️ Minecraft",
        captions_enabled=True,
        caption_style="violet",
        auto_hook=True,
        hook_title="SPLIT TEST",
    )
    info_split = probe_video_stream(out_split)
    assert (info_split["width"], info_split["height"]) == (1080, 1920)
    assert res_split["framing_mode"].startswith("split_")
    frame_split = _read_mid_frame(out_split)
    # Bottom half (rows 960..1920) must differ sharply between split-screen and single-pane
    diff_bottom = float(np.mean(cv2.absdiff(frame_split[960:, :, :], frame_smart[960:, :, :])))
    assert diff_bottom > 15.0, f"splitScreen bottom half did not visibly change output (diff={diff_bottom})"
