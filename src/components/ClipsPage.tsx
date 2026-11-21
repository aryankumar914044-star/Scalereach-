import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  Upload,
  ShieldCheck,
  Loader2,
  Download,
  RefreshCw,
  Languages,
  BarChart3,
  Scissors,
  Maximize2,
  Hash,
} from 'lucide-react';
import { ChatSupport } from './ChatSupport';
import { ScalereachSidebar } from './ScalereachSidebar';
import { resolveApiUrl, resolveMediaUrl } from '../lib/videoBackend';

interface UploadedVideoFallback {
  url: string;
  title: string;
  author: string;
  duration_sec: number;
  duration_str: string;
  thumbnail_url: string;
  platform: string;
}

interface ClipsPageProps {
  jobId?: string;
  videoTitle?: string;
  platform?: string;
  thumbnailUrl?: string;
  aspectRatio?: string;
  clipPreset?: string;
  onRetry?: () => Promise<void> | void;
  onUploadAndClip?: (uploaded: UploadedVideoFallback) => Promise<void> | void;
  onBack: () => void;
  onSignOut: () => void;
}

interface ClipSubScores {
  hook_strength?: number;
  story_completeness?: number;
  emotion_energy?: number;
  standalone_clarity?: number;
  pacing?: number;
  speech_rate?: number;
  audio_energy?: number;
}

interface ClipItem {
  id: number;
  clip_index?: number;
  tag: string;
  title: string;
  hookTitle?: string;
  description?: string;
  hashtags?: string[];
  hook_reason?: string;
  score: string;
  virality_score?: number;
  viral_score?: number;
  sub_scores?: ClipSubScores;
  score_reason?: string;
  amberScore?: boolean;
  favorite?: boolean;
  progress?: number;
  status?: 'rendering' | 'ready' | 'error';
  startSec?: number;
  endSec?: number;
  start_time?: number;
  end_time?: number;
  duration?: string;
  captionStyle?: string;
  aspectRatio?: string;
  language?: string;
  transcript: string;
  caption_text?: string;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
  videoUrl?: string | null;
  video_url?: string | null;
  downloadUrl?: string | null;
  download_url?: string | null;
}

interface BackendJobState {
  jobId: string;
  status?:
    | 'queued'
    | 'downloading'
    | 'transcribing'
    | 'analyzing'
    | 'tracking'
    | 'rendering'
    | 'completed'
    | 'failed';
  videoTitle: string;
  platform: string;
  stage: number;
  activeStepIndex: number;
  progress: number;
  current_step?: string;
  logs?: Array<string | { ts?: string; message?: string }>;
  note: string;
  clips: ClipItem[];
  error: string | null;
}

const STEP_NAMES = [
  'Downloading Source Video (yt-dlp)',
  'Word-Level Transcription (faster-whisper)',
  'Viral Hook & Story Detection (Gemini API)',
  'Active Speaker Face Tracking (MediaPipe)',
  '9:16 Rendering & Animated Captions (FFmpeg)',
];

const CAPTION_STYLE_OPTIONS = [
  { value: 'hormozi', label: 'Hormozi Bold Pop' },
  { value: 'minimal-clean', label: 'Minimal Clean' },
  { value: 'karaoke', label: 'Karaoke Highlight' },
  { value: 'classic', label: 'Classic' },
  { value: 'cyan-slide', label: 'Cyan Slide' },
  { value: 'italic-red', label: 'Italic Red' },
  { value: 'cream-blue', label: 'Cream Blue' },
  { value: 'red-spin', label: 'Red Spin' },
  { value: 'violet', label: 'Violet' },
  { value: 'blue-glow', label: 'Blue Glow' },
  { value: 'toxic-green', label: 'Toxic Green' },
];

const ASPECT_RATIO_OPTIONS = ['9:16 Portrait', '1:1 Square', '16:9 Landscape'];

const TRANSLATE_LANGUAGES = [
  'Hindi',
  'Hinglish',
  'English',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Arabic',
];

const SUB_SCORE_LABELS: Array<{ key: keyof ClipSubScores; label: string }> = [
  { key: 'hook_strength', label: 'Hook Strength' },
  { key: 'story_completeness', label: 'Story Complete' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'emotion_energy', label: 'Emotion' },
  { key: 'standalone_clarity', label: 'Clarity' },
  { key: 'speech_rate', label: 'Speech' },
  { key: 'audio_energy', label: 'Audio' },
];

