import React, { useState, useRef, useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, Play, Copy, Check, Loader2, ExternalLink } from 'lucide-react';
import type { AuthUser } from './LoginPage';
import { ChatSupport } from './ChatSupport';
import { ScalereachSidebar } from './ScalereachSidebar';
import { ConfigurePage, type InspectedVideoMeta } from './ConfigurePage';
import { fetchVideoValidation, resolveApiUrl, toInspectedVideoMeta } from '../lib/videoBackend';

interface DemoVideo {
  id: string;
  title: string;
  date: string;
  background: string;
  badge?: string;
  sampleUrl: string;
  renderOverlay: () => React.ReactNode;
}

const VERIFIED_DEMO_URLS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
];

const DEMO_VIDEOS: DemoVideo[] = [
  {
    id: 'sam-altman',
    title: 'Sam Altman On AI Revo…',
    date: 'Nov 5',
    background: 'linear-gradient(90deg,#8a6a58,#f1f1f1 28%,#f1f1f1 66%,#6e5646)',
    badge: '4M+ VIEWS',
    sampleUrl: VERIFIED_DEMO_URLS[0],
    renderOverlay: () => (
      <span className="text-[19px] italic leading-[1.05] text-[#e0202c]">
        Sam
        <br />
        Altman
      </span>
    ),
  },
  {
    id: 'stuck-between',
    title: 'Stuck Between R…',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#c9a24a,#6e7468 40%,#4a4a44 65%,#8a3a2a)',
    sampleUrl: VERIFIED_DEMO_URLS[1],
    renderOverlay: () => null,
  },
  {
    id: 'wwe',
    title: 'How I Fought In WWE …',
    date: 'Oct 27',
    background: 'linear-gradient(100deg,#0e1f4a,#1d3a7a 50%,#b87a5a)',
    sampleUrl: VERIFIED_DEMO_URLS[2],
    renderOverlay: () => (
      <span className="w-full text-left text-[14px] italic">
        HOW I
        <br />
        FOUGHT IN
        <br />
        <small className="text-[9px]">WRESTLEMANIA</small>
      </span>
    ),
  },
  {
    id: 'iphone-duo',
    title: 'iPhone Duo Review: Firs…',
    date: 'Oct 27',
    background: 'linear-gradient(#2f66c8,#1f4fa8)',
    sampleUrl: VERIFIED_DEMO_URLS[3],
    renderOverlay: () => null,
  },
  {
    id: 'khan-sir',
    title: 'Khan Sir Podcast: India …',
    date: 'Oct 17',
    background: 'linear-gradient(90deg,#2a1a1a,#7a1a1a 50%,#1a1a22)',
    badge: '35M+ VIEWS',
    sampleUrl: VERIFIED_DEMO_URLS[4],
    renderOverlay: () => (
      <span className="text-[15px] leading-[1.05]">
        KHAN SIR ON
        <br />
        PAKISTAN
      </span>
    ),
  },
  {
    id: 'pay-700',
    title: 'People Pay $700 a Mon…',
    date: 'Oct 27',
    background: 'linear-gradient(#b9c4cc,#8a8a7a 50%,#c9a679)',
    sampleUrl: VERIFIED_DEMO_URLS[5],
    renderOverlay: () => null,
  },
  {
    id: 'eat-grocery',
    title: 'Eat Everything In A Groc…',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#7a6a52,#b9694a 55%,#3a6a3a)',
    sampleUrl: VERIFIED_DEMO_URLS[1],
    renderOverlay: () => (
      <span className="absolute right-[4px] top-[6px] text-[11px]">DAY 001</span>
    ),
  },
  {
    id: 'learning-ai',
    title: 'I Tried Learning AI Vide…',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#6a8a9a,#2a6a6a 50%,#3a8a5a)',
    sampleUrl: VERIFIED_DEMO_URLS[2],
    renderOverlay: () => (
      <span className="absolute left-[12px] top-[6px] font-[cursive] text-[12px] normal-case">
        so it begins
      </span>
    ),
  },
  {
    id: 'linux',
    title: 'How to Switch to Linux',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#e8781a,#e8781a 40%,#6a8ab0 60%,#4a5a70)',
    sampleUrl: VERIFIED_DEMO_URLS[3],
    renderOverlay: () => null,
  },
  {
    id: 'afford-child',
    title: 'Can You Afford a Child?',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#c9a46a,#e0c9a0 50%,#8a6a4a)',
    sampleUrl: VERIFIED_DEMO_URLS[4],
    renderOverlay: () => (
      <span className="text-[13px] leading-[1] text-white [text-shadow:0_1px_2px_#000]">
        CAN YOU AFFORD
        <br />A CHILD?
      </span>
    ),
  },
  {
    id: 'extreme',
    title: "It's Extreme, But I'll NEV…",
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#2a4aa8,#3a60c8 55%,#2a4a98)',
    sampleUrl: VERIFIED_DEMO_URLS[5],
    renderOverlay: () => null,
  },
  {
    id: 'no-device',
    title: 'No device could prove E…',
    date: 'Oct 27',
    background: 'linear-gradient(120deg,#0a1a4a,#1d3a7a 50%,#5a4a3a)',
    sampleUrl: VERIFIED_DEMO_URLS[0],
    renderOverlay: () => null,
  },
  {
    id: 'joe-rogan',
    title: 'Joe Rogan Experience …',
    date: 'May 15',
    background: 'linear-gradient(90deg,#000 6%,#4a0e10 6%,#5a1214 94%,#000 94%)',
    sampleUrl: VERIFIED_DEMO_URLS[1],
    renderOverlay: () => null,
  },
  {
    id: 'board-game',
    title: 'I Solved Every Board Ga…',
    date: 'Oct 27',
    background: 'linear-gradient(110deg,#5a6a8a,#7a7a7a 50%,#c9a679)',
    sampleUrl: VERIFIED_DEMO_URLS[2],
    renderOverlay: () => null,
  },
  {
    id: 'three-25',
    title: "This is everything that's …",
    date: 'Oct 27',
    background: 'linear-gradient(#d7cdc0,#c8bcae)',
    sampleUrl: VERIFIED_DEMO_URLS[3],
    renderOverlay: () => (
      <span className="absolute left-[10px] top-[8px] font-serif text-[14px] text-[#222]">
        $3.25
      </span>
    ),
  },
  {
    id: 'peptides',
    title: 'Peptides Are Insane',
    date: 'Oct 27',
    background: 'linear-gradient(#8a8a82,#a9a9a0 60%,#5a5a56)',
    sampleUrl: VERIFIED_DEMO_URLS[4],
    renderOverlay: () => (
      <span className="absolute left-[6px] top-[2px] text-[22px] tracking-[1px]">PEPTIDES</span>
    ),
  },
  {
    id: 'nba-players',
    title: '5 Real NBA Players vs. …',
    date: 'Oct 27',
    background: 'linear-gradient(#e0e0e0 35%,#d4944a 35%,#c4843a)',
    sampleUrl: VERIFIED_DEMO_URLS[5],
    renderOverlay: () => null,
  },
  {
    id: 'do-epic',
    title: 'How I Would Build…',
    date: 'Oct 27',
    background: 'linear-gradient(#000,#111)',
    sampleUrl: VERIFIED_DEMO_URLS[0],
    renderOverlay: () => (
      <span className="absolute bottom-[6px] left-0 right-0 text-center text-[15px]">
        DO <b className="text-[#ffd200]">EPIC</b> SH*T
      </span>
    ),
  },
];

