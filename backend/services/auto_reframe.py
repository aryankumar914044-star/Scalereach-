from __future__ import annotations

import json
import os
import random
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np

from .caption_burner import escape_ffmpeg_filter_path, generate_ass_subtitles

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent if BACKEND_DIR.name == "backend" else BACKEND_DIR
BACKGROUNDS_DIR = BACKEND_DIR / "assets" / "backgrounds"
BACKGROUNDS_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Aspect ratio mapping (Requirement 7)
# ---------------------------------------------------------------------------


def resolve_aspect_dimensions(aspect_ratio: Optional[str]) -> Tuple[int, int]:
    """
    Honor the UI Aspect Ratio selector strictly:
      9:16 -> 1080x1920
      1:1  -> 1080x1080
      16:9 -> 1920x1080
    """
    val = (aspect_ratio or "9:16").strip().lower()
    if val.startswith("1:1") or "square" in val:
        return (1080, 1080)
    if val.startswith("16:9") or "landscape" in val:
        return (1920, 1080)
    return (1080, 1920)


def compute_ffmpeg_timeout(clip_duration_sec: float) -> int:
    """Scale FFmpeg timeout with clip length instead of using a hard-coded 180s cap."""
    return max(120, int(round(max(1.0, clip_duration_sec) * 8.0)) + 90)


def probe_video_stream(video_path: Path) -> Dict[str, Any]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,r_frame_rate:format=duration",
        "-of",
        "json",
        str(video_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {video_path}: {proc.stderr.strip()}")
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v_stream:
        raise RuntimeError(f"No video stream found in {video_path}")

    fps = 30.0
    r_rate = str(v_stream.get("r_frame_rate") or "30/1")
    if "/" in r_rate:
        num, den = r_rate.split("/", 1)
        if float(den) > 0:
            fps = float(num) / float(den)
    else:
        try:
            fps = float(r_rate)
        except ValueError:
            fps = 30.0

    return {
        "width": int(v_stream.get("width") or 1920),
        "height": int(v_stream.get("height") or 1080),
        "fps": max(1.0, min(120.0, fps)),
        "duration": float((data.get("format") or {}).get("duration") or 0.0),
        "has_audio": a_stream is not None,
    }


# ---------------------------------------------------------------------------
# Scene cut detection (PySceneDetect) & Face / Active-Speaker Tracking (OpenCV)
# ---------------------------------------------------------------------------


def detect_scene_cuts_sec(
    video_path: Path,
    start_sec: float,
    end_sec: float,
    threshold: float = 27.0,
) -> List[float]:
    """
    Detect scene cut timestamps (relative to clip start) using PySceneDetect ContentDetector
    so EMA smoothing resets immediately on camera angle switches.
    """
    try:
        from scenedetect import ContentDetector, SceneManager, open_video

        video = open_video(str(video_path))
        fps = float(video.frame_rate or 30.0)
        start_frame = max(0, int(round(start_sec * fps)))
        end_frame = max(start_frame + 1, int(round(end_sec * fps)))

        video.seek(start_frame)
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=threshold))
        scene_manager.detect_scenes(video=video, duration=(end_frame - start_frame))
        scene_list = scene_manager.get_scene_list()

        cuts: List[float] = []
        for idx, (s_time, _e_time) in enumerate(scene_list):
            if idx == 0:
                continue
            rel = float(s_time.get_seconds()) - start_sec
            if 0.1 < rel < (end_sec - start_sec - 0.1):
                cuts.append(round(rel, 3))
        return sorted(set(cuts))
    except Exception:
        return []


def _create_mediapipe_face_detector() -> Any:
    """
    Create a MediaPipe FaceDetection instance when `mediapipe.solutions.face_detection`
    is available (e.g., mediapipe 0.10.x in Cloud Run). Returns None on newer MediaPipe
    builds where `mp.solutions` was removed so we seamlessly fall back to OpenCV Haar cascades.
    """
    try:
        import mediapipe as mp  # type: ignore

        solutions = getattr(mp, "solutions", None)
        face_det_mod = getattr(solutions, "face_detection", None) if solutions is not None else None
        if face_det_mod is not None:
            return face_det_mod.FaceDetection(model_selection=1, min_detection_confidence=0.45)
    except Exception:
        pass
    return None


