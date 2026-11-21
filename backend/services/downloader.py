from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import yt_dlp

try:
    from .youtube_auth import youtube_auth
except ImportError:
    from youtube_auth import youtube_auth  # type: ignore

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent if BACKEND_DIR.name == "backend" else BACKEND_DIR
DEFAULT_DOWNLOAD_DIR = ROOT_DIR / "temp" / "downloads"
UPLOADS_DIR = ROOT_DIR / "uploads"

DEFAULT_MAX_VIDEO_MB = 2048.0  # 2 GB default limit
DEFAULT_MAX_DURATION_SEC = 14400.0  # 4 hours default limit
OAUTH_DOWNLOADER_SCRIPT = BACKEND_DIR / "scripts" / "yt_oauth_download.mjs"

DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


class _QuietYtdlpLogger:
    """Prevents yt-dlp from writing to stdout/stderr pipes that may be closed in daemon mode."""

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass


def _extract_youtube_video_id(url: str) -> Optional[str]:
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
        if not any(d in host for d in ("youtube.com", "youtu.be", "youtube-nocookie.com")):
            return None
        if "youtu.be" in host:
            seg = parsed.path.strip("/").split("/")[0]
            return seg if re.fullmatch(r"[A-Za-z0-9_-]{11}", seg) else None
        qs = urllib.parse.parse_qs(parsed.query)
        if qs.get("v") and re.fullmatch(r"[A-Za-z0-9_-]{11}", qs["v"][0]):
            return qs["v"][0]
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in {"live", "shorts", "embed", "v"}:
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", parts[1]):
                return parts[1]
    except Exception:
        return None
    return None


