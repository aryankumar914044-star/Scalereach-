from __future__ import annotations

import hashlib
import hmac
import http.server
import io
import json
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from backend import db
from backend import main as backend_main
from backend.services.caption_burner import (
    generate_ass_subtitles,
    measure_caption_sync_error_ms,
    select_caption_font,
)
from backend.services.transcriber import resolve_language_params
from backend.services.translator import TranslatedCaptionResponse, translate_caption_text
from backend.services.viral_analyzer import build_sentences
from backend.services.webhooks import dispatch_job_webhooks, sign_webhook_payload


def _probe_video(path: Path) -> Dict[str, Any]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    out = subprocess.check_output(cmd, text=True)
    data = json.loads(out)
    vstream = next(s for s in data["streams"] if s.get("codec_type") == "video")
    return {
        "width": int(vstream["width"]),
        "height": int(vstream["height"]),
        "duration": float(data["format"]["duration"]),
    }


def _create_synthetic_video(out_path: Path, duration_sec: float = 28.0) -> Path:
    """Generate a fast 1280x720 MP4 with sine audio for real FFmpeg re-render tests."""
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size=1280x720:rate=24:duration={duration_sec:.1f}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:duration={duration_sec:.1f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return out_path


def _seed_completed_job_with_clip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Dict[str, Any]:
    db_file = tmp_path / "phase3_test.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(db_file))
    monkeypatch.setattr(backend_main, "OUTPUTS_DIR", tmp_path / "outputs")
    (tmp_path / "outputs").mkdir(parents=True, exist_ok=True)
    db.init_db()

    source_video = _create_synthetic_video(tmp_path / "source.mp4", duration_sec=28.0)

    # 6 clear sentences spanning 0..27s (~4.3s each)
    sentences_spec = [
        (0.5, 4.2, "Welcome back to the founder podcast episode."),
        (5.0, 9.2, "Here is the exact mistake that cost us two million dollars."),
        (10.0, 14.3, "We ignored customer retention for six straight months."),
        (15.2, 19.5, "Then we rebuilt onboarding in one weekend and churn dropped by half."),
        (20.4, 24.0, "That single weekend saved the entire company from shutting down."),
        (24.8, 27.5, "Always measure retention before spending a dollar on ads."),
    ]
    words: List[Dict[str, Any]] = []
    for s_start, s_end, text in sentences_spec:
        tokens = text.split()
        step = (s_end - s_start) / len(tokens)
        for i, tok in enumerate(tokens):
            words.append(
                {
                    "word": tok,
                    "start": round(s_start + i * step, 3),
                    "end": round(s_start + (i + 1) * step, 3),
                }
            )
    sentences = build_sentences(words)

    job_id = "job_phase3_01"
    db.create_job(
        job_id,
        {
            "url": "/uploads/source.mp4",
            "sourcePath": str(source_video),
            "videoTitle": "Founder Retention Breakdown",
            "platform": "Local Upload",
            "durationSec": 28.0,
            "aspectRatio": "9:16 Portrait",
            "preset": "Viral Clips",
            "durationRange": "0 - 30s",
            "language": "English",
            "captionsEnabled": True,
            "captionStyle": "classic",
            "autoHook": True,
            "smartReframe": False,
            "splitScreen": False,
        },
    )
    db.update_job(job_id, source_path=str(source_video), duration_sec=28.0, status="completed", stage=3, progress=100)
    db.save_transcript(
        job_id,
        language="en",
        language_probability=0.99,
        source="faster-whisper",
        full_text=" ".join(s["text"] for s in sentences),
        segments=[],
        words=words,
        sentences=sentences,
        audio_path=None,
    )

    # Create initial rendered clip file on disk
    job_out = tmp_path / "outputs" / job_id
    job_out.mkdir(parents=True, exist_ok=True)
    clip1_path = job_out / "clip_1.mp4"
    _create_synthetic_video(clip1_path, duration_sec=5.0)

    clips = db.replace_job_clips(
        job_id,
        [
            {
                "tag": "#1",
                "title": "Two Million Dollar Mistake",
                "hook_title": "Our $2M Mistake",
                "start_sec": 5.0,
                "end_sec": 14.3,
                "duration_str": "0:09",
                "virality_score": 84,
                "sub_scores": {
                    "hook_strength": 88,
                    "story_completeness": 82,
                    "emotion_energy": 80,
                    "standalone_clarity": 85,
                    "pacing": 84,
                    "speech_rate": 78,
                    "audio_energy": 76,
                },
                "score_reason": "Opens with a concrete $2M hook and clearly resolves the retention lesson.",
                "transcript": "Here is the exact mistake that cost us two million dollars. We ignored customer retention for six straight months.",
                "caption_style": "classic",
                "aspect_ratio": "9:16 Portrait",
                "language": "en",
                "status": "ready",
                "progress": 100,
                "video_path": str(clip1_path),
                "video_url": f"/outputs/{job_id}/clip_1.mp4",
                "download_url": f"/api/jobs/{job_id}/clips/1/download",
            }
        ],
    )
    return {"job_id": job_id, "clip": clips[0], "source_video": source_video, "sentences": sentences}


def test_clip_rerender_extend_translate_regenerate_and_zip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    seeded = _seed_completed_job_with_clip(tmp_path, monkeypatch)
    job_id = seeded["job_id"]
    clip_id = seeded["clip"]["id"]
    client = TestClient(backend_main.app)

    # 1. Re-render with trimmed timestamps, edited captions, new style, and 1:1 Square aspect ratio
    render_resp = client.post(
        f"/api/clips/{clip_id}/render",
        json={
            "title": "Trimmed Retention Hook",
            "start_sec": 5.0,
            "end_sec": 10.0,
            "edited_caption_text": "Custom edited caption text for square output.",
            "caption_style": "violet",
            "aspect_ratio": "1:1 Square",
        },
    )
    assert render_resp.status_code == 200, render_resp.text
    rendered = render_resp.json()
    assert rendered["title"] == "Trimmed Retention Hook"
    assert rendered["caption_style"] == "violet"
    assert rendered["aspect_ratio"] == "1:1 Square"
    assert rendered["edited_caption_text"] == "Custom edited caption text for square output."
    assert "?v=" in rendered["video_url"]
    probed = _probe_video(Path(rendered["video_path"]))
    assert probed["width"] == 1080 and probed["height"] == 1080
    assert 4.0 <= probed["duration"] <= 6.0
    assert rendered["thumbnailPath"] and Path(rendered["thumbnailPath"]).exists()

    # 2. Extend +10s at end (snapping cleanly to a later sentence boundary)
    ext_resp = client.post(
        f"/api/clips/{clip_id}/extend",
        json={"delta_start_sec": 0.0, "delta_end_sec": 10.0, "snap_to_sentence": True},
    )
    assert ext_resp.status_code == 200, ext_resp.text
    extended = ext_resp.json()
    assert extended["end_sec"] > rendered["end_sec"] + 5.0
    # Snapped to sentence end (19.5 + 0.5 = 20.0)
    assert abs(extended["end_sec"] - 20.0) <= 0.6

    # 3. Caption translation into Hindi (stubbing Gemini call, real FFmpeg burn with Devanagari font)
    def _fake_translate(transcript_text: str, target_language: str, hook_title: str = "") -> Dict[str, str]:
        return {
            "translated_transcript": "हमने छह महीने तक रिटेंशन को नज़रअंदाज़ किया और दो मिलियन डॉलर खो दिए।",
            "translated_hook_title": "हमारी दो मिलियन की गलती",
            "target_language": target_language,
        }

    monkeypatch.setattr(backend_main, "translate_caption_text", _fake_translate)
    tr_resp = client.post(f"/api/clips/{clip_id}/translate", json={"target_language": "Hindi"})
    assert tr_resp.status_code == 200, tr_resp.text
    translated_clip = tr_resp.json()
    assert translated_clip["language"] == "Hindi"
    assert "रिटेंशन" in translated_clip["transcript"]
    assert Path(translated_clip["video_path"]).exists()

    # 4. Regenerate clip picks a distinct non-overlapping moment from the stored transcript
    def _fake_analyze(**kwargs: Any) -> List[Dict[str, Any]]:
        return [
            {
                "title": "Existing Overlap Moment",
                "hook_title": "Overlap",
                "start_time": 5.0,
                "end_time": 19.5,
                "virality_score": 88,
                "sub_scores": {"hook_strength": 88, "story_completeness": 86},
                "score_reason": "Overlaps the current clip interval.",
                "transcript_text": "Overlapping text.",
            },
            {
                "title": "Measure Retention Before Ads",
                "hook_title": "Retention Before Ads",
                "start_time": 20.1,
                "end_time": 27.8,
                "virality_score": 81,
                "sub_scores": {
                    "hook_strength": 82,
                    "story_completeness": 84,
                    "emotion_energy": 79,
                    "standalone_clarity": 86,
                    "pacing": 80,
                    "speech_rate": 77,
                    "audio_energy": 75,
                },
                "score_reason": "Delivers a crisp closing turnaround and actionable takeaway.",
                "transcript_text": "That single weekend saved the entire company from shutting down. Always measure retention before spending a dollar on ads.",
            },
        ]

    monkeypatch.setattr(backend_main, "analyze_viral_clips", _fake_analyze)
    regen_resp = client.post(f"/api/clips/{clip_id}/regenerate")
    assert regen_resp.status_code == 200, regen_resp.text
    regen_clip = regen_resp.json()
    assert regen_clip["title"] == "Measure Retention Before Ads"
    assert regen_clip["start_sec"] >= 20.0
    assert regen_clip["virality_score"] == 81
    assert "actionable takeaway" in regen_clip["score_reason"]
    assert regen_clip["edited_caption_text"] is None

    # 5. Download all clips as ZIP
    zip_resp = client.get(f"/api/jobs/{job_id}/download-zip")
    assert zip_resp.status_code == 200
    assert "application/zip" in zip_resp.headers.get("content-type", "")
    zf = zipfile.ZipFile(io.BytesIO(zip_resp.content))
    names = zf.namelist()
    assert len(names) == 1
    assert names[0].endswith(".mp4")
    assert zf.getinfo(names[0]).file_size > 10_000


def test_workspace_api_keys_and_signed_webhooks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_file = tmp_path / "phase3_ws.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(db_file))
    db.init_db()
    client = TestClient(backend_main.app)

    # --- Workspace API Keys ---
    create_key = client.post("/api/workspace/api-keys", json={"name": "Zapier Worker"})
    assert create_key.status_code == 200, create_key.text
    key_data = create_key.json()
    raw_key = key_data["api_key"]
    assert raw_key.startswith("sr_live_")

    listed_keys = client.get("/api/workspace/api-keys").json()["keys"]
    assert any(k["id"] == key_data["id"] and not k["revoked"] for k in listed_keys)

    verify_ok = client.get("/api/workspace/api-keys/verify", headers={"X-API-Key": raw_key})
    assert verify_ok.status_code == 200
    assert verify_ok.json()["valid"] is True

    revoke_resp = client.delete(f"/api/workspace/api-keys/{key_data['id']}")
    assert revoke_resp.status_code == 200

    verify_revoked = client.get("/api/workspace/api-keys/verify", headers={"X-API-Key": raw_key})
    assert verify_revoked.status_code == 401

    # --- Real local HTTP server to verify signed webhook delivery ---
    received: List[Dict[str, Any]] = []
    event_received = threading.Event()

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            received.append(
                {
                    "event": self.headers.get("X-Scalereach-Event"),
                    "signature": self.headers.get("X-Scalereach-Signature"),
                    "raw": raw,
                    "json": json.loads(raw.decode("utf-8")),
                }
            )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"received":true}')
            event_received.set()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
    srv_thread.start()

    try:
        wh_url = f"http://127.0.0.1:{port}/hook"
        create_wh = client.post(
            "/api/workspace/webhooks",
            json={"url": wh_url, "events": ["job.completed", "job.failed"]},
        )
        assert create_wh.status_code == 200, create_wh.text
        wh_data = create_wh.json()
        secret = wh_data["secret"]
        assert secret.startswith("whsec_")

        # List hides full secret
        listed_wh = client.get("/api/workspace/webhooks").json()["webhooks"]
        assert len(listed_wh) == 1
        assert "secret" not in listed_wh[0]
        assert "••••" in listed_wh[0]["secret_preview"]

        # Test endpoint delivers signed webhook.test
        test_res = client.post(f"/api/workspace/webhooks/{wh_data['id']}/test").json()
        assert test_res["ok"] is True
        assert test_res["status_code"] == 200
        assert len(received) == 1
        assert received[0]["event"] == "webhook.test"
        expected_sig = sign_webhook_payload(secret, received[0]["raw"])
        assert hmac.compare_digest(received[0]["signature"], expected_sig)

        # Async job.completed dispatch also delivers signed payload
        event_received.clear()
        dispatch_job_webhooks("job.completed", {"jobId": "job_xyz", "status": "completed"})
        assert event_received.wait(timeout=5.0), "Timed out waiting for async job.completed webhook"
        assert len(received) == 2
        assert received[1]["event"] == "job.completed"
        assert received[1]["json"]["data"]["jobId"] == "job_xyz"
        expected_sig2 = f"sha256={hmac.new(secret.encode(), received[1]['raw'], hashlib.sha256).hexdigest()}"
        assert hmac.compare_digest(received[1]["signature"], expected_sig2)

        # Delete webhook
        del_wh = client.delete(f"/api/workspace/webhooks/{wh_data['id']}")
        assert del_wh.status_code == 200
        assert client.get("/api/workspace/webhooks").json()["webhooks"] == []
    finally:
        server.shutdown()
        server.server_close()