def _detect_faces_mediapipe(
    small_bgr: np.ndarray,
    mp_detector: Any,
) -> List[Tuple[int, int, int, int]]:
    if mp_detector is None:
        return []
    h, w = small_bgr.shape[:2]
    rgb = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2RGB)
    result = mp_detector.process(rgb)
    detections = getattr(result, "detections", None) or []
    boxes: List[Tuple[int, int, int, int]] = []
    for det in detections:
        bbox = det.location_data.relative_bounding_box
        x = max(0, int(round(bbox.xmin * w)))
        y = max(0, int(round(bbox.ymin * h)))
        bw = max(1, int(round(bbox.width * w)))
        bh = max(1, int(round(bbox.height * h)))
        if bw >= 16 and bh >= 16:
            boxes.append((x, y, min(w - x, bw), min(h - y, bh)))
    return boxes


def _load_face_cascades() -> List[cv2.CascadeClassifier]:
    cascades: List[cv2.CascadeClassifier] = []
    base = Path(cv2.data.haarcascades)
    for name in ("haarcascade_frontalface_default.xml", "haarcascade_frontalface_alt2.xml"):
        p = base / name
        if p.exists():
            clf = cv2.CascadeClassifier(str(p))
            if not clf.empty():
                cascades.append(clf)
    return cascades


def _detect_faces_in_gray(
    gray_small: np.ndarray,
    cascades: List[cv2.CascadeClassifier],
) -> List[Tuple[int, int, int, int]]:
    for clf in cascades:
        faces = clf.detectMultiScale(
            gray_small,
            scaleFactor=1.15,
            minNeighbors=4,
            minSize=(22, 22),
        )
        if len(faces) > 0:
            return [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in faces]
    return []