const SAMPLE_PRESETS = [
  { label: 'YouTube Music Video (HD)', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'Action Demo Clip (.mp4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
  { label: 'Animated Short Film (.mp4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
];

interface VideosPageProps {
  user: AuthUser;
  onSignOut: () => void;
}

export function VideosPage({ user: _user, onSignOut }: VideosPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [ytAuthPending, setYtAuthPending] = useState<{
    verificationUrl: string;
    userCode: string;
    expiresAt: number;
  } | null>(null);
  const [ytAuthLoading, setYtAuthLoading] = useState(false);
  const [ytCodeCopied, setYtCodeCopied] = useState(false);
  const [minutesLeft, setMinutesLeft] = useState(10);
  const [videoUrl, setVideoUrl] = useState('');
  const [ownsRights, setOwnsRights] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [configureUrl, setConfigureUrl] = useState<string | null>(null);
  const [configureMeta, setConfigureMeta] = useState<InspectedVideoMeta | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [previewVideo, setPreviewVideo] = useState<DemoVideo | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const sampleRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const validationAbortRef = useRef<AbortController | null>(null);

  const cancelPendingValidation = () => {
    if (validationAbortRef.current) {
      validationAbortRef.current.abort();
      validationAbortRef.current = null;
    }
    setIsValidating(false);
  };

  useEffect(() => {
    return () => {
      validationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (sampleRef.current && !sampleRef.current.contains(e.target as Node)) {
        setSampleOpen(false);
      }
      const target = e.target as HTMLElement;
      if (!target.closest('[data-card-menu]')) {
        setOpenMenuId(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSampleOpen(false);
        setOpenMenuId(null);
        setSidebarOpen(false);
        setPreviewVideo(null);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  // Sync real YouTube OAuth2 verification status on mount
  useEffect(() => {
    let cancelled = false;
    fetch(resolveApiUrl('/api/youtube/auth/status'))
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            connected?: boolean;
            pending?: { verificationUrl: string; userCode: string; expiresAt: number } | null;
          } | null
        ) => {
          if (cancelled || !data) return;
          if (data.connected) {
            setYoutubeConnected(true);
            setMinutesLeft(20);
          } else if (data.pending) {
            setYtAuthPending(data.pending);
          }
        }
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll YouTube device verification while code is active
  useEffect(() => {
    if (!ytAuthPending) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
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
          setYoutubeConnected(true);
          setMinutesLeft(20);
          setYtAuthPending(null);
          setFeedback({
            type: 'success',
            text: 'YouTube verified! Bot checks bypassed & +10 min added.',
          });
        } else if (data.error) {
          setYtAuthPending(null);
          setFeedback({ type: 'error', text: data.error });
        } else if (!data.pending) {
          setYtAuthPending(null);
        }
      } catch {
        // Keep polling
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ytAuthPending]);

  const handleToggleConnect = async () => {
    if (ytAuthLoading) return;
    setFeedback(null);

    if (youtubeConnected) {
      setYtAuthLoading(true);
      try {
        await fetch(resolveApiUrl('/api/youtube/auth/disconnect'), { method: 'POST' });
        setYoutubeConnected(false);
        setYtAuthPending(null);
        setMinutesLeft(10);
        setFeedback({ type: 'success', text: 'YouTube account disconnected.' });
      } catch {
        setFeedback({ type: 'error', text: 'Could not disconnect YouTube.' });
      } finally {
        setYtAuthLoading(false);
      }
      return;
    }

    if (ytAuthPending) {
      setYtAuthPending(null);
      return;
    }

    setYtAuthLoading(true);
    try {
      const resp = await fetch(resolveApiUrl('/api/youtube/auth/start'), { method: 'POST' });
      const data = (await resp.json().catch(() => ({}))) as {
        connected?: boolean;
        pending?: { verificationUrl: string; userCode: string; expiresAt: number };
        error?: string;
        detail?: string;
      };
      if (resp.ok && data.connected) {
        setYoutubeConnected(true);
        setMinutesLeft(20);
        setYtAuthPending(null);
        setFeedback({ type: 'success', text: 'YouTube is already connected (+10 min active).' });
        return;
      }
      if (!resp.ok || !data.pending) {
        throw new Error(data.detail || data.error || 'Could not start YouTube verification.');
      }
      setYtAuthPending(data.pending);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not start YouTube verification.',
      });
    } finally {
      setYtAuthLoading(false);
    }
  };

  const handleGetClips = async () => {
    const trimmed = videoUrl.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: 'Pehle video link paste karo.' });
      inputRef.current?.focus();
      return;
    }

    let normalizedUrl = trimmed;
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      normalizedUrl = `https://www.youtube.com/watch?v=${trimmed}`;
    } else {
      try {
        const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const parsed = new URL(candidate);
        if (!parsed.hostname.includes('.')) throw new Error('Invalid');
        normalizedUrl = candidate;
      } catch {
        setFeedback({ type: 'error', text: 'Valid video URL paste karo.' });
        inputRef.current?.focus();
        return;
      }
    }

    if (!ownsRights) {
      setFeedback({
        type: 'error',
        text: 'Please check "I own the rights to this video" before processing a URL.',
      });
      return;
    }

    cancelPendingValidation();
    const controller = new AbortController();
    validationAbortRef.current = controller;

    setFeedback(null);
    setIsValidating(true);

    try {
      const validated = await fetchVideoValidation(normalizedUrl, controller.signal);
      if (validationAbortRef.current !== controller) return;

      const meta = toInspectedVideoMeta(validated);
      setConfigureMeta(meta);
      setConfigureUrl(meta.url);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && validationAbortRef.current !== controller) {
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : 'Video link validate nahi ho paya. Please try again.';
      setFeedback({ type: 'error', text: message });
      inputRef.current?.focus();
    } finally {
      if (validationAbortRef.current === controller) {
        validationAbortRef.current = null;
        setIsValidating(false);
      }
    }
  };

  const handleVideoFileUpload = (file: File | undefined) => {
    if (!file || isUploading) return;
    setFeedback(null);
    setIsUploading(true);
    setUploadPercent(0);

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', resolveApiUrl('/api/upload-video'));
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        setUploadPercent(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = () => {
      setIsUploading(false);
      try {
        const data = JSON.parse(xhr.responseText || '{}') as {
          url?: string;
          title?: string;
          author?: string;
          channel_name?: string;
          duration_sec?: number;
          duration_str?: string;
          duration?: string;
          thumbnail_url?: string;
          thumbnail?: string;
          platform?: string;
          error?: string;
          detail?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          setUploadPercent(100);
          const meta: InspectedVideoMeta = {
            url: data.url,
            title: data.title || file.name,
            author: data.author || data.channel_name || 'Uploaded File',
            duration_sec: data.duration_sec || 30,
            duration_str: data.duration_str || data.duration || '0:30',
            thumbnail_url: data.thumbnail_url || data.thumbnail || '',
            platform: data.platform || 'Uploaded File',
          };
          setConfigureMeta(meta);
          setConfigureUrl(data.url);
        } else {
          setFeedback({
            type: 'error',
            text: data.error || data.detail || 'Could not upload video file.',
          });
        }
      } catch {
        setFeedback({ type: 'error', text: 'Could not upload video file.' });
      }
    };
    xhr.onerror = () => {
      setIsUploading(false);
      setFeedback({ type: 'error', text: 'Upload failed. Please try again.' });
    };
    xhr.send(formData);
  };

  const handleCopyDemoLink = async (video: DemoVideo) => {
    try {
      await navigator.clipboard.writeText(video.sampleUrl);
      setCopiedId(video.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setVideoUrl(video.sampleUrl);
    }
    setOpenMenuId(null);
  };

  if (configureUrl !== null) {
    const isUploadedFile = configureUrl.startsWith('/uploads/');
    return (
      <ConfigurePage
        initialUrl={configureUrl}
        initialMeta={configureMeta}
        initialOwnsRights={isUploadedFile ? true : ownsRights}
        onBack={() => {
          setConfigureUrl(null);
          setConfigureMeta(null);
        }}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0c0c0c] text-[#f2f2f2]">
      <div
        className={`relative mx-auto max-w-[360px] pb-[90px] transition-[filter,opacity] duration-150 ${
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

          <div className="ml-[13px] flex flex-1 items-center gap-[10px] text-[13.5px] text-[#9d9d9d]">
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
            <b className="font-normal text-white">Videos</b>
          </div>

          <span className="flex h-[20px] items-center rounded-[8px] border border-[#3a3a3a] bg-[#1a1a1a] px-[6px] text-[12px] text-[#eeeeee]">
            Free
          </span>
        </header>

        <div className="mt-[17px] flex h-[28px] items-center justify-between pl-[17px] pr-4">
          <h1 className="m-0 flex items-center gap-[9px] text-[22px] font-medium tracking-[-0.2px] text-[#f2f2f2]">
            <span className="text-[21px]" aria-hidden="true">
              👋
            </span>
            <span>Hey, Aryan</span>
          </h1>
          <div className="flex h-[28px] items-center gap-[7px] rounded-[9px] border border-[#363636] bg-[#151515] px-[11px] text-[13.5px] tabular-nums">
            <svg
              className="h-[14px] w-[14px] fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <span>{minutesLeft} min</span>
          </div>
        </div>

        <section className="mx-4 mt-6 rounded-[20px] border border-[#272727] bg-[#121212] p-[17px] shadow-[0_6px_18px_rgba(0,0,0,0.4)]">
          <div className="flex h-[49px] items-center gap-[10px] rounded-[16px] border border-dashed border-[#333333] bg-[#151515] px-[15px]">
            <span className="grid h-[27px] w-[27px] flex-none place-items-center rounded-[8px] bg-black">
              <span className="relative h-[11px] w-[16px] rounded-[3px] bg-[#ff0000]">
                <span className="absolute left-[6px] top-[2.5px] h-0 w-0 border-b-[3px] border-l-[5px] border-t-[3px] border-b-transparent border-l-white border-t-transparent" />
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-[#c9c9c9]">
              {youtubeConnected ? 'YouTube connected' : 'Import from YouTube'}
            </span>
            <span className="flex h-[17px] flex-none items-center rounded-[6px] border border-[#14683a] bg-[#0a2a1a] px-[5px] text-[12px] text-[#22c55e]">
              {youtubeConnected ? 'Added' : '+10 min'}
            </span>
            <button
              type="button"
              disabled={ytAuthLoading}
              onClick={() => void handleToggleConnect()}
              className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[13.5px] text-[#3b6ef0] hover:underline disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              {ytAuthLoading
                ? 'Loading…'
                : youtubeConnected
                  ? 'Connected'
                  : ytAuthPending
                    ? 'Cancel'
                    : 'Connect'}
            </button>
          </div>

          {ytAuthPending && !youtubeConnected && (
            <div className="mt-3 rounded-[14px] border border-[#243c7a] bg-[#0e172e] p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10.5px] uppercase tracking-wider text-[#8fa4db]">
                    Google Device Code
                  </div>
                  <div className="font-mono text-[16px] font-bold tracking-[0.14em] text-white">
                    {ytAuthPending.userCode}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(ytAuthPending.userCode);
                      setYtCodeCopied(true);
                      window.setTimeout(() => setYtCodeCopied(false), 2000);
                    } catch {
                      // Ignore clipboard errors
                    }
                  }}
                  className="inline-flex h-[28px] cursor-pointer items-center gap-1 rounded-[8px] border border-[#3a59ad] bg-[#172857] px-2.5 text-[11.5px] font-medium text-[#dce5ff] hover:bg-[#1e3570]"
                >
                  {ytCodeCopied ? (
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
              <a
                href={ytAuthPending.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 flex h-[34px] w-full items-center justify-center gap-1.5 rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[12.5px] font-medium text-[#e3e9ff] no-underline hover:brightness-110"
              >
                <span>Open google.com/device</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] text-[#9fb3e6]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Waiting for Google approval to unblock YouTube…</span>
              </div>
            </div>
          )}

          <div
            ref={sampleRef}
            className="relative mt-[22px] flex h-[22px] items-center justify-between text-[13px] text-[#b5b5b5]"
          >
            <span>Don't have a video ready?</span>
            <button
              type="button"
              id="sample"
              onClick={() => setSampleOpen((prev) => !prev)}
              aria-expanded={sampleOpen}
              className="flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 text-[14px] text-[#3b6ef0] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <span>Try a sample video</span>
              <svg
                className={`h-[11px] w-[11px] fill-none stroke-current stroke-[1.7] transition-transform ${
                  sampleOpen ? 'rotate-180' : ''
                }`}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="m5 9 7 7 7-7" />
              </svg>
            </button>

            {sampleOpen && (
              <div className="absolute right-0 top-[28px] z-20 w-[210px] rounded-xl border border-[#2d2d2d] bg-[#181818] p-1 shadow-xl">
                {SAMPLE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setVideoUrl(preset.url);
                      setFeedback(null);
                      setSampleOpen(false);
                      inputRef.current?.focus();
                    }}
                    className="block w-full cursor-pointer rounded-lg px-3 py-2 text-left text-[12.5px] text-[#e6e6e6] hover:bg-[#242424]"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <label className="mt-[11px] flex h-[39px] items-center gap-[13px] overflow-hidden rounded-[12px] border border-[#272727] bg-[#181818] px-3 focus-within:border-[#4a6ee3]">
            <svg width="17" height="16" viewBox="0 0 24 22" className="shrink-0" aria-hidden="true">
              <path d="M8 1h8l8 14h-8z" fill="#fbbc04" />
              <path d="M8 1 0 15l4 7 8-14z" fill="#0f9d58" />
              <path d="M4 22l4-7h16l-4 7z" fill="#4285f4" />
            </svg>
            <input
              ref={inputRef}
              id="url"
              type="text"
              value={videoUrl}
              onChange={(e) => {
                cancelPendingValidation();
                setVideoUrl(e.target.value);
                if (feedback) setFeedback(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleGetClips();
                }
              }}
              placeholder="Paste a video link"
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-white placeholder-[#b0b0b0] outline-none"
            />
          </label>

          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-[#b8b8b8]">
            <input
              type="checkbox"
              checked={ownsRights}
              onChange={(e) => {
                setOwnsRights(e.target.checked);
                if (e.target.checked && feedback?.type === 'error') {
                  setFeedback(null);
                }
              }}
              className="h-3.5 w-3.5 rounded border-[#3a3a3a] bg-[#181818] accent-[#3157d6]"
            />
            <span>I own the rights to this video</span>
          </label>

          <button
            id="go"
            type="button"
            disabled={isValidating}
            onClick={() => void handleGetClips()}
            className="mt-3 inline-flex h-[40px] w-full cursor-pointer items-center justify-center gap-2 rounded-[12px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[14px] text-[#e3e9ff] shadow-[0_0_0_1px_#1a2a70] transition-all hover:brightness-110 disabled:cursor-wait disabled:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            {isValidating && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{isValidating ? 'Checking video link…' : 'Get clips in 1 click'}</span>
          </button>

          {feedback && (
            <div
              role="status"
              className={`mt-2.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ${
                feedback.type === 'error'
                  ? 'border border-[#5c1e1e] bg-[#241010] text-[#fca5a5]'
                  : 'border border-[#145a30] bg-[#0a2314] text-[#4ade80]'
              }`}
            >
              {feedback.type === 'error' ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="break-words leading-snug">{feedback.text}</span>
            </div>
          )}

          <input
            ref={uploadInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              handleVideoFileUpload(file);
            }}
          />

          <button
            type="button"
            disabled={isUploading}
            onClick={() => uploadInputRef.current?.click()}
            className="mt-4 flex h-[18px] cursor-pointer items-center gap-[9px] border-0 bg-transparent p-0 pl-[2px] text-[13px] text-[#b8b8b8] hover:text-white disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <svg
              className="h-[14px] w-[14px] fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
            <span>{isUploading ? `Uploading (${uploadPercent}%)...` : 'Upload file (MP4 / MOV)'}</span>
            <span className="flex h-[16px] items-center rounded-[8px] border border-[#14683a] bg-[#0a2a1a] px-[6px] text-[11px] text-[#22c55e]">
              FREE
            </span>
          </button>
        </section>

        <div className="mt-[33px] h-[1px] bg-[#1b1b1b]" />

        <div className="mx-4 mt-9 flex h-[22px] items-center gap-[9px]">
          <svg
            className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.7]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 26 24"
            aria-hidden="true"
          >
            <rect x="2" y="4" width="16" height="16" rx="3" />
            <path d="m18 10 5-3v10l-5-3" />
            <circle cx="7" cy="9" r="1" />
          </svg>
          <h2 className="m-0 text-[22px] font-medium tracking-[-0.2px] text-[#f2f2f2]">Demo Videos</h2>
          <span className="flex h-[16px] items-center rounded-[8px] border border-[#1f3a8a] bg-[#0f1a3a] px-[5px] text-[11px] tracking-[0.3px] text-[#4a7cf0]">
            TRY IT
          </span>
        </div>

        <p className="mx-4 mt-[19px] text-[13.5px] leading-[20px] text-[#a6a6a6]">
          Explore real videos with AI-generated clips. Edit captions, try styles, and see the full workflow.
        </p>

        <div className="mx-4 mt-[23px] grid grid-cols-2 gap-[12.5px]">
          {DEMO_VIDEOS.map((video) => (
            <article
              key={video.id}
              onClick={() => setPreviewVideo(video)}
              className="relative h-[143px] cursor-pointer overflow-visible rounded-[20px] border border-[#272727] bg-[#121212] shadow-[0_4px_12px_rgba(0,0,0,0.33)] transition-colors hover:border-[#3b3b3b]"
            >
              <div
                className="relative h-[88px] overflow-hidden rounded-t-[19px] font-extrabold leading-none text-white"
                style={{ background: video.background }}
              >
                <div className="absolute inset-0 flex items-center justify-center px-[14px] py-[6px] text-center text-[15px] uppercase">
                  {video.renderOverlay()}
                </div>

                {video.badge && (
                  <span className="absolute bottom-0 left-0 rounded-tr-[4px] bg-white px-1 py-[2px] text-[7.5px] italic text-[#111111]">
                    {video.badge}
                  </span>
                )}

                <button
                  type="button"
                  data-card-menu
                  aria-label="More"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId((prev) => (prev === video.id ? null : video.id));
                  }}
                  className="absolute right-[7px] top-[6px] grid h-[30px] w-[30px] cursor-pointer grid-flow-col content-center items-center justify-center gap-[2px] rounded-[10px] border-0 bg-[#1c1c1ce6] text-[0px] text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
                >
                  <i className="block h-[2.5px] w-[2.5px] rounded-full bg-white" />
                  <i className="block h-[2.5px] w-[2.5px] rounded-full bg-white" />
                  <i className="block h-[2.5px] w-[2.5px] rounded-full bg-white" />
                </button>
              </div>

              {openMenuId === video.id && (
                <div
                  data-card-menu
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-2 top-[40px] z-20 w-[148px] rounded-xl border border-[#2f2f2f] bg-[#191919] p-1 shadow-2xl"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewVideo(video);
                      setOpenMenuId(null);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-white hover:bg-[#262626]"
                  >
                    <Play className="h-3 w-3 text-[#3b6ef0]" />
                    <span>Preview clips</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVideoUrl(video.sampleUrl);
                      setFeedback({ type: 'success', text: `Loaded "${video.title}" link.` });
                      setOpenMenuId(null);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-white hover:bg-[#262626]"
                  >
                    <CheckCircle2 className="h-3 w-3 text-[#22c55e]" />
                    <span>Use video link</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyDemoLink(video)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[#c4c4c4] hover:bg-[#262626]"
                  >
                    {copiedId === video.id ? (
                      <Check className="h-3 w-3 text-[#22c55e]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>{copiedId === video.id ? 'Copied' : 'Copy link'}</span>
                  </button>
                </div>
              )}

              <div className="px-[11px] pt-[11px]">
                <p className="m-0 overflow-hidden whitespace-nowrap text-[14px] leading-[20px] text-[#f2f2f2]">
                  {video.title}
                </p>
                <span className="mt-[5px] block text-[12px] leading-[16px] text-[#9d9d9d]">
                  {video.date}
                </span>
              </div>
            </article>
          ))}
        </div>
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
        onSelectFeedback={(msg) => setFeedback({ type: 'success', text: msg })}
      />

      {previewVideo && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={previewVideo.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setPreviewVideo(null)}
        >
          <div
            className="w-full max-w-[340px] overflow-hidden rounded-2xl border border-[#272727] bg-[#121212] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="relative flex h-[120px] items-center justify-center p-4 text-center font-extrabold uppercase text-white"
              style={{ background: previewVideo.background }}
            >
              {previewVideo.renderOverlay()}
              <button
                type="button"
                onClick={() => setPreviewVideo(null)}
                aria-label="Close preview"
                className="absolute right-2.5 top-2.5 grid h-7 w-7 cursor-pointer place-items-center rounded-lg bg-black/60 text-white hover:bg-black/80"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <h3 className="text-[15px] font-semibold text-white">{previewVideo.title}</h3>
              <p className="mt-1 text-[12px] text-[#9d9d9d]">
                Demo video · {previewVideo.date} · 3 AI-generated clips ready to customize
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setVideoUrl(previewVideo.sampleUrl);
                    setFeedback({ type: 'success', text: `Loaded "${previewVideo.title}" link.` });
                    setPreviewVideo(null);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="h-9 flex-1 cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-[#e3e9ff] hover:brightness-110"
                >
                  Load into clip box
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewVideo(null)}
                  className="h-9 cursor-pointer rounded-[10px] border border-[#2c2c2c] bg-[#181818] px-3.5 text-[13px] text-[#c7c7c7] hover:bg-[#222222]"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