def test_hindi_hinglish_transcription_config_translation_and_caption_sync(tmp_path: Path):
    # Verify transcriber Hindi/Hinglish initial prompt & language normalization
    hi_params = resolve_language_params("Hindi")
    assert hi_params["language"] == "hi"
    assert "हिंदी" in (hi_params["initial_prompt"] or "")

    hinglish_params = resolve_language_params("Hinglish")
    assert hinglish_params["language"] is None  # auto-detect mixed Hindi/English
    assert "Hinglish" in (hinglish_params["initial_prompt"] or "")

    # Verify translator builds Devanagari prompt & parses structured response
    captured_prompts: List[str] = []

    def _stub_caller(prompt: str) -> TranslatedCaptionResponse:
        captured_prompts.append(prompt)
        return TranslatedCaptionResponse(
            translated_transcript="भाई ये सबसे बड़ा सीक्रेट है। आज हम ग्रोथ की बात करेंगे।",
            translated_hook_title="सबसे बड़ा सीक्रेट",
        )

    tr = translate_caption_text(
        transcript_text="Bro this is the biggest secret. Today we talk about growth.",
        target_language="Hindi",
        hook_title="Biggest Secret",
        llm_caller=_stub_caller,
    )
    assert "Devanagari" in captured_prompts[0]
    assert "सीक्रेट" in tr["translated_transcript"]

    # Verify Hindi Devanagari sentence splitting (danda ।) and ASS caption sync < 100ms
    hindi_words = [
        {"word": "भाई", "start": 10.00, "end": 10.35},
        {"word": "ये", "start": 10.36, "end": 10.60},
        {"word": "सबसे", "start": 10.62, "end": 11.00},
        {"word": "बड़ा", "start": 11.02, "end": 11.35},
        {"word": "सीक्रेट", "start": 11.38, "end": 11.82},
        {"word": "है।", "start": 11.84, "end": 12.15},
        {"word": "आज", "start": 12.40, "end": 12.75},
        {"word": "हम", "start": 12.76, "end": 13.05},
        {"word": "ग्रोथ", "start": 13.08, "end": 13.52},
        {"word": "की", "start": 13.54, "end": 13.78},
        {"word": "बात", "start": 13.80, "end": 14.12},
        {"word": "करेंगे।", "start": 14.15, "end": 14.70},
    ]
    sentences = build_sentences(hindi_words)
    assert len(sentences) == 2
    assert sentences[0]["text"].endswith("है।")
    assert sentences[1]["text"].endswith("करेंगे।")

    assert select_caption_font(sentences[0]["text"], language="Hindi") == "Noto Sans Devanagari"

    ass_path = tmp_path / "hindi_sync.ass"
    generate_ass_subtitles(
        words=hindi_words,
        clip_start=10.0,
        clip_end=15.0,
        output_ass_path=ass_path,
        caption_style="classic",
        res_w=1080,
        res_h=1920,
        language="Hindi",
        auto_hook=True,
        hook_title="सबसे बड़ा सीक्रेट",
    )
    ass_text = ass_path.read_text(encoding="utf-8")
    assert "Noto Sans Devanagari" in ass_text
    sync_stats = measure_caption_sync_error_ms(ass_path, hindi_words, clip_start=10.0, clip_end=15.0)
    assert sync_stats["count"] == len(hindi_words)
    assert sync_stats["max_error_ms"] < 100.0, f"Hindi caption sync error {sync_stats} exceeded 100ms"
