from __future__ import annotations

import inspect
import re
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest

from backend import db
from backend.services import viral_analyzer as va


def _make_podcast_words(total_sec: float = 3600.0, sentence_dur: float = 6.0) -> List[Dict[str, Any]]:
    """Build a realistic 60-minute word-timestamped transcript with punctuation and pauses."""
    words: List[Dict[str, Any]] = []
    t = 0.4
    idx = 0
    templates = [
        "Most founders completely miss why retention drops after thirty seconds.",
        "Here is the exact turning point that doubled our audience in two weeks.",
        "When we changed the opening hook everything in the funnel shifted immediately.",
        "Wait until you hear what happened when the investor asked about margins.",
        "That single decision saved us two hundred thousand dollars last quarter.",
    ]
    while t + sentence_dur < total_sec:
        text = templates[idx % len(templates)]
        tokens = text.split()
        step = (sentence_dur - 0.5) / len(tokens)
        for j, tok in enumerate(tokens):
            w_start = round(t + j * step, 3)
            w_end = round(w_start + step * 0.9, 3)
            words.append({"word": tok, "start": w_start, "end": w_end})
        t += sentence_dur
        idx += 1
    return words


def test_build_sentences_punctuation_hindi_and_pauses() -> None:
    words = [
        {"word": "Hello", "start": 0.0, "end": 0.3},
        {"word": "world.", "start": 0.35, "end": 0.7},
        # Pause > 0.7s without punctuation should start a new sentence
        {"word": "This", "start": 0.8, "end": 1.0},
        {"word": "has", "start": 1.05, "end": 1.2},
        {"word": "pause", "start": 1.25, "end": 1.5},
        {"word": "Next", "start": 2.4, "end": 2.7},
        {"word": "thought!", "start": 2.75, "end": 3.1},
        # Hindi Devanagari sentence ending with danda ।
        {"word": "नमस्ते", "start": 3.2, "end": 3.6},
        {"word": "दुनिया।", "start": 3.65, "end": 4.1},
        {"word": "कैसे", "start": 4.15, "end": 4.4},
        {"word": "हैं?", "start": 4.45, "end": 4.8},
    ]
    sentences = va.build_sentences(words)
    assert len(sentences) == 5
    assert sentences[0]["text"] == "Hello world."
    assert sentences[1]["text"] == "This has pause"
    assert sentences[2]["text"] == "Next thought!"
    assert sentences[3]["text"] == "नमस्ते दुनिया।"
    assert sentences[4]["text"] == "कैसे हैं?"
    for i, s in enumerate(sentences):
        assert s["index"] == i
        assert s["end"] > s["start"]


def test_duration_mapping_all_ui_options() -> None:
    assert va.map_duration_range("Auto") == (30.0, 90.0)
    assert va.map_duration_range("0 - 30s") == (15.0, 30.0)
    assert va.map_duration_range("30 - 60s") == (30.0, 60.0)
    assert va.map_duration_range("1 - 2 min") == (60.0, 120.0)
    assert va.map_duration_range("2 - 3 min") == (120.0, 180.0)


def test_boundary_snapping_never_cuts_mid_sentence() -> None:
    words = _make_podcast_words(total_sec=300.0, sentence_dur=6.0)
    sentences = va.build_sentences(words)

    # Too short candidate (only 2 sentences = ~12s) under "1 - 2 min" (60-120s) -> extends by whole sentences
    snapped = va.snap_and_refine_boundaries(
        sentences=sentences,
        start_sentence_idx=5,
        end_sentence_idx=6,
        min_sec=60.0,
        max_sec=120.0,
        total_duration_sec=300.0,
    )
    assert snapped is not None
    assert 60.0 <= snapped["duration_sec"] <= 120.0
    s_start_sent = sentences[snapped["start_sentence"]]
    s_end_sent = sentences[snapped["end_sentence"]]
    assert abs(snapped["start_time"] - max(0.0, s_start_sent["start"] - 0.3)) < 0.05
    assert abs(snapped["end_time"] - min(300.0, s_end_sent["end"] + 0.5)) < 0.05

    # Too long candidate (35 sentences = ~210s) under "1 - 2 min" (60-120s) -> shrinks to earlier sentence end
    snapped_long = va.snap_and_refine_boundaries(
        sentences=sentences,
        start_sentence_idx=2,
        end_sentence_idx=37,
        min_sec=60.0,
        max_sec=120.0,
        total_duration_sec=300.0,
    )
    assert snapped_long is not None
    assert 60.0 <= snapped_long["duration_sec"] <= 120.0
    end_sent_long = sentences[snapped_long["end_sentence"]]
    assert abs(snapped_long["end_time"] - min(300.0, end_sent_long["end"] + 0.5)) < 0.55