function formatTimestamp(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

export function ClipsPage({
  jobId,
  videoTitle = 'Processing Video',
  platform = 'YouTube',
  thumbnailUrl,
  aspectRatio = '9:16',
  clipPreset = 'Viral Clips',
  onRetry,
  onUploadAndClip,
  onBack,
  onSignOut,
}: ClipsPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [liveTitle, setLiveTitle] = useState(videoTitle);
  const [livePlatform, setLivePlatform] = useState(platform);
  const [jobStatus, setJobStatus] = useState<string>('queued');
  const [currentStepText, setCurrentStepText] = useState<string>('Queued for processing');
  const [progress, setProgress] = useState(0);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [stage, setStage] = useState<number>(1);
  const [jobLogs, setJobLogs] = useState<string[]>([]);
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [clipProgress, setClipProgress] = useState<Record<number, number>>({});
  const [tick, setTick] = useState(0);
  const [jobError, setJobError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  // YouTube TV Device Verification state (optional)
  const [ytAuthLoading, setYtAuthLoading] = useState(false);
  const [ytAuthPending, setYtAuthPending] = useState<{
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  } | null>(null);
  const [ytAuthError, setYtAuthError] = useState<string | null>(null);
  const [ytAuthConnected, setYtAuthConnected] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // Direct MP4/MOV upload fallback right from error card
  const [isUploadingFallback, setIsUploadingFallback] = useState(false);
  const [uploadFallbackPct, setUploadFallbackPct] = useState(0);
  const [uploadFallbackErr, setUploadFallbackErr] = useState<string | null>(null);
  const fallbackFileInputRef = useRef<HTMLInputElement>(null);

  // Interactive clip controls (starts empty — never pre-populates fake clips)
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [openTranscripts, setOpenTranscripts] = useState<Record<number, boolean>>({});
  const [openScoreBreakdowns, setOpenScoreBreakdowns] = useState<Record<number, boolean>>({});
  const [favorites, setFavorites] = useState<Record<number, boolean>>({});
  const [modalInfo, setModalInfo] = useState<{
    title: string;
    body: string;
    videoUrl?: string | null;
    downloadUrl?: string | null;
  } | null>(null);
  const [editingClip, setEditingClip] = useState<ClipItem | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState('');
  const [editStartDraft, setEditStartDraft] = useState('0');
  const [editEndDraft, setEditEndDraft] = useState('30');
  const [editCaptionDraft, setEditCaptionDraft] = useState('');
  const [editStyleDraft, setEditStyleDraft] = useState('classic');
  const [editAspectDraft, setEditAspectDraft] = useState('9:16 Portrait');
  const [translateLangDraft, setTranslateLangDraft] = useState('Hindi');
  const [editBusyAction, setEditBusyAction] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccessMsg, setEditSuccessMsg] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');

  useEffect(() => {
    const ticker = window.setInterval(() => {
      setTick((t) => t + 1);
    }, 300);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    setJobError(null);
    setStage(1);
    setActiveStepIndex(0);
    setProgress(0);
    setJobStatus('queued');
    setCurrentStepText('Queued for processing');
    setJobLogs([]);
    setClips([]);
    setIsRetrying(false);

    let cancelled = false;
    let pollTimer: number | undefined;
    let consecutiveFailures = 0;

    const pollJob = async () => {
      try {
        const resp = await fetch(resolveApiUrl(`/api/status/${encodeURIComponent(jobId)}`));
        if (!resp.ok) {
          const errPayload = (await resp.json().catch(() => ({}))) as {
            detail?: string;
            error?: string;
          };
          if (resp.status === 503 || resp.status === 404) {
            if (!cancelled) {
              setJobError(
                errPayload.detail ||
                  errPayload.error ||
                  'Video processing backend is currently unavailable.'
              );
              setStage(1);
            }
            return;
          }
          throw new Error(errPayload.detail || errPayload.error || 'Could not fetch job status.');
        }
        consecutiveFailures = 0;
        const data = (await resp.json()) as BackendJobState;
        if (cancelled) return;

        if (data.videoTitle) setLiveTitle(data.videoTitle);
        if (data.platform) setLivePlatform(data.platform);
        if (data.status) setJobStatus(data.status);
        if (data.current_step) setCurrentStepText(data.current_step);
        if (Array.isArray(data.logs)) {
          const normalizedLogs = data.logs
            .map((entry) => {
              if (typeof entry === 'string') return entry;
              if (entry && typeof entry === 'object' && typeof entry.message === 'string') {
                return entry.message;
              }
              return '';
            })
            .filter((msg): msg is string => Boolean(msg && msg.trim()));
          setJobLogs(normalizedLogs);
        }
        setStage(data.stage || 1);
        setActiveStepIndex(
          Math.max(0, Math.min(STEP_NAMES.length - 1, data.activeStepIndex ?? 0))
        );
        setProgress(data.progress ?? 0);
        if (data.error) setJobError(data.error);
        if (typeof data.note === 'string' && !noteOpen) {
          setNoteText((prev) => (prev ? prev : data.note));
        }

        if (Array.isArray(data.clips) && data.clips.length > 0) {
          const normalized = data.clips.map((c) => ({
            ...c,
            score: c.score ?? String(c.virality_score ?? c.viral_score ?? 0),
            startSec: c.startSec ?? c.start_time ?? 0,
            endSec: c.endSec ?? c.end_time ?? 0,
            description: c.description || c.score_reason || '',
            hashtags: Array.isArray(c.hashtags) ? c.hashtags : [],
            hook_reason: c.hook_reason || c.score_reason || '',
            thumbnailUrl: c.thumbnailUrl ?? c.thumbnail_url ?? null,
            videoUrl: c.videoUrl ?? c.video_url ?? null,
            downloadUrl: c.downloadUrl ?? c.download_url ?? null,
          }));
          setClips(normalized);
          const nextProg: Record<number, number> = {};
          const nextFavs: Record<number, boolean> = {};
          normalized.forEach((c) => {
            nextProg[c.id] =
              typeof c.progress === 'number' ? c.progress : c.status === 'ready' ? 100 : 10;
            if (c.favorite) nextFavs[c.id] = true;
          });
          setClipProgress(nextProg);
          setFavorites((prev) => ({ ...nextFavs, ...prev }));
        }

        const isTerminal =
          data.status === 'completed' ||
          data.status === 'failed' ||
          Boolean(data.error) ||
          (Array.isArray(data.clips) &&
            data.clips.length > 0 &&
            data.clips.every((c) => c.status === 'ready' || (c.progress ?? 0) >= 100) &&
            data.progress >= 100);

        if (!isTerminal) {
          pollTimer = window.setTimeout(pollJob, 700);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          if (!cancelled) {
            setJobError(
              err instanceof Error
                ? err.message
                : 'Lost connection to the Python video processing backend.'
            );
            setStage(1);
          }
          return;
        }
        if (!cancelled) {
          pollTimer = window.setTimeout(pollJob, 1000);
        }
      }
    };

    void pollJob();
    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [jobId]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
        setModalInfo(null);
        setEditingClip(null);
        setNoteOpen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  const roundedProgress = Math.round(progress);
  const clipPercentages = clips.map((c) => clipProgress[c.id] ?? c.progress ?? 25);
  const avgClip =
    clipPercentages.length > 0
      ? clipPercentages.reduce((acc, v) => acc + v, 0) / clipPercentages.length
      : 25;
  const bannerPct = Math.min(100, Math.max(45, Math.round(45 + ((avgClip - 25) / 75) * 55)));
  const readyCount = clipPercentages.filter((v) => v >= 100).length;
  const statusHint = Math.floor(tick / 10) % 2 === 1 ? 'Almost there' : 'Hang tight';
  const showClipsDashboard =
    !jobError &&
    clips.length > 0 &&
    (jobStatus === 'completed' || jobStatus === 'rendering' || stage >= 5);
  const showPreviewBanner = !showClipsDashboard && !jobError && activeStepIndex >= 2;

  const shortAspect = aspectRatio.split(' ')[0] || '9:16';
  const isYouTubeBotBlock = Boolean(
    jobError &&
      (/bot verification|not a bot|LOGIN_REQUIRED|Sign in/i.test(jobError) ||
        (livePlatform.toLowerCase().includes('youtube') && !ytAuthConnected))
  );

  // Sync current YouTube OAuth2 verification status on mount
  useEffect(() => {
    let cancelled = false;
    fetch(resolveApiUrl('/api/youtube/auth/status'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { connected?: boolean } | null) => {
        if (!cancelled && data?.connected) {
          setYtAuthConnected(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll YouTube TV Device Verification until user approves on google.com/device, then auto-retry
  useEffect(() => {
    if (!ytAuthPending) return;
    let cancelled = false;

    const pollAuth = async () => {
      try {
        const resp = await fetch(resolveApiUrl('/api/youtube/auth/status'));
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as {
          connected?: boolean;
          pending?: { verificationUrl: string; userCode: string; expiresAt: number } | null;
          error?: string | null;
        };
        if (cancelled) return;

        if (data.connected) {
          setYtAuthConnected(true);
          setYtAuthPending(null);
          setYtAuthError(null);
          if (onRetry) {
            setIsRetrying(true);
            try {
              await onRetry();
            } finally {
              if (!cancelled) setIsRetrying(false);
            }
          }
          return;
        }
        if (data.error) {
          setYtAuthError(data.error);
          setYtAuthPending(null);
          return;
        }
        if (!data.pending) {
          setYtAuthPending(null);
        }
      } catch {
        // Keep polling transiently
      }
    };

    const timer = window.setInterval(() => {
      void pollAuth();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ytAuthPending, onRetry]);

  const handleStartYouTubeDeviceAuth = async () => {
    setYtAuthLoading(true);
    setYtAuthError(null);
    setCodeCopied(false);
    try {
      const resp = await fetch(resolveApiUrl('/api/youtube/auth/start'), { method: 'POST' });
      const data = (await resp.json().catch(() => ({}))) as {
        connected?: boolean;
        pending?: { verificationUrl: string; userCode: string; expiresAt: number };
        error?: string;
        detail?: string;
      };
      if (resp.ok && data.connected) {
        setYtAuthConnected(true);
        setYtAuthPending(null);
        return;
      }
      if (!resp.ok || !data.pending) {
        throw new Error(data.detail || data.error || 'Could not start Google device verification.');
      }
      setYtAuthPending(data.pending);
    } catch (err) {
      setYtAuthError(
        err instanceof Error ? err.message : 'Could not start Google device verification.'
      );
    } finally {
      setYtAuthLoading(false);
    }
  };

  const handleCopyAuthCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      // Clipboard blocked in some mobile contexts
    }
  };

  const handleFallbackFileUpload = (file: File | undefined) => {
    if (!file || isUploadingFallback || !onUploadAndClip) return;
    setUploadFallbackErr(null);
    setIsUploadingFallback(true);
    setUploadFallbackPct(0);

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', resolveApiUrl('/api/upload-video'));
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        setUploadFallbackPct(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = async () => {
      setIsUploadingFallback(false);
      try {
        const data = JSON.parse(xhr.responseText || '{}') as Partial<UploadedVideoFallback> & {
          error?: string;
          detail?: string;
          thumbnail?: string;
          duration?: string;
          channel_name?: string;
        };
        if (xhr.status < 200 || xhr.status >= 300 || !data.url) {
          throw new Error(data.error || data.detail || 'Upload failed. Please try an MP4 or MOV file.');
        }
        setUploadFallbackPct(100);
        await onUploadAndClip({
          url: data.url,
          title: data.title || file.name.replace(/\.[^.]+$/, ''),
          author: data.author || data.channel_name || 'Local Upload',
          duration_sec: data.duration_sec || 60,
          duration_str: data.duration_str || data.duration || '01:00',
          thumbnail_url: data.thumbnail_url || data.thumbnail || '',
          platform: data.platform || 'Local Upload',
        });
      } catch (err) {
        setUploadFallbackErr(err instanceof Error ? err.message : 'Upload failed.');
      }
    };
    xhr.onerror = () => {
      setIsUploadingFallback(false);
      setUploadFallbackErr('Network error while uploading video.');
    };
    xhr.send(formData);
  };

  const triggerDownload = (url: string, filename: string) => {
    const link = document.createElement('a');
    link.href = resolveMediaUrl(url);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleCopyText = async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFieldKey(key);
      window.setTimeout(() => {
        setCopiedFieldKey((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch {
      // Clipboard blocked in iframe
    }
  };

  const normalizeUpdatedClip = (raw: ClipItem): ClipItem => ({
    ...raw,
    score: raw.score ?? String(raw.virality_score ?? raw.viral_score ?? 0),
    startSec: raw.startSec ?? raw.start_time ?? 0,
    endSec: raw.endSec ?? raw.end_time ?? 0,
    description: raw.description || raw.score_reason || '',
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags : [],
    hook_reason: raw.hook_reason || raw.score_reason || '',
    thumbnailUrl: raw.thumbnailUrl ?? raw.thumbnail_url ?? null,
    videoUrl: raw.videoUrl ?? raw.video_url ?? null,
    downloadUrl: raw.downloadUrl ?? raw.download_url ?? null,
  });

  const openClipEditor = (clip: ClipItem) => {
    setEditingClip(clip);
    setEditTitleDraft(clip.title || '');
    setEditStartDraft(String(Number((clip.startSec ?? 0).toFixed(1))));
    setEditEndDraft(String(Number((clip.endSec ?? 30).toFixed(1))));
    setEditCaptionDraft(clip.transcript || '');
    setEditStyleDraft(clip.captionStyle || 'classic');
    setEditAspectDraft(clip.aspectRatio || aspectRatio || '9:16 Portrait');
    setEditError(null);
    setEditSuccessMsg(null);
  };

  const applyUpdatedClipToState = (updatedRaw: ClipItem, msg: string) => {
    const updated = normalizeUpdatedClip(updatedRaw);
    setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setClipProgress((prev) => ({ ...prev, [updated.id]: 100 }));
    setEditingClip(updated);
    setEditTitleDraft(updated.title || '');
    setEditStartDraft(String(Number((updated.startSec ?? 0).toFixed(1))));
    setEditEndDraft(String(Number((updated.endSec ?? 30).toFixed(1))));
    setEditCaptionDraft(updated.transcript || '');
    setEditStyleDraft(updated.captionStyle || 'classic');
    setEditAspectDraft(updated.aspectRatio || aspectRatio || '9:16 Portrait');
    setEditSuccessMsg(msg);
  };

  const handleRerenderClip = async () => {
    if (!editingClip || editBusyAction) return;
    const startVal = Number.parseFloat(editStartDraft);
    const endVal = Number.parseFloat(editEndDraft);
    if (!Number.isFinite(startVal) || !Number.isFinite(endVal) || endVal <= startVal + 0.8) {
      setEditError('End time must be at least 1 second after start time.');
      return;
    }
    setEditBusyAction('render');
    setEditError(null);
    setEditSuccessMsg(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/clips/${editingClip.id}/render`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitleDraft.trim() || editingClip.title,
          start_sec: startVal,
          end_sec: endVal,
          edited_caption_text: editCaptionDraft.trim(),
          caption_style: editStyleDraft,
          aspect_ratio: editAspectDraft,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as ClipItem & { detail?: string; error?: string };
      if (!resp.ok) {
        throw new Error(data.detail || data.error || 'Failed to re-render clip.');
      }
      applyUpdatedClipToState(data, 'Clip re-rendered with your edits.');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to re-render clip.');
    } finally {
      setEditBusyAction(null);
    }
  };

  const handleExtendClip = async (deltaStart: number, deltaEnd: number) => {
    if (!editingClip || editBusyAction) return;
    setEditBusyAction('extend');
    setEditError(null);
    setEditSuccessMsg(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/clips/${editingClip.id}/extend`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delta_start_sec: deltaStart,
          delta_end_sec: deltaEnd,
          snap_to_sentence: true,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as ClipItem & { detail?: string; error?: string };
      if (!resp.ok) {
        throw new Error(data.detail || data.error || 'Could not extend clip.');
      }
      applyUpdatedClipToState(
        data,
        deltaStart < 0 ? 'Extended start by ~10s and re-rendered.' : 'Extended end by ~10s and re-rendered.'
      );
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not extend clip.');
    } finally {
      setEditBusyAction(null);
    }
  };

  const handleTranslateClip = async () => {
    if (!editingClip || editBusyAction) return;
    setEditBusyAction('translate');
    setEditError(null);
    setEditSuccessMsg(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/clips/${editingClip.id}/translate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_language: translateLangDraft }),
      });
      const data = (await resp.json().catch(() => ({}))) as ClipItem & { detail?: string; error?: string };
      if (!resp.ok) {
        throw new Error(data.detail || data.error || 'Caption translation failed.');
      }
      applyUpdatedClipToState(data, `Captions translated to ${translateLangDraft} and burned in.`);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Caption translation failed.');
    } finally {
      setEditBusyAction(null);
    }
  };

  const handleRegenerateClip = async () => {
    if (!editingClip || editBusyAction) return;
    setEditBusyAction('regenerate');
    setEditError(null);
    setEditSuccessMsg(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/clips/${editingClip.id}/regenerate`), {
        method: 'POST',
      });
      const data = (await resp.json().catch(() => ({}))) as ClipItem & { detail?: string; error?: string };
      if (!resp.ok) {
        throw new Error(data.detail || data.error || 'Clip regeneration failed.');
      }
      applyUpdatedClipToState(data, 'Replaced with a fresh viral moment from the video.');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Clip regeneration failed.');
    } finally {
      setEditBusyAction(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f2f2f2]">
      <div
        className={`mx-auto max-w-[360px] pb-[130px] transition-[filter,opacity] duration-150 ${
          sidebarOpen ? 'pointer-events-none opacity-80 blur-[6px]' : ''
        }`}
      >
        <header className="sticky top-[env(safe-area-inset-top,0px)] z-10 flex h-[47px] items-center border-b border-[#1d1d1d] bg-[#0c0c0c] pr-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Toggle sidebar"
            className="ml-3 grid h-[27px] w-[27px] cursor-pointer place-items-center rounded-[8px] border border-[#343434] bg-[#161616] p-0 text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <svg
              className="h-[14px] w-[14px] fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 3v18" />
            </svg>
          </button>

          <span className="ml-3 w-[1px] self-stretch bg-[#222222]" aria-hidden="true" />

          <div className="ml-[13px] flex flex-1 items-center gap-[11px] whitespace-nowrap text-[13.5px] text-[#9d9d9d]">
            <span>Dashboard</span>
            <svg
              className="h-[10px] w-[10px] fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m9 5 7 7-7 7" />
            </svg>
            <span>Videos</span>
            <svg
              className="h-[10px] w-[10px] fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m9 5 7 7-7 7" />
            </svg>
            <b className="font-normal text-white">Clips</b>
          </div>

          <span className="flex h-[20px] items-center rounded-[8px] border border-[#3a3a3a] bg-[#1a1a1a] px-[6px] text-[12px] text-[#eeeeee]">
            Free
          </span>
        </header>

        <main className="flex flex-col">
          {/* .head */}
          {!showPreviewBanner && (
            <section className="relative order-1 m-0 h-[105px] border-b border-[#1a1a1a]">
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                className="absolute left-[23px] top-[14px] h-[14px] w-[14px] cursor-pointer border-0 bg-transparent p-0 text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <svg
                  className="h-[14px] w-[14px] fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>

              <div className="absolute left-[52.7px] top-[10px] w-[128px] overflow-hidden text-ellipsis whitespace-nowrap text-[16px] leading-[21px]">
                {liveTitle}
              </div>

              <button
                type="button"
                onClick={() =>
                  setModalInfo({
                    title: 'Share Clips (Pro)',
                    body: 'Upgrade to Pro to create public share links for your generated clips and collaborate with your team.',
                  })
                }
                className="absolute left-[191.7px] top-[7px] flex h-[37px] w-[152px] cursor-pointer items-center gap-[9px] rounded-[14px] border border-[#333333] bg-[#151515] pl-[15px] text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <svg
                  className="h-[11px] w-[11px] fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="4" y="10" width="16" height="11" rx="2" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                </svg>
                <span>Share Clips (Pro)</span>
              </button>

              <span className="absolute left-[52px] top-[48px] text-[13px] leading-[20px] text-[#9d9d9d]">
                Nov 16
              </span>
              <span className="absolute left-[92px] top-[53px] h-[11px] w-[1px] bg-[#2c2c2c]" />

              <span className="absolute left-[99.7px] top-[48px] flex h-[20px] items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-[#2a2a2a] bg-[#181818] pl-[6px] pr-[7px] text-[13px]">
                <span className="relative h-[9.5px] w-[13px] flex-none rounded-[2.5px] bg-[#ff0000]">
                  <span className="absolute left-[4.5px] top-[2px] h-0 w-0 border-b-[2.2px] border-l-[3.5px] border-t-[2.2px] border-b-transparent border-l-white border-t-transparent" />
                </span>
                {livePlatform}
              </span>

              <span className="absolute left-[178.7px] top-[48px] flex h-[20px] items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-[#2a2a2a] bg-[#181818] pl-[6px] pr-[7px] text-[13px]">
                <svg
                  className="h-3 w-3 fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M7 15v-3h3" />
                </svg>
                {shortAspect}
              </span>

              <span className="absolute left-[235.7px] top-[48px] flex h-[20px] items-center gap-[10px] whitespace-nowrap rounded-[10px] border border-[#2a2a2a] bg-[#181818] pl-[10px] pr-[7px] text-[13px]">
                🔥 {clipPreset}
              </span>

              <span className="absolute left-[52px] top-[77px] flex h-[20px] items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-[#8f6d12] bg-[#271d07] pl-[6px] pr-[7px] text-[13px] text-[#f0b100]">
                <svg
                  className="h-3 w-3 fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M8 3v4M16 3v4M3 10h18" />
                </svg>
                Expires Nov 17
              </span>

              <button
                type="button"
                onClick={() => setNoteOpen(true)}
                className="absolute left-[161px] top-[77px] flex h-[20px] cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[10px] border border-[#2a2a2a] bg-[#181818] pl-[6px] pr-[7px] text-[13px] text-[#a8a8a8] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <svg
                  className="h-3 w-3 fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M12 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7l-6 7z" />
                  <path d="M15 20v-5h6" />
                </svg>
                <span>{noteText.trim() ? 'Note added' : 'Add note'}</span>
              </button>
            </section>
          )}

          {/* .ban (visible while clips are rendering in dashboard) */}
          {showClipsDashboard && readyCount < clips.length && clips.length > 0 && (
            <section className="order-2 mx-4 mt-[17px] rounded-[20px] border border-[#4a3510] bg-[#1a1308] px-[17px] pb-[13px] pt-3">
              <div className="flex items-center gap-[14px]">
                <span className="h-[14px] w-[14px] flex-none animate-spin rounded-full border-2 border-[#e8820c] border-t-transparent motion-reduce:animate-none" />
                <div className="min-w-0 flex-1 pr-1.5">
                  <b className="block text-[15px] font-normal leading-5 text-[#f2f2f2]">
                    Rendering Shorts — {readyCount} of {clips.length} ready
                  </b>
                  <p className="m-0 mt-[3px] text-[12.5px] leading-4 text-[#a39c90]">
                    {currentStepText || 'Active speaker tracking & animated captions (FFmpeg)'}
                  </p>
                </div>
                <span className="flex-none text-[16px] tabular-nums text-[#e8820c]">{bannerPct}%</span>
              </div>
              <div className="mt-[10px] h-[6px] overflow-hidden rounded-[3px] bg-[#162049]">
                <i
                  className="block h-full rounded-[3px] bg-[#2447d8] transition-[width] duration-250"
                  style={{ width: `${bannerPct}%` }}
                />
              </div>
            </section>
          )}

          {/* .free card */}
          <section
            className={`order-3 mx-4 rounded-[20px] border border-[#262626] bg-[#131313] px-[13px] py-3 ${
              showPreviewBanner ? 'mt-[25px]' : showClipsDashboard ? 'mt-[9px]' : 'mt-[17px]'
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-[12px] bg-[#3a2909] text-[#f59e0b]">
                <svg
                  className="h-4 w-4 fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
                </svg>
              </span>
              <div>
                <b className="block text-[14.5px] font-normal leading-5">Free plan: slower queue</b>
                <p className="m-0 text-[13px] leading-4 text-[#a2a2a2]">
                  When we&apos;re busy, Free videos wait behind paid ones. Pro videos skip ahead.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setModalInfo({
                  title: 'Upgrade to Pro',
                  body: 'Skip the Free queue with priority AI processing, 400 min/month, watermark-free exports, and team sharing.',
                })
              }
              className="mt-[13px] flex h-[34px] w-full cursor-pointer items-center justify-center gap-[9px] rounded-[12px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[15px] text-[#e3e9ff] shadow-[0_0_12px_rgba(36,71,216,0.4)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <svg
                className="h-[15px] w-[15px] fill-none stroke-current stroke-[1.7]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M3 18h18M4 7l4 4 4-6 4 6 4-4-2 11H6z" />
              </svg>
              <span>Upgrade to Pro</span>
            </button>
          </section>

          {/* Live 5-Stage Pipeline Tracker card */}
          {!showClipsDashboard && (
            <section
              className={`mx-4 overflow-hidden rounded-[20px] border border-[#262626] bg-[#131313] px-[21px] pb-[18px] pt-5 text-center ${
                showPreviewBanner ? 'order-0 mt-[10px]' : 'order-4 mt-[17px]'
              }`}
            >
              {showPreviewBanner && (
                <div
                  className="relative -mx-[21px] -mt-5 mb-7 h-[170px]"
                  style={{
                    background: thumbnailUrl
                      ? `url("${resolveMediaUrl(thumbnailUrl)}") center/cover no-repeat, linear-gradient(135deg,#5a1a8a,#8a22a8 55%,#2a0850)`
                      : 'radial-gradient(circle at 80% 14%,#ff9cff 0,#b030d0 10%,transparent 34%),radial-gradient(circle at 32% 38%,#8a6a68 0,#5a4568 18%,transparent 36%),radial-gradient(circle at 66% 52%,#2c1226 0,#3a1a38 18%,transparent 34%),linear-gradient(135deg,#5a1a8a,#8a22a8 55%,#2a0850)',
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(rgba(0,0,0,0.25),rgba(19,19,19,0.15) 45%,#131313 100%)',
                    }}
                  />
                  <i className="absolute bottom-2 left-[9px] z-[1] h-[25px] w-[25px] rounded-full bg-[#0a7aa8] opacity-50" />
                </div>
              )}

              <h2 className="m-0 text-[16px] font-normal leading-6">
                {jobError
                  ? 'Could Not Process Video'
                  : activeStepIndex <= 1
                    ? 'Processing Your Video'
                    : 'Finding & Framing Viral Moments'}
              </h2>
              <p
                className={`m-0 mt-2 text-[13px] leading-5 ${
                  jobError ? 'text-[#fca5a5]' : 'text-[#a2a2a2]'
                }`}
              >
                {jobError
                  ? jobError
                  : `${currentStepText} — "${liveTitle}"`}
              </p>

              <ul className="m-0 mt-3 list-none pl-[8px] text-left">
                {STEP_NAMES.map((stepName, idx) => {
                  const isDone = idx < activeStepIndex;
                  const isAct = idx === activeStepIndex;
                  const isFailed = isAct && Boolean(jobError);
                  return (
                    <li
                      key={stepName}
                      className={`flex min-h-[34px] items-center gap-[11px] py-1 text-[12.5px] leading-[1.3] ${
                        isFailed
                          ? 'text-[#f87171]'
                          : isDone
                            ? 'text-white'
                            : isAct
                              ? 'text-[#4f80ff]'
                              : 'text-[#4a4a4a]'
                      }`}
                    >
                      <span
                        className={`grid h-5 w-5 flex-none place-items-center rounded-full border-[1.7px] ${
                          isFailed
                            ? 'border-[#dc2626] bg-[#3b1212] text-[#fca5a5]'
                            : isDone
                              ? 'border-[#2a4fd8] bg-[#2a4fd8] text-white'
                              : isAct
                                ? 'animate-spin border-[#25376e] border-l-[#2f5ae8] border-t-[#2f5ae8] motion-reduce:animate-none'
                                : 'border-[#2e2e2e] text-[#2e2e2e]'
                        }`}
                      >
                        {isFailed ? (
                          <X className="h-[11px] w-[11px]" />
                        ) : (
                          !isAct && (
                            <svg
                              className="h-[10px] w-[10px] fill-none stroke-current stroke-[1.7]"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path d="m4 12 5 5L20 6" />
                            </svg>
                          )
                        )}
                      </span>
                      <span>{stepName}</span>
                    </li>
                  );
                })}
              </ul>

              {jobError ? (
                <div className="mt-4 space-y-2.5 text-left">
                  {isYouTubeBotBlock && (
                    <div className="rounded-[14px] border border-[#243c7a] bg-[#0e172e] p-3">
                      <div className="flex items-center gap-2 text-[13px] font-medium text-[#dce5ff]">
                        <ShieldCheck className="h-4 w-4 shrink-0 text-[#4f80ff]" />
                        <span>Verify YouTube once to unblock</span>
                      </div>
                      <p className="m-0 mt-1 text-[12px] leading-[1.45] text-[#9fb3e6]">
                        Link your Google account via YouTube&apos;s official device sign-in to bypass cloud bot checks for all YouTube links.
                      </p>

                      {ytAuthConnected ? (
                        <div className="mt-2.5 flex items-center gap-2 rounded-[10px] border border-[#145a30] bg-[#0a2314] px-3 py-2 text-[12.5px] text-[#4ade80]">
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          <span>YouTube verified! Click Retry below to download with your linked account.</span>
                        </div>
                      ) : ytAuthPending ? (
                        <div className="mt-2.5 space-y-2">
                          <div className="flex items-center justify-between gap-2 rounded-[10px] border border-[#324f9c] bg-[#091124] px-3 py-2">
                            <div>
                              <div className="text-[10.5px] uppercase tracking-wider text-[#8fa4db]">
                                Verification Code
                              </div>
                              <div className="font-mono text-[17px] font-bold tracking-[0.14em] text-white">
                                {ytAuthPending.userCode}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleCopyAuthCode(ytAuthPending.userCode)}
                              className="inline-flex h-[30px] cursor-pointer items-center gap-1 rounded-[8px] border border-[#3a59ad] bg-[#172857] px-2.5 text-[12px] font-medium text-[#dce5ff] hover:bg-[#1e3570]"
                            >
                              {codeCopied ? (
                                <>
                                  <Check className="h-3.5 w-3.5 text-[#4ade80]" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>

                          <a
                            href={ytAuthPending.verificationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex h-[36px] w-full items-center justify-center gap-1.5 rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-[#e3e9ff] no-underline hover:brightness-110"
                          >
                            <span>Open google.com/device</span>
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>

                          <div className="flex items-center justify-center gap-1.5 text-[11.5px] text-[#9fb3e6]">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>Enter code above — clips auto-start once approved</span>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={ytAuthLoading}
                          onClick={() => void handleStartYouTubeDeviceAuth()}
                          className="mt-2.5 inline-flex h-[36px] w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-[#e3e9ff] hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
                        >
                          {ytAuthLoading ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>Getting verification code…</span>
                            </>
                          ) : (
                            <span>Verify YouTube Account (1-Tap)</span>
                          )}
                        </button>
                      )}

                      {ytAuthError && (
                        <p className="m-0 mt-2 text-[11.5px] text-[#fca5a5]">{ytAuthError}</p>
                      )}
                    </div>
                  )}

                  {onUploadAndClip && (
                    <div>
                      <input
                        ref={fallbackFileInputRef}
                        type="file"
                        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          handleFallbackFileUpload(f);
                        }}
                      />
                      <button
                        type="button"
                        disabled={isUploadingFallback}
                        onClick={() => fallbackFileInputRef.current?.click()}
                        className="inline-flex h-[36px] w-full cursor-pointer items-center justify-center gap-2 rounded-[12px] border border-[#2a5c3d] bg-[#0e2618] text-[13px] font-medium text-[#bbf7d0] hover:bg-[#133320] disabled:cursor-wait disabled:opacity-70"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        <span>
                          {isUploadingFallback
                            ? `Uploading MP4/MOV… ${uploadFallbackPct}%`
                            : 'Upload MP4 / MOV File Instead (Free)'}
                        </span>
                      </button>
                      {uploadFallbackErr && (
                        <p className="m-0 mt-1.5 text-center text-[11.5px] text-[#fca5a5]">
                          {uploadFallbackErr}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2">
                    {onRetry && (
                      <button
                        type="button"
                        disabled={isRetrying}
                        onClick={async () => {
                          setIsRetrying(true);
                          try {
                            await onRetry();
                          } finally {
                            setIsRetrying(false);
                          }
                        }}
                        className="h-[36px] flex-1 cursor-pointer rounded-[12px] border border-[#3a3a3a] bg-[#1e1e1e] text-[13px] font-medium text-[#e3e9ff] hover:bg-[#2a2a2a] disabled:cursor-wait disabled:opacity-70"
                      >
                        {isRetrying ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onBack}
                      className="h-[36px] flex-1 cursor-pointer rounded-[12px] border border-[#333333] bg-[#151515] text-[13px] font-medium text-[#d4d4d4] hover:bg-[#222222]"
                    >
                      Back to Configure
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-[11px] h-[6px] overflow-hidden rounded-[3px] bg-[#17234f]">
                    <i
                      className="block h-full rounded-[3px] bg-[#2447d8] transition-[width] duration-250"
                      style={{ width: `${roundedProgress}%` }}
                    />
                  </div>

                  <div className="mt-[6px] text-[13.5px] leading-5 tabular-nums text-[#a2a2a2]">
                    Step {Math.min(activeStepIndex + 1, STEP_NAMES.length)} of {STEP_NAMES.length} ·{' '}
                    {roundedProgress}%
                  </div>

                  {jobLogs.length > 0 && (
                    <div className="mt-2.5 rounded-[10px] border border-[#232323] bg-[#0e0e0e] px-2.5 py-2 text-left text-[11px] leading-[1.45] text-[#8f9ab0]">
                      {jobLogs.slice(-2).map((line, i) => (
                        <div key={i} className="truncate">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-[13px] text-[12px] leading-4 text-[#7a7a7a]">
                    Real-time backend sync active — clips appear automatically when ready.
                  </div>
                </>
              )}
            </section>
          )}

          {/* .vt toolbar + ZIP export + view toggle */}
          {showClipsDashboard && (
            <div className="order-5 mx-4 mt-[9px] flex items-center justify-between gap-2">
              {jobId && readyCount > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    triggerDownload(
                      resolveApiUrl(`/api/jobs/${encodeURIComponent(jobId)}/download-zip`),
                      `scalereach_${jobId}_clips.zip`
                    )
                  }
                  className="inline-flex h-[31px] cursor-pointer items-center gap-1.5 rounded-[12px] border border-[#2a4aa0] bg-[#13224a] px-3 text-[12.5px] font-medium text-[#dce5ff] hover:bg-[#1a3066] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download All (ZIP)</span>
                </button>
              ) : (
                <span />
              )}

              <div className="flex h-[31px] w-[75px] rounded-[14px] border border-[#333333] bg-[#141414] p-[2px]">
                <button
                  type="button"
                  aria-label="List view"
                  onClick={() => setViewMode('list')}
                  className={`grid flex-1 cursor-pointer place-items-center rounded-[12px] border-0 p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                    viewMode === 'list' ? 'bg-[#050505] text-white' : 'bg-transparent text-[#aaaaaa]'
                  }`}
                >
                  <svg
                    className="h-[15px] w-[15px] fill-none stroke-current stroke-[1.7]"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="4" y="3" width="16" height="7" rx="3" />
                    <rect x="4" y="14" width="16" height="7" rx="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Grid view"
                  onClick={() => setViewMode('grid')}
                  className={`grid flex-1 cursor-pointer place-items-center rounded-[12px] border-0 p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                    viewMode === 'grid' ? 'bg-[#050505] text-white' : 'bg-transparent text-[#aaaaaa]'
                  }`}
                >
                  <svg
                    className="h-[15px] w-[15px] fill-none stroke-current stroke-[1.7]"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="4" y="4" width="6" height="6" rx="1.5" />
                    <rect x="14" y="4" width="6" height="6" rx="1.5" />
                    <rect x="4" y="14" width="6" height="6" rx="1.5" />
                    <rect x="14" y="14" width="6" height="6" rx="1.5" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Results Dashboard (.clips) */}
          {showClipsDashboard && (
            <section
              className={`order-6 mx-4 mt-[17px] ${
                viewMode === 'grid' ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-6'
              }`}
            >
              {clips.map((clip) => {
                const pct = clipProgress[clip.id] ?? 100;
                const isDone = pct >= 100;
                const isTranscriptOpen = Boolean(openTranscripts[clip.id]);
                const isFav = Boolean(favorites[clip.id]);

                const isScoreOpen = Boolean(openScoreBreakdowns[clip.id]);
                const clipThumb = resolveMediaUrl(clip.thumbnailUrl || thumbnailUrl || '');
                const clipVideoSrc = resolveMediaUrl(clip.videoUrl);
                const clipDownloadSrc = resolveApiUrl(
                  clip.downloadUrl || (clip.videoUrl ?? '')
                );
                const clipAspectLabel = (clip.aspectRatio || aspectRatio || '9:16').split(' ')[0];
                const timestampRange = `${formatTimestamp(clip.startSec)} – ${formatTimestamp(
                  clip.endSec
                )}`;
                const hashtagsStr = (clip.hashtags || []).join(' ');

                return (
                  <article
                    key={clip.id}
                    className="overflow-hidden rounded-[20px] border border-[#262626] bg-[#131313]"
                  >
                    <div className="flex min-h-[50px] items-center justify-between gap-2 border-b border-[#242424] bg-[#171717] px-[14px] py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-white">
                          <u className="text-[#9a9a9a] no-underline">{clip.tag}</u> {clip.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums text-[#8e8e8e]">
                          <span>{timestampRange}</span>
                          {clip.duration && <span>· {clip.duration}</span>}
                          <span>· {clipAspectLabel}</span>
                        </div>
                      </div>
                      <div className="flex flex-none items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="Copy title"
                          title="Copy title"
                          onClick={() => void handleCopyText(`title-${clip.id}`, clip.title)}
                          className="grid h-[24px] w-[24px] cursor-pointer place-items-center rounded-[7px] border border-[#2d2d2d] bg-[#1d1d1d] text-[#a6a6a6] hover:text-white"
                        >
                          {copiedFieldKey === `title-${clip.id}` ? (
                            <Check className="h-3 w-3 text-[#4ade80]" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenScoreBreakdowns((prev) => ({
                              ...prev,
                              [clip.id]: !prev[clip.id],
                            }))
                          }
                          title="View virality score breakdown"
                          className={`flex h-[24px] w-[58px] flex-none cursor-pointer items-center justify-center gap-1 rounded-[9px] border text-[13.5px] font-medium tabular-nums ${
                            clip.amberScore
                              ? 'border-[#8a5a10] bg-[#2a1d08] text-[#f59e0b]'
                              : 'border-[#0f6a45] bg-[#0b2a1f] text-[#22c58b]'
                          }`}
                        >
                          🔥 {clip.score}
                        </button>
                      </div>
                    </div>

                    <div
                      className={`relative mx-auto mt-3 overflow-hidden rounded-[20px] bg-[#0a0a0a] text-center ${
                        viewMode === 'grid' ? 'h-[210px] w-full' : 'h-[462px] w-[260px]'
                      }`}
                    >
                      {!isDone ? (
                        <>
                          <div className="absolute inset-0">
                            <b className="absolute left-0 right-0 top-[193px] text-[28px] font-bold leading-9 tabular-nums">
                              {Math.floor(Math.min(pct, 100))}%
                            </b>
                            <p className="absolute left-0 right-0 top-[233px] m-0 text-[15px] leading-5 text-[#a8a8a8]">
                              Generating clip…
                            </p>
                            <em className="absolute left-0 right-0 top-[261px] text-[13px] not-italic leading-[18px] text-[#6a6a6a]">
                              {statusHint}
                            </em>
                          </div>
                          <div className="absolute bottom-[1px] left-[3px] right-[3px] h-[3px] rounded-[2px] bg-gradient-to-r from-[#666666] to-[#444444]">
                            <i
                              className="block h-full rounded-[2px] bg-[#3b5bdb] transition-[width] duration-200"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                        </>
                      ) : clipVideoSrc && viewMode === 'list' ? (
                        <div className="relative h-full w-full bg-black">
                          <video
                            src={clipVideoSrc}
                            poster={clipThumb || undefined}
                            controls
                            playsInline
                            preload="metadata"
                            className="h-full w-full object-contain bg-black"
                          />
                          <button
                            type="button"
                            aria-label={`Expand ${clip.tag} clip`}
                            title="Open in theater modal"
                            onClick={() =>
                              setModalInfo({
                                title: `${clip.tag} ${clip.title}`,
                                body: `${clipAspectLabel} · ${timestampRange} · Score ${clip.score}/100${
                                  clip.hook_reason || clip.score_reason
                                    ? ` — ${clip.hook_reason || clip.score_reason}`
                                    : ''
                                }`,
                                videoUrl: clipVideoSrc,
                                downloadUrl: clipDownloadSrc,
                              })
                            }
                            className="absolute right-2.5 top-2.5 grid h-7 w-7 cursor-pointer place-items-center rounded-lg bg-black/70 text-white hover:bg-black/90"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Play ${clip.tag} clip`}
                          onClick={() =>
                            setModalInfo({
                              title: `${clip.tag} ${clip.title}`,
                              body: `${clipAspectLabel} · ${timestampRange} · Score ${clip.score}/100${
                                clip.hook_reason || clip.score_reason
                                  ? ` — ${clip.hook_reason || clip.score_reason}`
                                  : ''
                              }`,
                              videoUrl: clipVideoSrc || null,
                              downloadUrl: clipDownloadSrc || null,
                            })
                          }
                          className="absolute inset-0 cursor-pointer border-0 bg-[#0d0d0d] p-0"
                          style={
                            clipThumb
                              ? { background: `url("${clipThumb}") center/cover no-repeat` }
                              : undefined
                          }
                        >
                          <span className="absolute left-1/2 top-1/2 -ml-6 -mt-6 grid h-12 w-12 place-items-center rounded-full bg-black/65">
                            <span className="ml-1 h-0 w-0 border-b-[9px] border-l-[14px] border-t-[9px] border-b-transparent border-l-white border-t-transparent" />
                          </span>
                          {clip.duration && (
                            <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/75 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
                              {clip.duration}
                            </span>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Virality score reason & sub-score breakdown */}
                    {(clip.score_reason ||
                      clip.hook_reason ||
                      (clip.sub_scores && Object.keys(clip.sub_scores).length > 0)) && (
                      <div className="mx-[13px] mt-3 rounded-[12px] border border-[#242424] bg-[#101010] px-3 py-2 text-left">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenScoreBreakdowns((prev) => ({
                              ...prev,
                              [clip.id]: !prev[clip.id],
                            }))
                          }
                          className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent p-0 text-left text-[12px] text-[#c7c7c7] hover:text-white"
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            <BarChart3 className="h-3.5 w-3.5 text-[#3b6ef0]" />
                            <span>Viral Score Breakdown ({clip.score}/100)</span>
                          </span>
                          <span className="text-[11px] text-[#8d8d8d]">
                            {isScoreOpen ? 'Hide' : 'Details'}
                          </span>
                        </button>
                        {(clip.hook_reason || clip.score_reason) && (
                          <p className="m-0 mt-1.5 text-[12px] leading-[1.4] text-[#a6a6a6]">
                            {clip.hook_reason || clip.score_reason}
                          </p>
                        )}
                        {isScoreOpen && clip.sub_scores && (
                          <div className="mt-2.5 space-y-1.5 border-t border-[#222222] pt-2">
                            {SUB_SCORE_LABELS.map(({ key, label }) => {
                              const rawVal = clip.sub_scores?.[key];
                              if (typeof rawVal !== 'number') return null;
                              const clamped = Math.max(0, Math.min(100, Math.round(rawVal)));
                              return (
                                <div key={key} className="flex items-center gap-2 text-[11px]">
                                  <span className="w-[82px] flex-none text-[#9d9d9d]">{label}</span>
                                  <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-[#222222]">
                                    <div
                                      className="h-full rounded-full bg-[#3b6ef0]"
                                      style={{ width: `${clamped}%` }}
                                    />
                                  </div>
                                  <span className="w-7 flex-none text-right tabular-nums text-[#e5e5e5]">
                                    {clamped}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Auto-generated Viral Description & Hashtags with copy buttons */}
                    {viewMode === 'list' && (clip.description || hashtagsStr) && (
                      <div className="mx-[13px] mt-2.5 rounded-[12px] border border-[#242424] bg-[#101010] px-3 py-2 text-left">
                        {clip.description && (
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-medium uppercase tracking-wide text-[#8c8c8c]">
                                Viral Description
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleCopyText(`desc-${clip.id}`, clip.description || '')
                                }
                                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#191919] px-2 py-0.5 text-[10.5px] text-[#c7c7c7] hover:text-white"
                              >
                                {copiedFieldKey === `desc-${clip.id}` ? (
                                  <>
                                    <Check className="h-3 w-3 text-[#4ade80]" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" />
                                    <span>Copy</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <p className="m-0 mt-1 text-[12px] leading-[1.45] text-[#c2c2c2]">
                              {clip.description}
                            </p>
                          </div>
                        )}

                        {hashtagsStr && (
                          <div className={clip.description ? 'mt-2 border-t border-[#1f1f1f] pt-2' : ''}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-[#8c8c8c]">
                                <Hash className="h-3 w-3 text-[#3b6ef0]" />
                                <span>Hashtags</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCopyText(`tags-${clip.id}`, hashtagsStr)}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#191919] px-2 py-0.5 text-[10.5px] text-[#c7c7c7] hover:text-white"
                              >
                                {copiedFieldKey === `tags-${clip.id}` ? (
                                  <>
                                    <Check className="h-3 w-3 text-[#4ade80]" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" />
                                    <span>Copy</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(clip.hashtags || []).map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-md border border-[#24325c] bg-[#111933] px-1.5 py-0.5 text-[11px] text-[#9eb7ff]"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        setOpenTranscripts((prev) => ({
                          ...prev,
                          [clip.id]: !prev[clip.id],
                        }))
                      }
                      className="mx-[13px] mt-2.5 flex h-[33px] w-[calc(100%-26px)] cursor-pointer items-center justify-center gap-[9px] rounded-[12px] border border-[#272727] bg-[#151515] text-[13.5px] text-[#b0b0b0] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                    >
                      <svg
                        className="h-4 w-4 fill-none stroke-current stroke-[1.7]"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <rect x="3" y="4" width="18" height="16" rx="3" />
                        <path d="M7 12h3M7 16h6" />
                      </svg>
                      <span>{isTranscriptOpen ? 'Hide transcript & hook' : 'Transcript & hook preview'}</span>
                      <svg
                        className={`h-4 w-4 fill-none stroke-current stroke-[1.7] transition-transform ${
                          isTranscriptOpen ? 'rotate-180' : ''
                        }`}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>

                    {isTranscriptOpen && (
                      <div className="mx-[13px] mt-2 rounded-[12px] border border-[#242424] bg-[#101010] p-3 text-left text-[12px] leading-[1.5] text-[#c2c2c2]">
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-[#8f9ab0]">
                          <span className="font-mono tabular-nums">Timestamps: {timestampRange}</span>
                          <button
                            type="button"
                            onClick={() => openClipEditor(clip)}
                            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-[#4f80ff] hover:underline"
                          >
                            Edit transcript
                          </button>
                        </div>
                        {clip.hookTitle && (
                          <div className="mb-1.5 rounded-md border border-[#263259] bg-[#111936] px-2 py-1 text-[11.5px] text-[#dbe5ff]">
                            <strong className="font-semibold">Hook:</strong> {clip.hookTitle}
                          </div>
                        )}
                        <p className="m-0">{clip.transcript}</p>
                      </div>
                    )}

                    <div className="mx-[13px] mt-[16px] h-[1px] bg-[#232323]" />

                    <div className="mx-[13px] mb-[14px] mt-[12px] flex h-9 items-center">
                      <button
                        type="button"
                        aria-label="Download"
                        onClick={() => {
                          if (isDone && clipDownloadSrc) {
                            triggerDownload(clipDownloadSrc, `scalereach_clip_${clip.id}.mp4`);
                          } else {
                            setModalInfo({
                              title: `Download ${clip.tag}`,
                              body: isDone
                                ? `Your ${clipAspectLabel} MP4 clip "${clip.title}" is ready to save.`
                                : `Clip is currently at ${Math.floor(pct)}% — download unlocks as soon as rendering hits 100%.`,
                            });
                          }
                        }}
                        className="mr-2 grid h-9 w-9 cursor-pointer place-items-center rounded-[12px] border border-[#1c3a8c] bg-[#1c3a8c] p-0 text-[#dbe5ff] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                      >
                        <svg
                          className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.7]"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        aria-label="Edit"
                        onClick={() => openClipEditor(clip)}
                        className="grid h-9 w-9 cursor-pointer place-items-center rounded-[12px] border border-[#2c2c2c] bg-transparent p-0 text-[#bbbbbb] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                      >
                        <svg
                          className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.7]"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M4 20h16M15 4l5 5-11 11H4v-5z" />
                        </svg>
                      </button>

                      <div className="ml-auto flex">
                        <button
                          type="button"
                          aria-label="Favorite"
                          onClick={() => {
                            const nextFav = !favorites[clip.id];
                            setFavorites((prev) => ({ ...prev, [clip.id]: nextFav }));
                            if (jobId) {
                              void fetch(
                                resolveApiUrl(`/api/jobs/${encodeURIComponent(jobId)}/clips/${clip.id}`),
                                {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ favorite: nextFav }),
                                }
                              );
                            }
                          }}
                          className={`grid h-9 w-9 cursor-pointer place-items-center rounded-[12px] border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                            isFav ? 'text-[#f43f5e]' : 'text-[#bbbbbb] hover:text-white'
                          }`}
                        >
                          <svg
                            className={`h-[18px] w-[18px] stroke-current stroke-[1.7] ${
                              isFav ? 'fill-current' : 'fill-none'
                            }`}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z" />
                          </svg>
                        </button>

                        <button
                          type="button"
                          aria-label="Share"
                          onClick={() => {
                            if (clipVideoSrc && navigator.clipboard) {
                              const absolute = /^https?:\/\//i.test(clipVideoSrc)
                                ? clipVideoSrc
                                : `${window.location.origin}${clipVideoSrc}`;
                              void navigator.clipboard.writeText(absolute);
                            }
                            setModalInfo({
                              title: `Share ${clip.tag}`,
                              body: `Clip link copied for "${clip.title}".`,
                            });
                          }}
                          className="grid h-9 w-9 cursor-pointer place-items-center rounded-[12px] border-0 bg-transparent p-0 text-[#bbbbbb] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                        >
                          <svg
                            className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.7]"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="M5 12v7h14v-7M12 15V3M8 7l4-4 4 4" />
                          </svg>
                        </button>

                        <button
                          type="button"
                          aria-label="Delete"
                          onClick={() => {
                            setClips((prev) => prev.filter((c) => c.id !== clip.id));
                            if (jobId) {
                              void fetch(
                                resolveApiUrl(`/api/jobs/${encodeURIComponent(jobId)}/clips/${clip.id}`),
                                {
                                  method: 'DELETE',
                                }
                              );
                            }
                          }}
                          className="grid h-9 w-9 cursor-pointer place-items-center rounded-[12px] border-0 bg-transparent p-0 text-[#bbbbbb] hover:text-[#f87171] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                        >
                          <svg
                            className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.7]"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}

              {clips.length === 0 && (
                <div className="rounded-[20px] border border-[#262626] bg-[#131313] p-6 text-center">
                  <p className="m-0 text-[14px] text-[#9d9d9d]">No clips available for this job.</p>
                  <button
                    type="button"
                    onClick={onBack}
                    className="mt-3 h-9 cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-[#2547b5] px-4 text-[13px] text-white"
                  >
                    Back to Configure
                  </button>
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      <ChatSupport
        isAuthenticated={true}
        onRequireAuth={() => {}}
        buttonClassName="fixed bottom-[calc(19px+env(safe-area-inset-bottom,0px))] right-[max(24px,calc(50%-156px))] z-40 grid h-[54px] w-[54px] cursor-pointer place-items-center rounded-full border-0 bg-[#1a6cf5] shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
      />

      <ScalereachSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSignOut={onSignOut}
      />

      {modalInfo && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={modalInfo.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setModalInfo(null)}
        >
          <div
            className="w-full max-w-[330px] rounded-2xl border border-[#262626] bg-[#131313] p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-[#22c58b]">
                <CheckCircle2 className="h-5 w-5" />
                <h3 className="text-[15px] font-semibold text-white">{modalInfo.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalInfo(null)}
                aria-label="Close modal"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9d9d9d] hover:bg-[#1e1e1e] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2.5 text-[12.5px] leading-[1.5] text-[#a2a2a2]">{modalInfo.body}</p>
            {modalInfo.videoUrl && (
              <video
                src={modalInfo.videoUrl}
                controls
                autoPlay
                playsInline
                className="mt-3 max-h-[360px] w-full rounded-xl bg-black"
              />
            )}
            <div className="mt-4 flex gap-2">
              {modalInfo.downloadUrl && (
                <button
                  type="button"
                  onClick={() => triggerDownload(modalInfo.downloadUrl!, 'scalereach_clip.mp4')}
                  className="h-9 flex-1 cursor-pointer rounded-[10px] border border-[#1c3a8c] bg-[#1c3a8c] text-[13px] font-medium text-white hover:brightness-110"
                >
                  Download MP4
                </button>
              )}
              <button
                type="button"
                onClick={() => setModalInfo(null)}
                className="h-9 flex-1 cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-white hover:brightness-110"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {editingClip && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit & re-render clip"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-[2px]"
          onClick={() => {
            if (!editBusyAction) setEditingClip(null);
          }}
        >
          <div
            className="max-h-[88vh] w-full max-w-[344px] overflow-y-auto rounded-2xl border border-[#262626] bg-[#131313] p-4 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-[#4f80ff]" />
                <h3 className="text-[14.5px] font-semibold text-white">
                  Edit &amp; Re-render {editingClip.tag}
                </h3>
              </div>
              <button
                type="button"
                disabled={Boolean(editBusyAction)}
                onClick={() => setEditingClip(null)}
                aria-label="Close edit dialog"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9d9d9d] hover:bg-[#1e1e1e] hover:text-white disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {editError && (
              <div className="mt-2.5 rounded-[10px] border border-[#5f1e1e] bg-[#2a1010] px-3 py-2 text-[12px] text-[#fca5a5]">
                {editError}
              </div>
            )}
            {editSuccessMsg && (
              <div className="mt-2.5 rounded-[10px] border border-[#145a30] bg-[#0a2314] px-3 py-2 text-[12px] text-[#4ade80]">
                {editSuccessMsg}
              </div>
            )}

            <label className="mt-3 block text-[11.5px] text-[#9d9d9d]">Clip Title</label>
            <input
              type="text"
              value={editTitleDraft}
              onChange={(e) => setEditTitleDraft(e.target.value)}
              disabled={Boolean(editBusyAction)}
              className="mt-1 h-9 w-full rounded-[10px] border border-[#333333] bg-[#181818] px-3 text-[13px] text-white focus:border-[#4a6ee3] focus:outline-none"
            />

            {/* Trim Handles & +/-10s Extend */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11.5px] text-[#9d9d9d]">Start (sec)</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={editStartDraft}
                  onChange={(e) => setEditStartDraft(e.target.value)}
                  disabled={Boolean(editBusyAction)}
                  className="mt-1 h-9 w-full rounded-[10px] border border-[#333333] bg-[#181818] px-2.5 text-[13px] tabular-nums text-white focus:border-[#4a6ee3] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11.5px] text-[#9d9d9d]">End (sec)</label>
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={editEndDraft}
                  onChange={(e) => setEditEndDraft(e.target.value)}
                  disabled={Boolean(editBusyAction)}
                  className="mt-1 h-9 w-full rounded-[10px] border border-[#333333] bg-[#181818] px-2.5 text-[13px] tabular-nums text-white focus:border-[#4a6ee3] focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={Boolean(editBusyAction)}
                onClick={() => void handleExtendClip(-10, 0)}
                className="h-8 flex-1 cursor-pointer rounded-[9px] border border-[#2f2f2f] bg-[#1a1a1a] text-[12px] font-medium text-[#d8d8d8] hover:bg-[#242424] disabled:opacity-50"
              >
                {editBusyAction === 'extend' ? 'Extending…' : 'Extend -10s Start'}
              </button>
              <button
                type="button"
                disabled={Boolean(editBusyAction)}
                onClick={() => void handleExtendClip(0, 10)}
                className="h-8 flex-1 cursor-pointer rounded-[9px] border border-[#2f2f2f] bg-[#1a1a1a] text-[12px] font-medium text-[#d8d8d8] hover:bg-[#242424] disabled:opacity-50"
              >
                {editBusyAction === 'extend' ? 'Extending…' : 'Extend +10s End'}
              </button>
            </div>

            {/* Caption Style & Aspect Ratio */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11.5px] text-[#9d9d9d]">Caption Style</label>
                <select
                  value={editStyleDraft}
                  onChange={(e) => setEditStyleDraft(e.target.value)}
                  disabled={Boolean(editBusyAction)}
                  className="mt-1 h-9 w-full rounded-[10px] border border-[#333333] bg-[#181818] px-2 text-[12.5px] text-white focus:border-[#4a6ee3] focus:outline-none"
                >
                  {CAPTION_STYLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11.5px] text-[#9d9d9d]">Aspect Ratio</label>
                <select
                  value={editAspectDraft}
                  onChange={(e) => setEditAspectDraft(e.target.value)}
                  disabled={Boolean(editBusyAction)}
                  className="mt-1 h-9 w-full rounded-[10px] border border-[#333333] bg-[#181818] px-2 text-[12.5px] text-white focus:border-[#4a6ee3] focus:outline-none"
                >
                  {ASPECT_RATIO_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Editable Captions */}
            <label className="mt-3 block text-[11.5px] text-[#9d9d9d]">Caption Text</label>
            <textarea
              rows={3}
              value={editCaptionDraft}
              onChange={(e) => setEditCaptionDraft(e.target.value)}
              disabled={Boolean(editBusyAction)}
              placeholder="Edit spoken captions to re-burn into this clip..."
              className="mt-1 w-full rounded-[10px] border border-[#333333] bg-[#181818] p-2.5 text-[12.5px] leading-[1.45] text-white focus:border-[#4a6ee3] focus:outline-none"
            />

            <button
              type="button"
              disabled={Boolean(editBusyAction)}
              onClick={() => void handleRerenderClip()}
              className="mt-2.5 inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
            >
              {editBusyAction === 'render' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{editBusyAction === 'render' ? 'Re-rendering Clip…' : 'Save & Re-render Clip'}</span>
            </button>

            {/* Caption Translation */}
            <div className="mt-3 rounded-[12px] border border-[#242424] bg-[#101010] p-2.5">
              <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#d4d4d4]">
                <Languages className="h-3.5 w-3.5 text-[#3b6ef0]" />
                <span>Translate &amp; Re-burn Captions</span>
              </div>
              <div className="mt-2 flex gap-2">
                <select
                  value={translateLangDraft}
                  onChange={(e) => setTranslateLangDraft(e.target.value)}
                  disabled={Boolean(editBusyAction)}
                  className="h-8 flex-1 rounded-[8px] border border-[#333333] bg-[#181818] px-2 text-[12px] text-white focus:border-[#4a6ee3] focus:outline-none"
                >
                  {TRANSLATE_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={Boolean(editBusyAction)}
                  onClick={() => void handleTranslateClip()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] border border-[#2e4fa8] bg-[#162757] px-3 text-[12px] font-medium text-[#dce5ff] hover:bg-[#1e3575] disabled:opacity-50"
                >
                  {editBusyAction === 'translate' && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>Translate</span>
                </button>
              </div>
            </div>

            {/* Regenerate Clip */}
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                disabled={Boolean(editBusyAction)}
                onClick={() => void handleRegenerateClip()}
                className="inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-[#333333] bg-[#181818] text-[12.5px] font-medium text-[#e0e0e0] hover:bg-[#232323] disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${editBusyAction === 'regenerate' ? 'animate-spin' : ''}`}
                />
                <span>
                  {editBusyAction === 'regenerate' ? 'Regenerating…' : 'Regenerate This Clip'}
                </span>
              </button>
              <button
                type="button"
                disabled={Boolean(editBusyAction)}
                onClick={() => setEditingClip(null)}
                className="h-9 cursor-pointer rounded-[10px] border border-[#2c2c2c] bg-[#151515] px-3 text-[12.5px] text-[#bdbdbd] hover:text-white disabled:opacity-50"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {noteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add note"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setNoteOpen(false)}
        >
          <div
            className="w-full max-w-[330px] rounded-2xl border border-[#262626] bg-[#131313] p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-white">Add project note</h3>
              <button
                type="button"
                onClick={() => setNoteOpen(false)}
                aria-label="Close note dialog"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9d9d9d] hover:bg-[#1e1e1e] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              rows={3}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Write a note for these clips..."
              className="mt-3 w-full rounded-[10px] border border-[#333333] bg-[#181818] p-3 text-[13px] text-white placeholder-[#777777] focus:border-[#4a6ee3] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                if (jobId) {
                  void fetch(resolveApiUrl(`/api/jobs/${encodeURIComponent(jobId)}/note`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ note: noteText }),
                  });
                }
                setNoteOpen(false);
              }}
              className="mt-3 h-9 w-full cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-[#2547b5] text-[13px] font-medium text-white"
            >
              Save note
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