def _fetch_youtube_oembed(video_id: str, canonical_url: str) -> Optional[Dict[str, Any]]:
    """Fetch public YouTube metadata via official oEmbed when yt-dlp hits a cloud IP bot check."""
    oembed_url = (
        "https://www.youtube.com/oembed?"
        + urllib.parse.urlencode({"url": canonical_url, "format": "json"})
    )
    req = urllib.request.Request(oembed_url, headers={"User-Agent": DESKTOP_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore") or "{}")
        if not data or not data.get("title"):
            return None
        thumb = str(data.get("thumbnail_url") or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")
        author = str(data.get("author_name") or "YouTube Creator")
        return {
            "video_id": video_id,
            "url": canonical_url,
            "title": str(data.get("title") or "YouTube Video"),
            "thumbnail": thumb,
            "thumbnail_url": thumb,
            "duration": "0:00",
            "duration_str": "0:00",
            "duration_sec": 0,
            "channel_name": author,
            "author": author,
            "platform": "YouTube",
        }
    except Exception:
        return None


def get_max_video_mb() -> float:
    try:
        val = float(os.environ.get("MAX_VIDEO_SIZE_MB", str(DEFAULT_MAX_VIDEO_MB)))
        return max(DEFAULT_MAX_VIDEO_MB, val)
    except ValueError:
        return DEFAULT_MAX_VIDEO_MB


def get_max_duration_sec() -> float:
    try:
        val = float(os.environ.get("MAX_VIDEO_DURATION_SEC", str(DEFAULT_MAX_DURATION_SEC)))
        return max(DEFAULT_MAX_DURATION_SEC, val)
    except ValueError:
        return DEFAULT_MAX_DURATION_SEC


def format_duration(seconds: Optional[float]) -> str:
    if not seconds or seconds <= 0:
        return "0:00"
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def probe_media_file(file_path: Path | str) -> Dict[str, Any]:
    """Validate media file with ffprobe and return duration, resolution, codecs, and size."""
    src = Path(file_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"Media file not found: {src}")

    size_bytes = src.stat().st_size
    if size_bytes < 1024:
        raise ValueError("Video file is empty or corrupted (< 1 KB).")

    max_mb = get_max_video_mb()
    if size_bytes > max_mb * 1024 * 1024:
        raise ValueError(
            f"Video exceeds the maximum allowed size ({size_bytes / (1024 * 1024):.1f} MB > {max_mb:.0f} MB)."
        )

    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,channels",
            "-of",
            "json",
            str(src),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise ValueError(f"ffprobe rejected this media file: {err or 'unreadable video stream'}")

    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    fmt = data.get("format") or {}

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if not video_stream:
        raise ValueError("Media file contains no valid video stream.")

    duration_sec = float(fmt.get("duration") or 0.0)
    if duration_sec <= 0.5:
        raise ValueError("Media file has invalid or zero duration.")

    max_dur = get_max_duration_sec()
    if duration_sec > max_dur:
        raise ValueError(
            f"Video duration ({format_duration(duration_sec)}) exceeds the maximum limit ({format_duration(max_dur)})."
        )

    return {
        "file_path": str(src),
        "size_bytes": size_bytes,
        "duration_sec": round(duration_sec, 3),
        "duration": format_duration(duration_sec),
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "video_codec": str(video_stream.get("codec_name") or ""),
        "has_audio": audio_stream is not None,
        "audio_codec": str(audio_stream.get("codec_name") or "") if audio_stream else "",
    }


def _fetch_youtube_tv_metadata(video_id: str) -> Optional[Dict[str, Any]]:
    """Query YouTube TVHTML5 InnerTube player API when OAuth is connected to inspect real duration/playability."""
    token = youtube_auth.get_valid_access_token()
    if not token:
        return None
    payload = {
        "videoId": video_id,
        "context": {
            "client": {
                "clientName": "TVHTML5",
                "clientVersion": "7.20250219.16.00",
                "hl": "en",
                "gl": "US",
            }
        },
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    req = urllib.request.Request(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
            "Origin": "https://www.youtube.com",
            "Referer": "https://www.youtube.com/tv",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore") or "{}")
        vd = data.get("videoDetails") or {}
        ps = data.get("playabilityStatus") or {}
        dur_sec = int(float(vd.get("lengthSeconds") or 0))
        return {
            "status": str(ps.get("status") or ""),
            "reason": str(ps.get("reason") or ""),
            "title": str(vd.get("title") or ""),
            "author": str(vd.get("author") or ""),
            "duration_sec": dur_sec,
            "is_live": bool(vd.get("isLiveContent")),
        }
    except Exception:
        return None


def _apply_cookie_options(ydl_opts: Dict[str, Any], player_clients: Optional[list[str]] = None) -> None:
    """
    Configure yt-dlp safely:
      - NEVER attach a YouTube TV OAuth Bearer header globally (YouTube web/android APIs reject it with HTTP 400).
      - NEVER override User-Agent globally (let yt-dlp pair the right UA with each client).
      - Attach optional YOUTUBE_COOKIES_FILE / YOUTUBE_COOKIES when configured.
      - Always attach _QuietYtdlpLogger so daemon stderr never triggers BrokenPipeError.
    """
    cookies_file = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if cookies_file and Path(cookies_file).exists():
        ydl_opts["cookiefile"] = cookies_file
    else:
        cookie_header = os.environ.get("YOUTUBE_COOKIES", "").strip()
        if cookie_header:
            headers = dict(ydl_opts.get("http_headers") or {})
            headers["Cookie"] = cookie_header
            ydl_opts["http_headers"] = headers

    ydl_opts["logger"] = _QuietYtdlpLogger()
    ydl_opts["noprogress"] = True

    if player_clients:
        ydl_opts["extractor_args"] = {"youtube": {"player_client": player_clients}}


def _is_bot_check_error(err_text: str) -> bool:
    low = (err_text or "").lower()
    return (
        "confirm you’re not a bot" in low
        or "confirm you're not a bot" in low
        or "sign in to confirm" in low
        or "bot verification" in low
    )


def _format_ytdlp_user_error(err_text: str, yt_video_id: Optional[str] = None) -> str:
    clean = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?", "", (err_text or "").strip())
    if _is_bot_check_error(clean):
        if yt_video_id:
            tv_meta = _fetch_youtube_tv_metadata(yt_video_id)
            if tv_meta and tv_meta.get("duration_sec", 0) > get_max_duration_sec():
                return (
                    f"This video is {format_duration(tv_meta['duration_sec'])} long, which exceeds the "
                    f"{format_duration(get_max_duration_sec())} limit. Please pick a shorter video or upload an MP4/MOV file."
                )
        return (
            'YouTube blocked this cloud server IP with bot verification ("Sign in to confirm you\'re not a bot"). '
            "Verify your YouTube account once below to unblock YouTube links, configure YOUTUBE_COOKIES_FILE, or upload an MP4/MOV file directly."
        )
    if "400" in clean and "bad request" in clean.lower():
        return (
            "YouTube rejected the automated stream request (HTTP 400). "
            "Click Retry, try another YouTube link, or upload an MP4/MOV file directly."
        )
    # Strip verbose yt-dlp wiki URLs from user-facing messages
    clean = re.sub(r"\s*See\s+https?://github\.com/yt-dlp/\S+.*$", "", clean, flags=re.IGNORECASE).strip()
    return clean or "Unable to fetch this video. Please verify the link is public or upload an MP4/MOV file."


class _OAuthDownloadHardError(ValueError):
    """Non-recoverable YouTube error (duration limit, private/unplayable video, etc.) that should be shown directly."""


def _download_youtube_via_oauth(
    video_id: str,
    target_dir: Path,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Download a YouTube video using the user's verified YouTube TV OAuth2 credentials
    via backend/scripts/yt_oauth_download.mjs (youtubei.js + googlevideo SABR).
    Returns the standard download_video() metadata dict on success, or None if
    OAuth/Node helper is unavailable so the caller can fall back to yt-dlp.
    Raises _OAuthDownloadHardError for deterministic video issues (e.g. duration limit, unplayable).
    """
    token = youtube_auth.get_valid_access_token()
    if not token:
        return None

    token_path = getattr(youtube_auth, "_token_path", BACKEND_DIR / "data" / "youtube_oauth.json")
    if not Path(token_path).exists():
        return None
    if not OAUTH_DOWNLOADER_SCRIPT.exists():
        return None
    node_bin = shutil.which("node")
    if not node_bin:
        return None

    out_mp4 = target_dir / f"{video_id}.mp4"
    max_dur_sec = int(get_max_duration_sec())
    max_size_bytes = int(get_max_video_mb() * 1024 * 1024)

    cmd = [
        node_bin,
        str(OAUTH_DOWNLOADER_SCRIPT),
        video_id,
        str(token_path),
        str(out_mp4),
        str(max_dur_sec),
        str(max_size_bytes),
    ]

    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    err_code = ""
    err_msg = ""
    stderr_lines: list[str] = []

    assert proc.stderr is not None
    assert proc.stdout is not None

    for raw_line in proc.stderr:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("PROGRESS:"):
            if progress_callback:
                try:
                    val = float(line.split(":", 1)[1])
                    progress_callback(max(0.0, min(0.98, val)))
                except ValueError:
                    pass
        elif line.startswith("ERROR_CODE:"):
            err_code = line.split(":", 1)[1].strip()
        elif line.startswith("ERROR_MSG:"):
            err_msg = line.split(":", 1)[1].strip()
        else:
            if len(stderr_lines) < 30:
                stderr_lines.append(line)

    stdout_text = proc.stdout.read() or ""
    return_code = proc.wait(timeout=60)

    if return_code != 0:
        if err_code in {"DURATION_EXCEEDED", "UNPLAYABLE"}:
            raise _OAuthDownloadHardError(err_msg or "This YouTube video cannot be processed.")
        if err_code in {"NO_OAUTH", "MISSING_DEPS"}:
            return None
        raise RuntimeError(err_msg or (stderr_lines[-1] if stderr_lines else "Authenticated YouTube download failed."))

    parsed: Optional[Dict[str, Any]] = None
    for line in stdout_text.splitlines():
        if line.startswith("RESULT_JSON:"):
            try:
                parsed = json.loads(line.split("RESULT_JSON:", 1)[1])
            except Exception:
                parsed = None
            break

    if not parsed or not out_mp4.exists():
        raise RuntimeError("Authenticated YouTube download finished without producing an MP4 file.")

    probed = probe_media_file(out_mp4)
    if progress_callback:
        progress_callback(1.0)

    canonical_url = f"https://www.youtube.com/watch?v={video_id}"
    title = str(parsed.get("title") or "").strip()
    author = str(parsed.get("author") or "").strip()
    thumbnail = str(parsed.get("thumbnail") or "").strip()

    if not title or not author:
        oembed = _fetch_youtube_oembed(video_id, canonical_url)
        if oembed:
            title = title or str(oembed.get("title") or "")
            author = author or str(oembed.get("channel_name") or "")
            thumbnail = thumbnail or str(oembed.get("thumbnail") or "")

    return {
        "video_id": video_id,
        "url": canonical_url,
        "title": title or "YouTube Video",
        "thumbnail": thumbnail or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "duration": probed["duration"],
        "duration_sec": probed["duration_sec"],
        "channel_name": author or "YouTube Creator",
        "platform": "YouTube",
        "file_path": str(out_mp4),
        "width": probed["width"],
        "height": probed["height"],
        "has_audio": probed["has_audio"],
        "subtitles_path": None,
    }


def resolve_local_upload_path(url_or_path: str) -> Optional[Path]:
    """Map `/uploads/<filename>` or local file paths safely to disk."""
    clean = url_or_path.strip()
    if clean.startswith("/uploads/"):
        filename = Path(clean).name
        candidate = (UPLOADS_DIR / filename).resolve()
        if str(candidate).startswith(str(UPLOADS_DIR.resolve())) and candidate.exists():
            return candidate
        raise FileNotFoundError(f"Uploaded file not found: {filename}")

    candidate = Path(clean)
    if candidate.is_absolute() and candidate.exists() and candidate.is_file():
        return candidate
    return None


def _is_direct_media_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
        return bool(re.search(r"\.(mp4|mov|webm|mkv|m4v)$", parsed.path, re.IGNORECASE))
    except Exception:
        return False


def fetch_video_metadata(url: str) -> Dict[str, Any]:
    """Fetch video metadata for local uploads, direct media URLs, or yt-dlp supported URLs."""
    clean_url = url.strip()
    if not clean_url:
        raise ValueError("Video URL cannot be empty.")

    local_path = resolve_local_upload_path(clean_url)
    if local_path is not None:
        probed = probe_media_file(local_path)
        title = re.sub(r"^\d+_[a-f0-9]+_", "", local_path.stem) or local_path.stem
        return {
            "video_id": local_path.stem,
            "url": clean_url,
            "title": title,
            "thumbnail": "",
            "thumbnail_url": "",
            "duration": probed["duration"],
            "duration_str": probed["duration"],
            "duration_sec": int(round(probed["duration_sec"])),
            "channel_name": "Uploaded File",
            "author": "Uploaded File",
            "platform": "Uploaded File",
        }

    yt_video_id = _extract_youtube_video_id(clean_url)
    target_url = f"https://www.youtube.com/watch?v={yt_video_id}" if yt_video_id else clean_url

    client_strategies: list[Optional[list[str]]] = (
        [None, ["tv_embedded"], ["android_vr"]] if yt_video_id else [None]
    )

    info: Optional[Dict[str, Any]] = None
    last_err: Optional[Exception] = None
    for clients in client_strategies:
        ydl_opts: Dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "extract_flat": False,
            "socket_timeout": 20,
        }
        _apply_cookie_options(ydl_opts, player_clients=clients)
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(target_url, download=False)
            if info:
                break
        except Exception as exc:
            last_err = exc
            if _is_bot_check_error(str(exc)):
                # Try next client strategy once; if all hit bot check, fall through to oEmbed/TV meta
                continue

    if not info:
        err_text = str(last_err or "").strip()
        if yt_video_id:
            oembed = _fetch_youtube_oembed(yt_video_id, target_url)
            if oembed is not None:
                tv_meta = _fetch_youtube_tv_metadata(yt_video_id)
                if tv_meta and tv_meta.get("duration_sec", 0) > 0:
                    dur_s = int(tv_meta["duration_sec"])
                    oembed["duration_sec"] = dur_s
                    oembed["duration"] = format_duration(dur_s)
                    oembed["duration_str"] = format_duration(dur_s)
                return oembed
        raise ValueError(_format_ytdlp_user_error(err_text, yt_video_id))

    raw_duration = float(info.get("duration") or 0.0)
    max_dur = get_max_duration_sec()
    if raw_duration > max_dur:
        raise ValueError(
            f"Video duration ({format_duration(raw_duration)}) exceeds maximum allowed ({format_duration(max_dur)})."
        )

    duration_sec = int(round(raw_duration))
    extractor = str(info.get("extractor_key") or info.get("extractor") or "Video")
    platform = "YouTube" if "youtube" in extractor.lower() else extractor
    thumb = str(info.get("thumbnail") or "")
    channel = str(info.get("channel") or info.get("uploader") or "Creator")
    dur_str = format_duration(raw_duration)

    return {
        "video_id": str(info.get("id") or yt_video_id or ""),
        "url": str(info.get("webpage_url") or target_url),
        "title": str(info.get("title") or "Untitled Video"),
        "thumbnail": thumb,
        "thumbnail_url": thumb,
        "duration": dur_str,
        "duration_str": dur_str,
        "duration_sec": duration_sec,
        "channel_name": channel,
        "author": channel,
        "platform": platform,
    }


def download_video(
    url: str,
    output_dir: Optional[Path] = None,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Dict[str, Any]:
    """
    Ingest either an uploaded local video or remote URL (via yt-dlp with optional cookies),
    validate with ffprobe, and enforce size/duration limits from env.
    """
    clean_url = url.strip()
    if not clean_url:
        raise ValueError("Video URL cannot be empty.")

    target_dir = (output_dir or DEFAULT_DOWNLOAD_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    # 1. Uploaded or local file path
    local_path = resolve_local_upload_path(clean_url)
    if local_path is not None:
        probed = probe_media_file(local_path)
        if progress_callback:
            progress_callback(1.0)
        title = re.sub(r"^\d+_[a-f0-9]+_", "", local_path.stem) or local_path.stem
        return {
            "video_id": local_path.stem,
            "url": clean_url,
            "title": title,
            "thumbnail": "",
            "duration": probed["duration"],
            "duration_sec": probed["duration_sec"],
            "channel_name": "Uploaded File",
            "platform": "Uploaded File",
            "file_path": str(local_path),
            "width": probed["width"],
            "height": probed["height"],
            "has_audio": probed["has_audio"],
            "subtitles_path": None,
        }

    # 2. Remote URL via yt-dlp
    max_filesize_bytes = int(get_max_video_mb() * 1024 * 1024)

    def _hook(d: Dict[str, Any]) -> None:
        if not progress_callback:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            if total > 0:
                progress_callback(max(0.0, min(0.95, downloaded / total)))
        elif d.get("status") == "finished":
            progress_callback(0.98)

    yt_video_id = _extract_youtube_video_id(clean_url)
    download_target = f"https://www.youtube.com/watch?v={yt_video_id}" if yt_video_id else clean_url

    # 2a. If this is a YouTube URL and the user has connected their YouTube account via Device OAuth
    # (and no explicit cookies file is configured), use authenticated YouTube TV SABR directly first.
    # This bypasses cloud-IP bot checks and avoids wasting 15s on blocked unauthenticated yt-dlp clients.
    has_explicit_cookies = bool(
        (os.environ.get("YOUTUBE_COOKIES_FILE", "").strip() and Path(os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()).exists())
        or os.environ.get("YOUTUBE_COOKIES", "").strip()
    )
    oauth_attempted = False
    oauth_err: Optional[Exception] = None
    if yt_video_id and not has_explicit_cookies and youtube_auth.get_valid_access_token():
        oauth_attempted = True
        try:
            oauth_result = _download_youtube_via_oauth(yt_video_id, target_dir, progress_callback)
            if oauth_result is not None:
                return oauth_result
        except _OAuthDownloadHardError as exc:
            raise ValueError(str(exc)) from exc
        except Exception as exc:
            oauth_err = exc

    client_strategies: list[Optional[list[str]]] = (
        [None, ["tv_embedded"], ["android_vr"], ["web_safari"]] if yt_video_id else [None]
    )

    info: Optional[Dict[str, Any]] = None
    prepared: Optional[Path] = None
    last_err: Optional[Exception] = None

    for clients in client_strategies:
        ydl_opts: Dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "max_filesize": max_filesize_bytes,
            "format": (
                "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
                "bestvideo[height<=1080]+bestaudio/"
                "best[ext=mp4]/best"
            ),
            "merge_output_format": "mp4",
            "outtmpl": str(target_dir / "%(id)s.%(ext)s"),
            "progress_hooks": [_hook],
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitlesformat": "vtt/srt/best",
            "subtitleslangs": ["en", "hi", "en-US", "en-GB"],
            "ignoreerrors": False,
            "socket_timeout": 30,
        }
        _apply_cookie_options(ydl_opts, player_clients=clients)

        if _is_direct_media_url(clean_url):
            ydl_opts["writesubtitles"] = False
            ydl_opts["writeautomaticsub"] = False

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(download_target, download=True)
                if info:
                    prepared = Path(ydl.prepare_filename(info))
                    break
        except Exception as exc:
            last_err = exc
            continue

    # 2b. If yt-dlp failed (e.g. cookies expired or bot check) and OAuth hasn't been tried yet, try OAuth now.
    if (not info or prepared is None) and yt_video_id and not oauth_attempted and youtube_auth.get_valid_access_token():
        try:
            oauth_result = _download_youtube_via_oauth(yt_video_id, target_dir, progress_callback)
            if oauth_result is not None:
                return oauth_result
        except _OAuthDownloadHardError as exc:
            raise ValueError(str(exc)) from exc
        except Exception as exc:
            oauth_err = exc

    if not info or prepared is None:
        if oauth_err is not None and _is_bot_check_error(str(last_err or "")):
            raise RuntimeError(str(oauth_err))
        raise RuntimeError(_format_ytdlp_user_error(str(last_err or ""), yt_video_id))

    video_id = str(info.get("id") or prepared.stem)
    mp4_path = target_dir / f"{video_id}.mp4"
    if not mp4_path.exists():
        if prepared.exists() and prepared.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}:
            mp4_path = prepared
        else:
            media_exts = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
            matches = [p for p in sorted(target_dir.glob(f"{video_id}.*")) if p.suffix.lower() in media_exts]
            if not matches:
                raise FileNotFoundError(f"Downloaded media file missing for video_id={video_id}")
            mp4_path = matches[0]

    # Validate final downloaded video with ffprobe (enforces codecs, size, duration)
    probed = probe_media_file(mp4_path)
    if progress_callback:
        progress_callback(1.0)

    # Locate optional subtitle file (used ONLY as a last-resort fallback if faster-whisper fails)
    sub_matches = sorted(
        list(target_dir.glob(f"{video_id}*.vtt")) + list(target_dir.glob(f"{video_id}*.srt"))
    )
    subtitles_path = str(sub_matches[0]) if sub_matches else None

    extractor = str(info.get("extractor_key") or info.get("extractor") or "Video")
    platform = "YouTube" if "youtube" in extractor.lower() else extractor

    return {
        "video_id": video_id,
        "url": str(info.get("webpage_url") or clean_url),
        "title": str(info.get("title") or "Untitled Video"),
        "thumbnail": str(info.get("thumbnail") or ""),
        "duration": probed["duration"],
        "duration_sec": probed["duration_sec"],
        "channel_name": str(info.get("channel") or info.get("uploader") or "Creator"),
        "platform": platform,
        "file_path": str(mp4_path),
        "width": probed["width"],
        "height": probed["height"],
        "has_audio": probed["has_audio"],
        "subtitles_path": subtitles_path,
    }


def save_uploaded_file_stream(src_file: Any, original_filename: str, dest_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Stream an uploaded video file to disk, validate with ffprobe, and return metadata."""
    target_dir = (dest_dir or UPLOADS_DIR).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(original_filename or "video.mp4").suffix.lower()
    if ext not in {".mp4", ".mov", ".webm", ".mkv", ".m4v"}:
        ext = ".mp4"

    safe_base = re.sub(r"[^a-zA-Z0-9._-]", "_", Path(original_filename or "video").stem)[:64] or "video"
    import time
    import uuid

    filename = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}_{safe_base}{ext}"
    dest_path = target_dir / filename

    max_bytes = int(get_max_video_mb() * 1024 * 1024)
    written = 0
    try:
        with open(dest_path, "wb") as out_f:
            while True:
                chunk = src_file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise ValueError(
                        f"Uploaded video exceeds maximum allowed size of {get_max_video_mb():.0f} MB."
                    )
                out_f.write(chunk)

        probed = probe_media_file(dest_path)
    except Exception:
        if dest_path.exists():
            dest_path.unlink(missing_ok=True)
        raise

    public_url = f"/uploads/{filename}"
    return {
        "video_id": dest_path.stem,
        "url": public_url,
        "file_path": str(dest_path),
        "title": safe_base.replace("_", " ").strip() or "Uploaded Video",
        "author": "Uploaded File",
        "channel_name": "Uploaded File",
        "duration": probed["duration"],
        "duration_str": probed["duration"],
        "duration_sec": int(round(probed["duration_sec"])),
        "thumbnail": "",
        "thumbnail_url": "",
        "platform": "Uploaded File",
        "width": probed["width"],
        "height": probed["height"],
    }
