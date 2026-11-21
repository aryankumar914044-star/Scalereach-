from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import db, main
from backend.services.auto_reframe import probe_video_stream, render_clip_single_pass
from backend.services.caption_burner import (
    STYLE_ALIASES,
    STYLE_PRESETS,
    generate_ass_subtitles,
)
from backend.services.viral_analyzer import DURATION_RANGE_MAP


def _make_test_video(path: Path, duration_sec: float = 5.0, width: int = 1280, height: int = 720) -> Path:
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={width}x{height}:rate=24:duration={duration_sec}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:duration={duration_sec}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        str(path),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=60)
    return path


def test_health_reports_scalereach_v3_pipeline() -> None:
    client = TestClient(main.app)
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["version"] == "3.0.0"
    assert body["pythonConnected"] is True
    assert body["pipeline"] == ["yt-dlp", "faster-whisper", "gemini", "mediapipe", "ffmpeg"]


def test_new_duration_ranges_and_caption_style_presets(tmp_path: Path) -> None:
    assert DURATION_RANGE_MAP["15 - 30s"] == (15.0, 30.0)
    assert DURATION_RANGE_MAP["30 - 60s"] == (30.0, 60.0)
    assert DURATION_RANGE_MAP["60 - 90s"] == (60.0, 90.0)

    for key in ("hormozi", "minimal-clean", "karaoke"):
        assert key in STYLE_PRESETS

    assert STYLE_ALIASES["hormozi bold pop"] == "hormozi"
    assert STYLE_ALIASES["minimal clean"] == "minimal-clean"
    assert STYLE_ALIASES["karaoke highlight"] == "karaoke"

    ass_out = tmp_path / "hormozi.ass"
    words = [
        {"word": "Stop", "start": 0.1, "end": 0.4},
        {"word": "scrolling", "start": 0.45, "end": 0.9},
        {"word": "right", "start": 0.95, "end": 1.3},
        {"word": "now", "start": 1.35, "end": 1.8},
    ]
    generate_ass_subtitles(
        words=words,
        clip_start=0.0,
        clip_end=3.0,
        output_ass_path=ass_out,
        caption_style="Hormozi Bold Pop",
        res_w=1080,
        res_h=1920,
        auto_hook=True,
        hook_title="STOP SCROLLING NOW",
    )
    ass_text = ass_out.read_text(encoding="utf-8")
    assert "STOP SCROLLING NOW" in ass_text
    assert "&H0000D7FF" in ass_text


def test_dual_speaker_split_screen_render_produces_vertical_1080x1920(tmp_path: Path) -> None:
    src = _make_test_video(tmp_path / "podcast.mp4", duration_sec=3.0, width=1280, height=720)
    dst = tmp_path / "dual_out.mp4"

    dual_track = {
        "mode": "dual_speaker_split",
        "has_faces": True,
        "dual_speaker": True,
        "left_cx": 0.25,
        "right_cx": 0.75,
        "face_ratio": 0.9,
        "keyframes": [(0.0, 0.25)],
        "scene_cuts": [],
        "detector": "mediapipe",
    }

    with patch("backend.services.auto_reframe.analyze_smart_reframe_track", return_value=dual_track):
        res = render_clip_single_pass(
            source_video=src,
            start_time=0.0,
            end_time=2.5,
            output_path=dst,
            aspect_ratio="9:16 Portrait",
            smart_reframe=True,
            split_screen=False,
            captions_enabled=True,
            caption_style="karaoke",
            auto_hook=True,
            hook_title="TWO SPEAKERS TEST",
            fallback_transcript="This is a two speaker podcast test clip.",
        )

    assert dst.exists() and dst.stat().st_size > 10_000
    assert res["framing_mode"] == "dual_speaker_split"
    assert res["dual_speaker"] is True
    probed = probe_video_stream(dst)
    assert (probed["width"], probed["height"]) == (1080, 1920)