def test_overlap_removal_and_timeline_spread() -> None:
    candidates = [
        {"title": "Early A", "start_time": 100.0, "end_time": 180.0, "virality_score": 92},
        # Heavy overlap with Early A (>50%) -> must be dropped
        {"title": "Early Overlap", "start_time": 120.0, "end_time": 200.0, "virality_score": 91},
        {"title": "Mid A", "start_time": 1500.0, "end_time": 1580.0, "virality_score": 88},
        {"title": "Late A", "start_time": 3100.0, "end_time": 3180.0, "virality_score": 85},
        {"title": "Early B", "start_time": 400.0, "end_time": 480.0, "virality_score": 84},
        {"title": "Mid B", "start_time": 2100.0, "end_time": 2180.0, "virality_score": 83},
        {"title": "Late B", "start_time": 3350.0, "end_time": 3430.0, "virality_score": 81},
    ]
    selected = va.select_non_overlapping_spread(
        scored_candidates=candidates,
        target_k=5,
        total_duration_sec=3600.0,
        max_overlap_ratio=0.30,
    )
    titles = [c["title"] for c in selected]
    assert "Early Overlap" not in titles
    assert len(selected) == 5
    for i in range(len(selected)):
        for j in range(i + 1, len(selected)):
            ov = va.compute_overlap_ratio(
                selected[i]["start_time"],
                selected[i]["end_time"],
                selected[j]["start_time"],
                selected[j]["end_time"],
            )
            assert ov <= 0.30 + 1e-6


def test_no_hardcoded_score_ranges_in_prompts() -> None:
    src = inspect.getsource(va)
    assert not re.search(r"7[0-9]\s*-\s*9[0-9]|8[0-9]\s*-\s*9[0-9]", src)