def analyze_smart_reframe_track(
    source_video: Path,
    start_sec: float,
    end_sec: float,
    sample_stride: int = 3,
    ema_alpha: float = 0.22,
) -> Dict[str, Any]:
    """
    Scan the clip segment every `sample_stride` frames (2-3 frames):
      1. Detect scene cuts via PySceneDetect.
      2. Detect faces using MediaPipe FaceDetection (with automatic OpenCV Haar fallback).
      3. Detect 2-speaker podcast/interview layouts (two horizontally separated faces) ->
         enables automatic vertical 2-speaker split-screen framing.
      4. Pick the active speaker using face area + lower-face (mouth) frame-diff motion.
      5. Smooth normalized X center (0..1) using EMA, resetting EMA state on every scene cut.
      6. Detect whether the video has faces at all; if not (slides/screen recordings),
         signal `mode = "blurred_fit"` instead of blind center crop.
    """
    scene_cuts = detect_scene_cuts_sec(source_video, start_sec, end_sec)
    mp_detector = _create_mediapipe_face_detector()
    cascades = _load_face_cascades()
    detector_backend = "mediapipe" if mp_detector is not None else "opencv"

    cap = cv2.VideoCapture(str(source_video))
    if not cap.isOpened():
        if mp_detector is not None:
            try:
                mp_detector.close()
            except Exception:
                pass
        return {
            "mode": "blurred_fit",
            "has_faces": False,
            "keyframes": [],
            "scene_cuts": scene_cuts,
            "detector": detector_backend,
        }

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    if fps <= 0.0:
        fps = 30.0

    start_frame = max(0, int(round(start_sec * fps)))
    end_frame = max(start_frame + 1, int(round(end_sec * fps)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    prev_gray: Optional[np.ndarray] = None
    sampled_count = 0
    face_hits = 0
    dual_hits = 0
    left_centers: List[float] = []
    right_centers: List[float] = []
    raw_points: List[Tuple[float, Optional[float]]] = []

    frame_idx = start_frame
    try:
        while frame_idx < end_frame:
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            if (frame_idx - start_frame) % max(1, sample_stride) == 0:
                sampled_count += 1
                rel_t = (frame_idx - start_frame) / fps
                h, w = frame.shape[:2]
                scale = min(1.0, 480.0 / max(1, w))
                small_w = max(64, int(round(w * scale)))
                small_h = max(64, int(round(h * scale)))
                small = cv2.resize(frame, (small_w, small_h), interpolation=cv2.INTER_AREA)
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

                faces = _detect_faces_mediapipe(small, mp_detector) if mp_detector is not None else []
                if not faces and cascades:
                    faces = _detect_faces_in_gray(gray, cascades)

                chosen_cx: Optional[float] = None

                if faces:
                    face_hits += 1
                    # Check for 2-speaker wide layout (e.g., podcast/interview with left & right speakers)
                    if len(faces) >= 2:
                        face_cxs = sorted((fx + fw * 0.5) / float(small_w) for (fx, _fy, fw, _fh) in faces)
                        if (face_cxs[-1] - face_cxs[0]) >= 0.30:
                            dual_hits += 1
                            left_centers.append(face_cxs[0])
                            right_centers.append(face_cxs[-1])

                    best_score = -1.0
                    for (fx, fy, fw, fh) in faces:
                        area_norm = (fw * fh) / float(small_w * small_h)
                        # Mouth/jaw ROI = lower 38% of detected face box
                        mouth_y1 = fy + int(fh * 0.58)
                        mouth_y2 = min(small_h, fy + fh)
                        mouth_x1 = max(0, fx + int(fw * 0.15))
                        mouth_x2 = min(small_w, fx + int(fw * 0.85))
                        motion_score = 0.0
                        if (
                            prev_gray is not None
                            and prev_gray.shape == gray.shape
                            and mouth_y2 > mouth_y1
                            and mouth_x2 > mouth_x1
                        ):
                            diff = cv2.absdiff(
                                gray[mouth_y1:mouth_y2, mouth_x1:mouth_x2],
                                prev_gray[mouth_y1:mouth_y2, mouth_x1:mouth_x2],
                            )
                            motion_score = float(np.mean(diff)) / 255.0

                        # Active speaker score: prioritize largest face + mouth movement
                        score = area_norm * 3.0 + motion_score * 2.5
                        if score > best_score:
                            best_score = score
                            chosen_cx = (fx + fw * 0.5) / float(small_w)

                raw_points.append((round(rel_t, 3), chosen_cx))
                prev_gray = gray

            frame_idx += 1
    finally:
        cap.release()
        if mp_detector is not None:
            try:
                mp_detector.close()
            except Exception:
                pass

    face_ratio = (face_hits / float(sampled_count)) if sampled_count > 0 else 0.0
    if face_hits == 0 or face_ratio < 0.08:
        # Screen recording / slides / no faces -> blurred-background fit layout!
        return {
            "mode": "blurred_fit",
            "has_faces": False,
            "face_ratio": round(face_ratio, 3),
            "keyframes": [],
            "scene_cuts": scene_cuts,
            "detector": detector_backend,
        }

    # Apply EMA smoothing with immediate reset on every PySceneDetect scene cut
    cut_idx = 0
    smoothed: List[Tuple[float, float]] = []
    ema_cx: Optional[float] = None
    last_known_cx = 0.5

    # Seed initial position from first detected face
    for _t, cx in raw_points:
        if cx is not None:
            last_known_cx = cx
            break

    for rel_t, raw_cx in raw_points:
        crossed_cut = False
        while cut_idx < len(scene_cuts) and rel_t >= scene_cuts[cut_idx]:
            crossed_cut = True
            cut_idx += 1

        target_cx = raw_cx if raw_cx is not None else last_known_cx
        if raw_cx is not None:
            last_known_cx = raw_cx

        if ema_cx is None or crossed_cut:
            ema_cx = target_cx
        else:
            ema_cx = (ema_alpha * target_cx) + ((1.0 - ema_alpha) * ema_cx)

        smoothed.append((rel_t, max(0.0, min(1.0, float(ema_cx)))))

    # Downsample keyframes slightly (~0.25s cadence or >1.5% movement) for lean sendcmd files
    compact: List[Tuple[float, float]] = []
    for rel_t, cx in smoothed:
        if not compact:
            compact.append((0.0, cx))
        else:
            prev_t, prev_cx = compact[-1]
            if (rel_t - prev_t) >= 0.25 or abs(cx - prev_cx) >= 0.015:
                compact.append((rel_t, cx))

    dual_ratio = (dual_hits / float(sampled_count)) if sampled_count > 0 else 0.0
    if dual_hits >= 2 and dual_ratio >= 0.25 and left_centers and right_centers:
        left_cx = float(np.median(left_centers))
        right_cx = float(np.median(right_centers))
        return {
            "mode": "dual_speaker_split",
            "has_faces": True,
            "dual_speaker": True,
            "left_cx": round(max(0.12, min(0.48, left_cx)), 4),
            "right_cx": round(max(0.52, min(0.88, right_cx)), 4),
            "face_ratio": round(face_ratio, 3),
            "keyframes": compact,
            "scene_cuts": scene_cuts,
            "detector": detector_backend,
        }

    return {
        "mode": "face_track",
        "has_faces": True,
        "dual_speaker": False,
        "face_ratio": round(face_ratio, 3),
        "keyframes": compact,
        "scene_cuts": scene_cuts,
        "detector": detector_backend,
    }


def _write_crop_sendcmd_file(
    keyframes: List[Tuple[float, float]],
    scaled_w: int,
    target_w: int,
    cmd_path: Path,
) -> int:
    """
    Write FFmpeg `sendcmd` commands updating `crop@reframe x` at each keyframe timestamp.
    Returns the initial X offset at t=0.
    """
    max_x = max(0, scaled_w - target_w)
    if max_x == 0 or not keyframes:
        cmd_path.write_text("", encoding="utf-8")
        return max_x // 2

    def _cx_to_x(cx: float) -> int:
        desired = int(round(cx * scaled_w - (target_w / 2.0)))
        return max(0, min(max_x, desired))

    initial_x = _cx_to_x(keyframes[0][1])
    lines: List[str] = []
    last_x = initial_x
    for rel_t, cx in keyframes[1:]:
        x_val = _cx_to_x(cx)
        if x_val != last_x:
            lines.append(f"{rel_t:.3f} crop@reframe x {x_val};")
            last_x = x_val

    cmd_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return initial_x


# ---------------------------------------------------------------------------
# Split-screen background video assets (Requirement 8)
# ---------------------------------------------------------------------------


def _resolve_background_preset(bg_filter: str) -> str:
    raw = (bg_filter or "All").lower()
    if "gta" in raw:
        return "gta"
    if "minecraft" in raw:
        return "minecraft"
    if "subway" in raw:
        return "subway"
    return random.choice(["gta", "minecraft", "subway"])


def ensure_split_screen_background(bg_filter: str, target_w: int = 1080, target_h: int = 960) -> Path:
    """
    Return a local background MP4 for split-screen bottom half.
    Checks `backend/assets/backgrounds/<preset>.mp4` first; if no custom file exists,
    synthesizes and caches a crisp 10-second looping animated motion background via FFmpeg
    (distinct color/motion palette per preset: GTA / Minecraft / Subway Surfers).
    """
    preset = _resolve_background_preset(bg_filter)
    custom = BACKGROUNDS_DIR / f"{preset}.mp4"
    if custom.exists() and custom.stat().st_size > 20_000:
        return custom

    cached = BACKGROUNDS_DIR / f"_generated_{preset}_{target_w}x{target_h}.mp4"
    if cached.exists() and cached.stat().st_size > 20_000:
        return cached

    # Distinct procedural motion patterns (sunset highway, blocky terrain grid, neon rails)
    if preset == "gta":
        lavfi = (
            f"testsrc2=size={target_w}x{target_h}:rate=30:duration=10,"
            "hue=h=30*t:s=1.4,eq=contrast=1.15:brightness=-0.05"
        )
    elif preset == "minecraft":
        lavfi = (
            f"cellauto=size={target_w // 4}x{target_h // 4}:rate=24,"
            f"scale={target_w}:{target_h}:flags=neighbor,"
            "colorchannelmixer=rr=0.25:gg=0.85:bb=0.35,"
            "trim=duration=10,setpts=PTS-STARTPTS"
        )
    else:  # subway
        lavfi = (
            f"mandelbrot=size={target_w // 2}x{target_h // 2}:rate=30:maxiter=48,"
            f"scale={target_w}:{target_h}:flags=bilinear,"
            "hue=h=45*t:s=1.6,"
            "trim=duration=10,setpts=PTS-STARTPTS"
        )

    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        lavfi,
        "-t",
        "10",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-an",
        str(cached),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0 or not cached.exists():
        # Ultimate fallback using simple animated color gradient
        fallback_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={target_w}x{target_h}:rate=30:duration=10",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(cached),
        ]
        subprocess.run(fallback_cmd, capture_output=True, text=True, timeout=60, check=True)
    return cached


# ---------------------------------------------------------------------------
# Single-Pass FFmpeg Clip Renderer (Requirements 7, 8, 9, 10)
# ---------------------------------------------------------------------------


def generate_clip_thumbnail(video_path: Path, thumb_path: Path, seek_sec: float = 1.5) -> Optional[Path]:
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{max(0.0, seek_sec):.2f}",
        "-i",
        str(video_path),
        "-vframes",
        "1",
        "-q:v",
        "3",
        str(thumb_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode == 0 and thumb_path.exists() and thumb_path.stat().st_size > 1000:
        return thumb_path
    # Fallback to frame 0 if clip is very short
    cmd[3] = "0.00"
    proc2 = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc2.returncode == 0 and thumb_path.exists() and thumb_path.stat().st_size > 1000:
        return thumb_path
    return None


def _build_single_pane_filter(
    in_label: str,
    out_label: str,
    src_w: int,
    src_h: int,
    target_w: int,
    target_h: int,
    smart_reframe: bool,
    track: Dict[str, Any],
    sendcmd_path: Path,
) -> Tuple[str, str]:
    """
    Build the FFmpeg filtergraph segment mapping `[in_label]` -> `[out_label]` at exact
    `target_w x target_h`. Returns `(filter_expr, framing_mode_used)`.
    """
    src_ar = src_w / float(max(1, src_h))
    tgt_ar = target_w / float(max(1, target_h))

    # Case 1: Smart reframe ON and NO faces found (slides/screen recordings) -> blurred-background fit
    if smart_reframe and track.get("mode") == "blurred_fit" and abs(src_ar - tgt_ar) > 0.15:
        blur_w = max(64, (target_w // 6) * 2 // 2)
        blur_h = max(64, (target_h // 6) * 2 // 2)
        expr = (
            f"[{in_label}]split=2[_bg][_fg];"
            f"[_bg]scale={blur_w}:{blur_h}:force_original_aspect_ratio=increase,"
            f"crop={blur_w}:{blur_h}:(iw-{blur_w})/2:(ih-{blur_h})/2,"
            f"gblur=sigma=5:steps=2,scale={target_w}:{target_h}:flags=bilinear,"
            f"eq=brightness=-0.12[_bg_blur];"
            f"[_fg]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease[_fg_fit];"
            f"[_bg_blur][_fg_fit]overlay=(W-w)/2:(H-h)/2,setsar=1[{out_label}]"
        )
        return expr, "blurred_fit"

    # Case 2: Smart reframe ON with face tracking (horizontal panning via sendcmd + crop)
    if smart_reframe and track.get("mode") == "face_track" and src_ar > tgt_ar + 0.05:
        scaled_w = int(round(src_w * (target_h / float(max(1, src_h)))))
        scaled_w = max(target_w, scaled_w + (scaled_w % 2))
        init_x = _write_crop_sendcmd_file(
            keyframes=track.get("keyframes") or [],
            scaled_w=scaled_w,
            target_w=target_w,
            cmd_path=sendcmd_path,
        )
        has_cmds = sendcmd_path.exists() and sendcmd_path.stat().st_size > 0
        if has_cmds:
            cmd_filter = f"sendcmd=f='{escape_ffmpeg_filter_path(sendcmd_path)}',"
        else:
            cmd_filter = ""
        expr = (
            f"[{in_label}]scale={scaled_w}:{target_h},"
            f"{cmd_filter}"
            f"crop@reframe=w={target_w}:h={target_h}:x={init_x}:y=0,setsar=1[{out_label}]"
        )
        return expr, "face_track"

    # Case 3: Standard centered crop / fit (when smartReframe=False or aspect ratios already match)
    expr = (
        f"[{in_label}]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
        f"crop={target_w}:{target_h}:(iw-{target_w})/2:(ih-{target_h})/2,setsar=1[{out_label}]"
    )
    return expr, "center_crop"


def render_clip_single_pass(
    source_video: str | Path,
    start_time: float,
    end_time: float,
    output_path: str | Path,
    *,
    words: Optional[List[Dict[str, Any]]] = None,
    aspect_ratio: str = "9:16 Portrait",
    smart_reframe: bool = True,
    split_screen: bool = False,
    background_video: str = "All",
    captions_enabled: bool = True,
    caption_style: str = "classic",
    auto_hook: bool = True,
    hook_title: str = "",
    language: str = "Auto",
    fallback_transcript: str = "",
    edited_caption_text: Optional[str] = None,
    thumbnail_path: Optional[str | Path] = None,
    sample_stride: int = 3,
) -> Dict[str, Any]:
    """
    Render a finished viral clip in ONE FFmpeg encode pass:
      - Exact cut (start_time -> end_time)
      - Aspect ratio: 9:16 (1080x1920), 1:1 (1080x1080), 16:9 (1920x1080)
      - Smart AI reframing (face + active speaker + EMA + PySceneDetect scene-cut reset)
        OR blurred-background fit when no face is detected
      - Split-screen vertical stack (top: speaker 1080x960, bottom: background video 1080x960)
      - Burned ASS word-by-word captions + 3s hook overlay (Devanagari-aware)
      - CRF 20 H.264, loudnorm EBU R128 audio, +faststart
      - Dynamic duration-scaled timeout (no fixed 180s cap)
      - Generates JPEG thumbnail alongside the rendered clip
    """
    src = Path(source_video).resolve()
    dst = Path(output_path).resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        raise FileNotFoundError(f"Source video not found: {src}")

    info = probe_video_stream(src)
    src_w, src_h = info["width"], info["height"]
    src_dur = info["duration"]

    start_sec = max(0.0, float(start_time))
    end_sec = float(end_time)
    if src_dur > 0:
        end_sec = min(src_dur, end_sec)
    clip_dur = max(0.5, end_sec - start_sec)

    # Split-screen locks output to 9:16 (1080x1920)
    out_w, out_h = (1080, 1920) if split_screen else resolve_aspect_dimensions(aspect_ratio)

    # 1. Smart reframe analysis (only when smart_reframe is enabled)
    if smart_reframe:
        track = analyze_smart_reframe_track(
            src,
            start_sec=start_sec,
            end_sec=end_sec,
            sample_stride=sample_stride,
        )
    else:
        track = {"mode": "center_crop", "has_faces": False, "keyframes": [], "scene_cuts": []}

    # 2. Generate ASS subtitles (word-by-word captions + 3s hook overlay)
    ass_path = dst.with_suffix(".ass")
    has_ass_overlay = bool(captions_enabled or (auto_hook and hook_title and hook_title.strip()))
    if has_ass_overlay:
        generate_ass_subtitles(
            words=words or [],
            clip_start=start_sec,
            clip_end=end_sec,
            output_ass_path=ass_path,
            caption_style=caption_style,
            res_w=out_w,
            res_h=out_h,
            language=language,
            captions_enabled=captions_enabled,
            auto_hook=auto_hook,
            hook_title=hook_title,
            split_screen=split_screen,
            fallback_transcript=fallback_transcript,
            edited_caption_text=edited_caption_text,
        )

    sendcmd_path = dst.with_suffix(".reframe.cmd")
    inputs: List[str] = [
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{clip_dur:.3f}",
        "-i",
        str(src),
    ]

    filter_parts: List[str] = []
    src_ar = src_w / float(max(1, src_h))
    if split_screen:
        pane_h = out_h // 2  # 960
        bg_path = ensure_split_screen_background(background_video, target_w=out_w, target_h=pane_h)
        inputs.extend(["-stream_loop", "-1", "-i", str(bg_path)])

        top_expr, framing_mode = _build_single_pane_filter(
            in_label="0:v",
            out_label="v_top_raw",
            src_w=src_w,
            src_h=src_h,
            target_w=out_w,
            target_h=pane_h,
            smart_reframe=smart_reframe,
            track=track,
            sendcmd_path=sendcmd_path,
        )
        filter_parts.append(top_expr)
        filter_parts.append("[v_top_raw]fps=30,setpts=PTS-STARTPTS[v_top]")
        filter_parts.append(
            f"[1:v]fps=30,setpts=PTS-STARTPTS,"
            f"scale={out_w}:{pane_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{pane_h}:(iw-{out_w})/2:(ih-{pane_h})/2,setsar=1[v_bot]"
        )
        filter_parts.append("[v_top][v_bot]vstack=inputs=2:shortest=1[v_base]")
        framing_mode = f"split_{framing_mode}"
    elif smart_reframe and out_h > out_w and track.get("mode") == "dual_speaker_split" and src_ar > 1.2:
        # Automatic 2-speaker podcast/interview split-screen (Speaker A top 1080x960, Speaker B bottom 1080x960)
        pane_h = out_h // 2
        scaled_w = max(out_w, int(round(src_w * (pane_h / float(max(1, src_h))))))
        scaled_w += scaled_w % 2
        max_x = max(0, scaled_w - out_w)
        left_cx = float(track.get("left_cx", 0.25))
        right_cx = float(track.get("right_cx", 0.75))
        left_x = max(0, min(max_x, int(round(left_cx * scaled_w - out_w / 2.0))))
        right_x = max(0, min(max_x, int(round(right_cx * scaled_w - out_w / 2.0))))
        filter_parts.append(f"[0:v]scale={scaled_w}:{pane_h},split=2[_sp_a][_sp_b]")
        filter_parts.append(f"[_sp_a]crop={out_w}:{pane_h}:{left_x}:0,setsar=1[v_sp_top]")
        filter_parts.append(f"[_sp_b]crop={out_w}:{pane_h}:{right_x}:0,setsar=1[v_sp_bot]")
        filter_parts.append("[v_sp_top][v_sp_bot]vstack=inputs=2[v_base]")
        framing_mode = "dual_speaker_split"
    else:
        pane_expr, framing_mode = _build_single_pane_filter(
            in_label="0:v",
            out_label="v_base",
            src_w=src_w,
            src_h=src_h,
            target_w=out_w,
            target_h=out_h,
            smart_reframe=smart_reframe,
            track=track,
            sendcmd_path=sendcmd_path,
        )
        filter_parts.append(pane_expr)

    if has_ass_overlay and ass_path.exists():
        filter_parts.append(f"[v_base]ass='{escape_ffmpeg_filter_path(ass_path)}'[v_out]")
        final_v_label = "[v_out]"
    else:
        final_v_label = "[v_base]"

    filter_complex = ";".join(filter_parts)
    timeout_sec = compute_ffmpeg_timeout(clip_dur)

    cmd: List[str] = [
        "ffmpeg",
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        final_v_label,
    ]

    if info["has_audio"]:
        cmd.extend(
            [
                "-map",
                "0:a:0",
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
            ]
        )
    else:
        cmd.extend(["-an"])

    render_fps_env = os.environ.get("RENDER_FPS", "").strip()
    fps_args: List[str] = []
    if render_fps_env.isdigit() and int(render_fps_env) in (24, 25, 30, 60):
        fps_args = ["-r", render_fps_env]

    cmd.extend(
        [
            "-t",
            f"{clip_dur:.3f}",
            *fps_args,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-shortest",
            str(dst),
        ]
    )

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size < 10_000:
        raise RuntimeError(
            f"Single-pass FFmpeg clip render failed (exit {proc.returncode}): {proc.stderr[-800:]}"
        )

    # Clean up temporary sendcmd helper file
    try:
        if sendcmd_path.exists():
            sendcmd_path.unlink()
    except OSError:
        pass

    # 3. Generate thumbnail JPEG
    thumb_dst = Path(thumbnail_path).resolve() if thumbnail_path else dst.with_name(f"{dst.stem}_thumb.jpg")
    thumb_created = generate_clip_thumbnail(dst, thumb_dst, seek_sec=min(1.5, clip_dur * 0.35))

    return {
        "output_path": str(dst),
        "thumbnail_path": str(thumb_created) if thumb_created else None,
        "ass_path": str(ass_path) if has_ass_overlay else None,
        "width": out_w,
        "height": out_h,
        "duration_sec": round(clip_dur, 3),
        "framing_mode": framing_mode,
        "has_faces": bool(track.get("has_faces")),
        "dual_speaker": bool(track.get("dual_speaker", False)),
        "detector": track.get("detector", "opencv"),
        "scene_cuts": track.get("scene_cuts") or [],
    }


def reframe_clip_to_vertical(
    source_video: str | Path,
    start_time: float,
    end_time: float,
    output_path: Optional[str | Path] = None,
    clip_id: int = 1,
    rolling_window: int = 15,
    aspect_ratio: str = "9:16 Portrait",
    smart_reframe: bool = True,
    split_screen: bool = False,
    background_video: str = "All",
) -> Dict[str, Any]:
    """Compatibility wrapper calling the single-pass renderer without captions."""
    out = (
        Path(output_path).resolve()
        if output_path
        else (ROOT_DIR / "temp" / "clips" / f"clip_{clip_id}.mp4").resolve()
    )
    return render_clip_single_pass(
        source_video=source_video,
        start_time=start_time,
        end_time=end_time,
        output_path=out,
        aspect_ratio=aspect_ratio,
        smart_reframe=smart_reframe,
        split_screen=split_screen,
        background_video=background_video,
        captions_enabled=False,
        auto_hook=False,
    )


def reframe_clips(
    source_video: str | Path,
    clips: List[Dict[str, Any]],
    output_dir: Optional[str | Path] = None,
) -> List[Dict[str, Any]]:
    out_dir = Path(output_dir).resolve() if output_dir else (ROOT_DIR / "temp" / "clips").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    results: List[Dict[str, Any]] = []
    for idx, clip in enumerate(clips, start=1):
        res = reframe_clip_to_vertical(
            source_video=source_video,
            start_time=float(clip["start_time"]),
            end_time=float(clip["end_time"]),
            output_path=out_dir / f"clip_{idx}.mp4",
            clip_id=idx,
        )
        results.append({**clip, **res})
    return results
