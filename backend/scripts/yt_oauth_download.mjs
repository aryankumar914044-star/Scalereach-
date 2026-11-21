#!/usr/bin/env node
/**
 * Authenticated YouTube TV downloader using youtubei.js + googlevideo SABR.
 * Invoked by backend/services/downloader.py when the user has verified their
 * YouTube account via Device Code OAuth (backend/data/youtube_oauth.json).
 *
 * Usage:
 *   node backend/scripts/yt_oauth_download.mjs <videoId> <tokenJsonPath> <outputMp4Path> [maxDurationSec] [maxSizeBytes]
 *
 * Security: Never logs or prints OAuth tokens or secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Emit a single progress line to stderr for Python progress_callback parsing.
function emitProgress(ratio) {
  const clamped = Math.max(0, Math.min(0.99, Number(ratio) || 0));
  process.stderr.write(`PROGRESS:${clamped.toFixed(4)}\n`);
}

function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fail(code, message) {
  process.stderr.write(`ERROR_CODE:${code}\n`);
  process.stderr.write(`ERROR_MSG:${String(message || 'Unknown download error').replace(/\r?\n/g, ' ')}\n`);
  process.exit(1);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    proc.stderr.on('data', (chunk) => {
      if (errBuf.length < 4096) errBuf += chunk.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errBuf.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function pickVideoFormat(formats, durationSec, maxSizeBytes) {
  let maxHeight = 1080;
  if (durationSec > 7200) {
    maxHeight = 360;
  } else if (durationSec > 3600) {
    maxHeight = 480;
  } else if (durationSec > 1200) {
    maxHeight = 720;
  }

  const allVideos = formats.filter((f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('video/'));
  if (allVideos.length === 0) return undefined;

  // Prefer MP4 H.264 (fast remux & broad FFmpeg compatibility), then MP4, then any video.
  const withinHeight = allVideos.filter((f) => (f.height || 0) <= maxHeight);
  const basePool = withinHeight.length > 0 ? withinHeight : allVideos;

  // Estimate stream size and avoid exceeding maxSizeBytes (reserve 15% headroom for audio + muxing).
  const budgetBytes = maxSizeBytes > 0 ? maxSizeBytes * 0.85 : Infinity;
  const fitsSize = (f) => {
    if (!Number.isFinite(budgetBytes) || !durationSec) return true;
    const estBytes =
      Number(f.contentLength || 0) ||
      ((Number(f.bitrate || 0) * durationSec) / 8);
    return estBytes <= 0 || estBytes <= budgetBytes;
  };

  const sizedPool = basePool.filter(fitsSize);
  const pool = sizedPool.length > 0 ? sizedPool : basePool;

  const mp4H264 = pool.filter(
    (f) => f.mimeType.includes('video/mp4') && f.mimeType.includes('avc1')
  );
  const mp4Any = pool.filter((f) => f.mimeType.includes('video/mp4'));
  const ranked = [...(mp4H264.length ? mp4H264 : mp4Any.length ? mp4Any : pool)];

  ranked.sort((a, b) => {
    const hDiff = (b.height || 0) - (a.height || 0);
    if (hDiff !== 0) return hDiff;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });

  return ranked[0];
}

function pickAudioFormat(formats) {
  const allAudio = formats.filter((f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/'));
  if (allAudio.length === 0) return undefined;

  // Prefer original/default audio track when multi-language audio tracks exist
  const mp4Audio = allAudio.filter((f) => f.mimeType.includes('audio/mp4'));
  const pool = [...(mp4Audio.length ? mp4Audio : allAudio)];

  pool.sort((a, b) => {
    const aIsDefault = a.audioTrackId?.includes('.4') || a.isOriginal ? 1 : 0;
    const bIsDefault = b.audioTrackId?.includes('.4') || b.isOriginal ? 1 : 0;
    if (bIsDefault !== aIsDefault) return bIsDefault - aIsDefault;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });

  return pool[0];
}

async function downloadViaSabr({
  yt,
  info,
  videoId,
  outputMp4Path,
  durationSec,
  maxSizeBytes,
  Constants,
  SabrStream,
  buildSabrFormat,
}) {
  const rawSabrUrl = info.streaming_data?.server_abr_streaming_url;
  const ustreamerConfig =
    info.player_config?.media_common_config?.media_ustreamer_request_config
      ?.video_playback_ustreamer_config;
  const adaptiveFormats = info.streaming_data?.adaptive_formats || [];

  if (!rawSabrUrl || !ustreamerConfig || adaptiveFormats.length === 0) {
    throw new Error('SABR streaming metadata not available for this video.');
  }

  const serverAbrStreamingUrl = await yt.session.player.decipher(rawSabrUrl);
  const sabrFormats = adaptiveFormats.map(buildSabrFormat);
  const clientNameId = parseInt(
    Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName],
    10
  );
  const clientInfo = {
    clientName: Number.isFinite(clientNameId) ? clientNameId : 7,
    clientVersion: yt.session.context.client.clientVersion,
  };

  const sabrStream = new SabrStream({
    videoId,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    clientInfo,
    formats: sabrFormats,
    callbacks: {
      onReloadPlayerResponse: async () => {
        const refreshed = await yt.getBasicInfo(videoId, { client: 'TV' });
        const nextUrl = await yt.session.player.decipher(
          refreshed.streaming_data?.server_abr_streaming_url
        );
        const nextConfig =
          refreshed.player_config?.media_common_config?.media_ustreamer_request_config
            ?.video_playback_ustreamer_config;
        return {
          serverAbrStreamingUrl: nextUrl,
          videoPlaybackUstreamerConfig: nextConfig || ustreamerConfig,
        };
      },
    },
  });

  let streamError = null;
  sabrStream.on('error', (err) => {
    streamError = err;
  });

  const { videoStream, audioStream, selectedFormats } = sabrStream.start({
    videoFormat: (fmts) => pickVideoFormat(fmts, durationSec, maxSizeBytes),
    audioFormat: (fmts) => pickAudioFormat(fmts),
    isPostLiveDvr: Boolean(info.basic_info?.is_post_live_dvr),
    maxRetries: 8,
    stallDetectionMs: 45_000,
  });

  const vPart = `${outputMp4Path}.video.part`;
  const aPart = `${outputMp4Path}.audio.part`;

  const estVideoBytes =
    Number(selectedFormats.videoFormat?.contentLength || 0) ||
    ((Number(selectedFormats.videoFormat?.bitrate || 0) * Math.max(1, durationSec)) / 8);
  const estAudioBytes =
    Number(selectedFormats.audioFormat?.contentLength || 0) ||
    ((Number(selectedFormats.audioFormat?.bitrate || 0) * Math.max(1, durationSec)) / 8);
  const estTotalBytes = Math.max(1, estVideoBytes + estAudioBytes);

  let downloadedBytes = 0;
  let lastProgressEmit = 0;

  function makeProgressCounter(webStream) {
    const nodeReadable = Readable.fromWeb(webStream);
    nodeReadable.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (maxSizeBytes > 0 && downloadedBytes > maxSizeBytes * 1.15) {
        nodeReadable.destroy(
          new Error(`Download exceeded maximum allowed file size (${Math.round(maxSizeBytes / (1024 * 1024))} MB).`)
        );
        return;
      }
      const now = Date.now();
      if (now - lastProgressEmit > 400) {
        lastProgressEmit = now;
        emitProgress(Math.min(0.90, 0.05 + (downloadedBytes / estTotalBytes) * 0.85));
      }
    });
    return nodeReadable;
  }

  try {
    emitProgress(0.05);
    await Promise.all([
      pipeline(makeProgressCounter(videoStream), fs.createWriteStream(vPart)),
      pipeline(makeProgressCounter(audioStream), fs.createWriteStream(aPart)),
    ]);

    if (streamError && (!fs.existsSync(vPart) || fs.statSync(vPart).size < 1024)) {
      throw streamError;
    }

    if (!fs.existsSync(vPart) || fs.statSync(vPart).size < 1024) {
      throw new Error('Downloaded video stream was empty.');
    }
    if (!fs.existsSync(aPart) || fs.statSync(aPart).size < 512) {
      throw new Error('Downloaded audio stream was empty.');
    }

    emitProgress(0.92);

    // Fast lossless remux into MP4; fallback to H.264/AAC transcode if input codecs aren't MP4-copyable.
    try {
      await runFfmpeg([
        '-y',
        '-i', vPart,
        '-i', aPart,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        outputMp4Path,
      ]);
    } catch {
      await runFfmpeg([
        '-y',
        '-i', vPart,
        '-i', aPart,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputMp4Path,
      ]);
    }

    emitProgress(0.98);
  } finally {
    try { fs.unlinkSync(vPart); } catch {}
    try { fs.unlinkSync(aPart); } catch {}
  }
}

async function downloadViaProgressive({ yt, info, outputMp4Path, maxSizeBytes }) {
  const fmts = (info.streaming_data?.formats || []).filter(
    (f) => f.has_video && f.has_audio && (f.url || f.signature_cipher || f.cipher)
  );
  if (fmts.length === 0) {
    throw new Error('No progressive MP4 formats available.');
  }
  fmts.sort((a, b) => (b.height || 0) - (a.height || 0));

  for (const fmt of fmts) {
    try {
      const directUrl = await fmt.decipher(yt.session.player);
      const res = await fetch(directUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
        },
      });
      if (!res.ok || !res.body) continue;

      const total = Number(res.headers.get('content-length') || 0);
      if (maxSizeBytes > 0 && total > maxSizeBytes) {
        throw new Error(`Video exceeds maximum allowed size (${Math.round(maxSizeBytes / (1024 * 1024))} MB).`);
      }

      let downloaded = 0;
      let lastEmit = 0;
      const readable = Readable.fromWeb(res.body);
      readable.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (total > 0 && now - lastEmit > 400) {
          lastEmit = now;
          emitProgress(Math.min(0.95, (downloaded / total) * 0.95));
        }
      });

      await pipeline(readable, fs.createWriteStream(outputMp4Path));
      if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 1024) {
        emitProgress(0.98);
        return;
      }
    } catch {
      continue;
    }
  }
  throw new Error('Could not download any progressive format.');
}

async function main() {
  const [, , videoId, tokenJsonPath, outputMp4Path, maxDurationArg, maxSizeArg] = process.argv;
  if (!videoId || !tokenJsonPath || !outputMp4Path) {
    fail('INVALID_ARGS', 'Usage: yt_oauth_download.mjs <videoId> <tokenJsonPath> <outputMp4Path> [maxDurationSec] [maxSizeBytes]');
  }

  const maxDurationSec = Number(maxDurationArg || 14400);
  const maxSizeBytes = Number(maxSizeArg || 2 * 1024 * 1024 * 1024);

  if (!fs.existsSync(tokenJsonPath)) {
    fail('NO_OAUTH', 'YouTube OAuth token file not found.');
  }

  let tok;
  try {
    tok = JSON.parse(fs.readFileSync(tokenJsonPath, 'utf8'));
  } catch {
    fail('NO_OAUTH', 'Could not read YouTube OAuth credentials.');
  }
  if (!tok?.access_token) {
    fail('NO_OAUTH', 'YouTube OAuth access token is missing.');
  }

  let Innertube, ClientType, Platform, Constants, SabrStream, buildSabrFormat;
  try {
    const ytMod = await import('youtubei.js');
    Innertube = ytMod.Innertube;
    ClientType = ytMod.ClientType;
    Platform = ytMod.Platform;
    Constants = ytMod.Constants;
    const sabrMod = await import('googlevideo/sabr-stream');
    SabrStream = sabrMod.SabrStream;
    const utilsMod = await import('googlevideo/utils');
    buildSabrFormat = utilsMod.buildSabrFormat;
  } catch (err) {
    fail('MISSING_DEPS', `YouTube OAuth Node dependencies unavailable: ${err?.message || err}`);
  }

  // Provide the JS decipher evaluator required by youtubei.js v18+.
  Platform.shim.eval = async (data) => {
    const fn = new Function(data.output);
    return fn();
  };

  const yt = await Innertube.create({
    client_type: ClientType.TV,
    retrieve_player: true,
  });

  const expiryMs = tok.expires_at ? Number(tok.expires_at) * 1000 : Date.now() + 3600 * 1000;
  await yt.session.signIn({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || '',
    expiry_date: new Date(expiryMs).toISOString(),
    client:
      tok.client_id && tok.client_secret
        ? { client_id: tok.client_id, client_secret: tok.client_secret }
        : undefined,
  });

  emitProgress(0.02);
  const info = await yt.getBasicInfo(videoId, { client: 'TV' });

  const status = info.playability_status?.status || 'UNKNOWN';
  if (status !== 'OK') {
    const reason = info.playability_status?.reason || `Video is not playable (status: ${status}).`;
    fail('UNPLAYABLE', reason);
  }

  const durationSec = Number(info.basic_info?.duration || 0);
  if (maxDurationSec > 0 && durationSec > maxDurationSec) {
    fail(
      'DURATION_EXCEEDED',
      `Video duration (${formatDuration(durationSec)}) exceeds the maximum limit (${formatDuration(maxDurationSec)}). Please pick a shorter video or upload an MP4/MOV file.`
    );
  }

  fs.mkdirSync(path.dirname(outputMp4Path), { recursive: true });

  // Prefer SABR (gives HD 720p/1080p MP4+AAC and works on SABR-only videos); fallback to progressive MP4.
  let sabrErr = null;
  try {
    await downloadViaSabr({
      yt,
      info,
      videoId,
      outputMp4Path,
      durationSec,
      maxSizeBytes,
      Constants,
      SabrStream,
      buildSabrFormat,
    });
  } catch (err) {
    sabrErr = err;
    try {
      await downloadViaProgressive({
        yt,
        info,
        outputMp4Path,
        maxSizeBytes,
      });
    } catch (progErr) {
      fail(
        'DOWNLOAD_FAILED',
        `Authenticated YouTube download failed: ${sabrErr?.message || progErr?.message || 'stream error'}`
      );
    }
  }

  const thumbs = info.basic_info?.thumbnail || [];
  const bestThumb =
    thumbs.length > 0
      ? thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || ''
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const result = {
    video_id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: String(info.basic_info?.title || ''),
    author: String(info.basic_info?.author || info.basic_info?.channel?.name || ''),
    duration_sec: durationSec,
    thumbnail: bestThumb,
    file_path: outputMp4Path,
  };

  process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  fail('DOWNLOAD_FAILED', err?.message || String(err));
});