def test_60_minute_podcast_spread_sentence_aligned_and_duration_range() -> None:
    words = _make_podcast_words(total_sec=3600.0, sentence_dur=6.0)
    sentences = va.build_sentences(words)

    pass1_calls = 0

    def fake_llm_caller(prompt: str, schema: Any) -> Any:
        nonlocal pass1_calls
        if schema is va.Pass1WindowResponse:
            pass1_calls += 1
            idxs = [int(m) for m in re.findall(r"\[S(\d+)\]", prompt)]
            assert len(idxs) >= 20
            s0 = idxs[4]
            e0 = min(idxs[-1], s0 + 13)  # ~78s
            s1 = idxs[min(len(idxs) - 16, len(idxs) // 2)]
            e1 = min(idxs[-1], s1 + 14)  # ~84s
            return va.Pass1WindowResponse(
                candidates=[
                    va.Pass1Candidate(
                        start_sentence=s0,
                        end_sentence=e0,
                        title=f"Story Arc Window {pass1_calls}A",
                        hook_title=f"HOOK ARC {pass1_calls}A",
                        arc_summary="Complete hook, setup, and payoff.",
                    ),
                    va.Pass1Candidate(
                        start_sentence=s1,
                        end_sentence=e1,
                        title=f"Story Arc Window {pass1_calls}B",
                        hook_title=f"HOOK ARC {pass1_calls}B",
                        arc_summary="Complete hook, setup, and payoff.",
                    ),
                ]
            )
        if schema is va.Pass2RubricBatchResponse:
            cand_ids = [int(m) for m in re.findall(r"Candidate\s+(\d+)\s+\(", prompt)]
            evaluations = []
            for cid in cand_ids:
                evaluations.append(
                    va.Pass2RubricItem(
                        candidate_index=cid,
                        hook_strength=min(98, 45 + (cid * 11) % 52),
                        story_completeness=min(97, 50 + (cid * 13) % 45),
                        emotion_energy=min(96, 40 + (cid * 17) % 55),
                        standalone_clarity=min(95, 48 + (cid * 7) % 46),
                        pacing=min(94, 42 + (cid * 19) % 50),
                        score_reason=f"Candidate {cid} opens with a sharp hook and delivers a concrete payoff.",
                    )
                )
            return va.Pass2RubricBatchResponse(evaluations=evaluations)
        raise AssertionError(f"Unexpected schema {schema}")

    clips = va.analyze_viral_clips(
        transcript_data={"words": words},
        video_title="60 Minute Founder Podcast",
        duration_range="1 - 2 min",
        total_duration_sec=3600.0,
        llm_caller=fake_llm_caller,
    )

    assert len(clips) >= 8, f"Expected >= 8 clips for 60-min podcast, got {len(clips)}"

    # Spread across beginning (<20m), middle (20-40m), and end (>40m)
    has_early = any(c["start_time"] < 1200 for c in clips)
    has_mid = any(1200 <= c["start_time"] < 2400 for c in clips)
    has_late = any(c["start_time"] >= 2400 for c in clips)
    assert has_early and has_mid and has_late, "Clips must spread across the entire 60-min podcast"

    scores_seen = set()
    for clip in clips:
        dur = clip["end_time"] - clip["start_time"]
        assert 60.0 <= dur <= 120.0, f"Clip duration {dur}s outside 60-120s"
        s_sent = sentences[clip["start_sentence"]]
        e_sent = sentences[clip["end_sentence"]]
        assert abs(clip["start_time"] - max(0.0, s_sent["start"] - 0.3)) < 0.35
        assert abs(clip["end_time"] - min(3600.0, e_sent["end"] + 0.5)) < 0.55
        assert clip["score_reason"].strip()
        assert "sub_scores" in clip and "hook_strength" in clip["sub_scores"]
        # Verify final score matches deterministic weighted code formula
        assert clip["virality_score"] == va.compute_weighted_final_score(clip["sub_scores"])
        scores_seen.add(clip["virality_score"])

    assert len(scores_seen) >= 4, "Scores must differ between clips rather than being identical/hardcoded"


def test_sqlite_persistence_survives_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "test_scalereach.db"
    monkeypatch.setenv("SQLITE_DB_PATH", str(db_path))
    db.init_db()

    db.create_job(
        "job_persist_1",
        {
            "url": "/uploads/demo.mp4",
            "videoTitle": "Persistence Test",
            "durationRange": "1 - 2 min",
            "aspectRatio": "1:1 Square",
        },
    )
    db.save_transcript(
        "job_persist_1",
        language="en",
        language_probability=0.99,
        source="faster-whisper",
        full_text="Hello world.",
        segments=[{"start": 0.0, "end": 1.2, "text": "Hello world."}],
        words=[{"word": "Hello", "start": 0.0, "end": 0.5}, {"word": "world.", "start": 0.55, "end": 1.2}],
        sentences=[{"index": 0, "start": 0.0, "end": 1.2, "text": "Hello world."}],
    )
    db.replace_job_clips(
        "job_persist_1",
        [
            {
                "tag": "#1",
                "title": "Persisted Clip",
                "hook_title": "PERSISTED HOOK",
                "start_sec": 0.0,
                "end_sec": 65.0,
                "duration_str": "1:05",
                "virality_score": 83,
                "sub_scores": {"hook_strength": 84},
                "score_reason": "Clear hook and payoff.",
                "transcript": "Hello world.",
                "status": "ready",
                "progress": 100,
            }
        ],
    )
    db.update_job("job_persist_1", status="completed", progress=100, stage=3)

    db.init_db()
    restored = db.get_job_response("job_persist_1")
    assert restored is not None
    assert restored["status"] == "completed"
    assert restored["durationRange"] == "1 - 2 min"
    assert len(restored["clips"]) == 1
    assert restored["clips"][0]["virality_score"] == 83
    assert restored["clips"][0]["score_reason"] == "Clear hook and payoff."
    tr = db.get_transcript("job_persist_1")
    assert tr is not None and tr["transcript"] == "Hello world."


def test_python_backend_stopped_returns_503_no_fake_clips() -> None:
    """
    When the Python FastAPI server (port 8001) is NOT running, Express on port 3000
    must return HTTP 503 with a clear error message and NEVER create fake clips.
    """
    python_running = False
    try:
        r = httpx.get("http://127.0.0.1:8001/api/health", timeout=0.5)
        python_running = r.status_code == 200
    except Exception:
        python_running = False

    if python_running:
        pytest.skip("Python backend is currently running on 8001; stopped-backend test runs when 8001 is down.")

    try:
        resp_fetch = httpx.post(
            "http://127.0.0.1:3000/api/fetch-video",
            json={"url": "https://example.com/video.mp4"},
            timeout=5.0,
        )
    except Exception as exc:
        pytest.fail(f"Express server on port 3000 is not reachable: {exc}")

    assert resp_fetch.status_code == 503, f"Expected 503, got {resp_fetch.status_code}: {resp_fetch.text}"
    body_fetch = resp_fetch.json()
    assert "unavailable" in (body_fetch.get("error") or body_fetch.get("detail") or "").lower()

    resp_gen = httpx.post(
        "http://127.0.0.1:3000/api/generate-clips",
        json={"url": "https://example.com/video.mp4", "ownsRights": True},
        timeout=5.0,
    )
    assert resp_gen.status_code == 503, f"Expected 503, got {resp_gen.status_code}: {resp_gen.text}"
    body_gen = resp_gen.json()
    assert "job_id" not in body_gen and "jobId" not in body_gen and "clips" not in body_gen
    assert "unavailable" in (body_gen.get("error") or body_gen.get("detail") or "").lower()