def test_process_video_multipart_and_status_endpoint_end_to_end(tmp_path: Path, monkeypatch: Any) -> None:
    test_db = tmp_path / "cloudrun_e2e.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(test_db))
    db.init_db()

    uploads_dir = tmp_path / "uploads"
    outputs_dir = tmp_path / "outputs"
    temp_dir = tmp_path / "temp_dl"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)

    from backend.services import downloader as dl_mod

    monkeypatch.setattr(main, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(dl_mod, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(main, "OUTPUTS_DIR", outputs_dir)
    monkeypatch.setattr(main, "TEMP_DOWNLOADS_DIR", temp_dir)

    sample_mp4 = _make_test_video(tmp_path / "upload_src.mp4", duration_sec=4.0, width=1280, height=720)

    fake_transcript: Dict[str, Any] = {
        "language": "en",
        "language_probability": 0.99,
        "text": "Here is the secret hook. Most creators miss this payoff.",
        "words": [
            {"word": "Here", "start": 0.1, "end": 0.4},
            {"word": "is", "start": 0.4, "end": 0.6},
            {"word": "the", "start": 0.6, "end": 0.8},
            {"word": "secret", "start": 0.8, "end": 1.3},
            {"word": "hook.", "start": 1.3, "end": 1.8},
            {"word": "Most", "start": 1.9, "end": 2.3},
            {"word": "creators", "start": 2.3, "end": 2.8},
            {"word": "miss", "start": 2.8, "end": 3.1},
            {"word": "this", "start": 3.1, "end": 3.4},
            {"word": "payoff.", "start": 3.4, "end": 3.8},
        ],
        "segments": [
            {"id": 0, "start": 0.1, "end": 3.8, "text": "Here is the secret hook. Most creators miss this payoff."}
        ],
        "sentences": [
            {"index": 0, "start": 0.1, "end": 1.8, "text": "Here is the secret hook."},
            {"index": 1, "start": 1.9, "end": 3.8, "text": "Most creators miss this payoff."},
        ],
        "audio_path": None,
        "source": "faster-whisper",
    }

    fake_clips = [
        {
            "title": "The Secret Creator Hook",
            "hook_title": "THE SECRET CREATOR HOOK",
            "start_time": 0.0,
            "end_time": 3.8,
            "virality_score": 91,
            "viral_score": 91,
            "sub_scores": {
                "hook_strength": 94,
                "story_completeness": 90,
                "emotion_energy": 88,
                "standalone_clarity": 92,
                "pacing": 89,
            },
            "score_reason": "Opens with an immediate curiosity hook and closes with a crisp payoff.",
            "hook_reason": "Immediate curiosity hook in first 2 seconds.",
            "description": "Why most creators miss the hook-to-payoff loop in short-form video.",
            "hashtags": ["#shorts", "#creator", "#viralhooks"],
            "transcript_text": "Here is the secret hook. Most creators miss this payoff.",
        }
    ]

    with (
        patch("backend.main.transcribe_video", return_value=fake_transcript),
        patch("backend.main.analyze_viral_clips", return_value=fake_clips),
    ):
        client = TestClient(main.app)
        with sample_mp4.open("rb") as fh:
            post_res = client.post(
                "/api/process-video",
                files={"file": ("upload_src.mp4", fh, "video/mp4")},
                data={
                    "durationRange": "15 - 30s",
                    "aspectRatio": "9:16 Portrait",
                    "captionStyle": "Hormozi Bold Pop",
                    "maxClips": "1",
                },
            )
        assert post_res.status_code == 200, post_res.text
        job_id = post_res.json()["job_id"]

        deadline = time.time() + 45.0
        status_body: Dict[str, Any] = {}
        while time.time() < deadline:
            st = client.get(f"/api/status/{job_id}")
            assert st.status_code == 200
            status_body = st.json()
            if status_body["status"] in ("completed", "failed"):
                break
            time.sleep(0.25)

        assert status_body["status"] == "completed", f"Job failed: {status_body}"
        assert status_body["progress"] == 100
        assert isinstance(status_body.get("logs"), list) and len(status_body["logs"]) >= 4
        assert len(status_body["clips"]) == 1

        clip = status_body["clips"][0]
        assert clip["virality_score"] == 91
        assert clip["viral_score"] == 91
        assert clip["score"] == "91"
        assert clip["description"] == "Why most creators miss the hook-to-payoff loop in short-form video."
        assert clip["hashtags"] == ["#shorts", "#creator", "#viralhooks"]
        assert clip["hookReason"] == "Immediate curiosity hook in first 2 seconds."
        assert clip["videoUrl"] == f"/outputs/{job_id}/clip_1.mp4"

        rendered_mp4 = outputs_dir / job_id / "clip_1.mp4"
        rendered_thumb = outputs_dir / job_id / "clip_1_thumb.jpg"
        assert rendered_mp4.exists() and rendered_mp4.stat().st_size > 10_000
        assert rendered_thumb.exists() and rendered_thumb.stat().st_size > 1_000


def test_cloud_run_dockerfile_and_requirements_are_complete() -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    dockerfile = (backend_dir / "Dockerfile").read_text(encoding="utf-8")
    reqs = (backend_dir / "requirements.txt").read_text(encoding="utf-8").lower()

    assert "python:3.11-slim" in dockerfile
    for pkg in ("ffmpeg", "libgl1", "libglib2.0-0", "curl", "nodejs"):
        assert pkg in dockerfile
    assert "EXPOSE 8080" in dockerfile
    assert "uvicorn main:app" in dockerfile

    for dep in (
        "fastapi",
        "uvicorn",
        "python-multipart",
        "yt-dlp",
        "faster-whisper",
        "google-genai",
        "mediapipe",
        "opencv-python-headless",
        "numpy",
        "pydantic",
    ):
        assert dep in reqs
