/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, RotateCcw, Loader2 } from 'lucide-react';
import {
  ScalereachLogo,
  YouTubeBadge,
  SUPPORTED_PLATFORMS,
  type PlatformItem,
} from './components/PlatformIcons';
import { ChatSupport } from './components/ChatSupport';
import { UploadPlanModal, SkipWorkspaceModal } from './components/OnboardingModals';
import { LoginPage, type AuthUser } from './components/LoginPage';
import { VideosPage } from './components/VideosPage';
import { fetchVideoValidation, PYTHON_BACKEND_URL } from './lib/videoBackend';

interface QueuedVideo {
  url: string;
  source: string;
  videoId?: string;
  title?: string;
  channelName?: string;
  duration?: string;
  durationSec?: number;
  thumbnail?: string;
}

interface SampleVideo {
  id: string;
  title: string;
  duration: string;
  platform: string;
  url: string;
}

const SAMPLE_VIDEOS: SampleVideo[] = [
  {
    id: 'podcast',
    title: 'Founder Podcast Highlights',
    duration: '12:40',
    platform: 'YouTube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    id: 'keynote',
    title: 'Action Demo Recording (.mp4)',
    duration: '00:15',
    platform: 'Direct MP4',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  },
  {
    id: 'mp4',
    title: 'Studio Demo Recording (.mp4)',
    duration: '00:15',
    platform: 'Direct MP4',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  },
];

const AUTH_STORAGE_KEY = 'scalereach_auth_user';

function loadStoredUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed && typeof parsed.identity === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function detectSource(rawUrl: string): string | null {
  const val = rawUrl.trim().toLowerCase();
  if (!val) return null;
  if (val.includes('youtube.com') || val.includes('youtu.be')) return 'YouTube';
  if (val.includes('twitch.tv')) return 'Twitch';
  if (val.includes('drive.google.com')) return 'Google Drive';
  if (val.includes('dropbox.com')) return 'Dropbox';
  if (val.includes('vimeo.com')) return 'Vimeo';
  if (val.includes('loom.com')) return 'Loom';
  if (val.includes('zoom.us')) return 'Zoom';
  if (val.includes('x.com') || val.includes('twitter.com')) return 'X';
  if (val.endsWith('.mp4') || val.endsWith('.mov') || val.includes('.mp4?') || val.includes('.mov?')) {
    return 'Direct Video';
  }
  return 'Video Link';
}

function isValidVideoUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    return parsed.hostname.includes('.');
  } catch {
    return false;
  }
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(() => loadStoredUser());
  const [showLogin, setShowLogin] = useState(false);
  const [loginReason, setLoginReason] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState('');
  const [ownsRights, setOwnsRights] = useState(false);
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [queuedVideo, setQueuedVideo] = useState<QueuedVideo | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [droppedFileName, setDroppedFileName] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [skipModalOpen, setSkipModalOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const sampleMenuRef = useRef<HTMLDivElement>(null);
  const validationAbortRef = useRef<AbortController | null>(null);

  const cancelPendingValidation = () => {
    if (validationAbortRef.current) {
      validationAbortRef.current.abort();
      validationAbortRef.current = null;
    }
    setIsPreparing(false);
  };

  useEffect(() => {
    return () => {
      validationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!sampleMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (sampleMenuRef.current && !sampleMenuRef.current.contains(e.target as Node)) {
        setSampleMenuOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSampleMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [sampleMenuOpen]);

  const requireLogin = (reason?: string): boolean => {
    if (user) return true;
    setSampleMenuOpen(false);
    setLoginReason(reason ?? null);
    setShowLogin(true);
    return false;
  };

  const handleLoginSuccess = (authedUser: AuthUser, remember: boolean) => {
    setUser(authedUser);
    setShowLogin(false);
    setLoginReason(null);
    try {
      if (remember) {
        window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authedUser));
      } else {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures
    }
  };

  const handleSignOut = () => {
    cancelPendingValidation();
    setUser(null);
    setSampleMenuOpen(false);
    setQueuedVideo(null);
    setStatusMessage(null);
    setErrorMessage(null);
    setUploadModalOpen(false);
    setSkipModalOpen(false);
    try {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // Ignore storage failures
    }
  };

  const handleSelectSample = (sample: SampleVideo) => {
    if (!requireLogin('Try a sample video')) return;
    cancelPendingValidation();
    setVideoUrl(sample.url);
    setErrorMessage(null);
    setStatusMessage(`Loaded sample: ${sample.title}`);
    setQueuedVideo(null);
    setSampleMenuOpen(false);
    inputRef.current?.focus();
  };

  const handlePlatformClick = (platform: PlatformItem) => {
    if (!requireLogin(`Use ${platform.name}`)) return;
    cancelPendingValidation();
    setVideoUrl(platform.exampleUrl);
    setErrorMessage(null);
    setStatusMessage(`${platform.name} link format loaded`);
    setQueuedVideo(null);
    inputRef.current?.focus();
  };

  const handleGetClips = async () => {
    if (!requireLogin('Get clips in 1 click')) return;

    const trimmed = videoUrl.trim();
    if (!trimmed) {
      setErrorMessage('Paste a video link first or click "Try a sample video".');
      setStatusMessage(null);
      inputRef.current?.focus();
      return;
    }

    if (!isValidVideoUrl(trimmed)) {
      setErrorMessage('Enter a valid URL (YouTube, Twitch, Drive, Dropbox, or .mp4/.mov).');
      setStatusMessage(null);
      inputRef.current?.focus();
      return;
    }

    if (!ownsRights) {
      setErrorMessage('Please confirm that you own the rights to this video before processing URLs.');
      setStatusMessage(null);
      return;
    }

    const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const detected = detectSource(normalizedUrl) ?? 'Video Link';

    cancelPendingValidation();
    const controller = new AbortController();
    validationAbortRef.current = controller;

    setErrorMessage(null);
    setStatusMessage(
      PYTHON_BACKEND_URL
        ? 'Validating video link with backend…'
        : 'Validating video link…',
    );
    setQueuedVideo(null);
    setIsPreparing(true);

    try {
      const validated = await fetchVideoValidation(normalizedUrl, controller.signal);
      if (validationAbortRef.current !== controller) return;

      setStatusMessage(null);
      setQueuedVideo({
        url: validated.url || normalizedUrl,
        source: validated.platform || detected,
        videoId: validated.videoId,
        title: validated.title,
        channelName: validated.channelName,
        duration: validated.duration,
        durationSec: validated.durationSec,
        thumbnail: validated.thumbnail,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && validationAbortRef.current !== controller) {
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : 'Could not validate this video link. Please check the URL and try again.';
      setQueuedVideo(null);
      setStatusMessage(null);
      setErrorMessage(message);
      inputRef.current?.focus();
    } finally {
      if (validationAbortRef.current === controller) {
        validationAbortRef.current = null;
        setIsPreparing(false);
      }
    }
  };

  const handleResetVideo = () => {
    if (!requireLogin()) return;
    cancelPendingValidation();
    setQueuedVideo(null);
    setStatusMessage(null);
    setErrorMessage(null);
    inputRef.current?.focus();
  };

  const handleFileDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDraggingFile(false);
    if (!requireLogin('Upload a file')) return;
    const file = e.dataTransfer.files?.[0];
    setDroppedFileName(file ? file.name : null);
    setUploadModalOpen(true);
  };

  if (user) {
    return <VideosPage user={user} onSignOut={handleSignOut} />;
  }

  if (showLogin) {
    return (
      <LoginPage
        reason={loginReason}
        onSuccess={handleLoginSuccess}
        onBack={() => {
          setShowLogin(false);
          setLoginReason(null);
        }}
      />
    );
  }

  const detectedSource = detectSource(videoUrl);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <main className="relative mx-auto min-h-screen max-w-[360px] px-[15px] pb-[70px] pt-[20px] text-center">
        <ScalereachLogo />

        <h1 className="mb-[14px] mt-[26px] text-[22px] font-bold leading-[1.2] tracking-[-0.3px] text-white [text-wrap:balance]">
          You’re all set!
        </h1>

        <p className="mx-auto mb-[26px] max-w-[320px] text-[14px] leading-[23px] text-[#9c9c9c]">
          Your workspace is ready. Drop a video below to see your first clips.
        </p>

        <div className="mb-[23px] flex h-[31px] items-center justify-center gap-[7px] rounded-[8px] border border-[#145a30] bg-[#0a2314] text-[13px] text-[#22d36b]">
          <span aria-hidden="true">🎉</span>
          <span>10 free minutes added to your account</span>
        </div>

        <section className="rounded-[16px] border border-[#2a2a2a] bg-[#111111] px-[19px] pb-[19px] pt-[20px] text-left">
          <div className="relative mb-[21px] flex h-[20px] items-center justify-between" ref={sampleMenuRef}>
            <h2 className="m-0 text-[13px] font-semibold text-white">Add your first video</h2>

            <button
              type="button"
              onClick={() => {
                if (!requireLogin('Try a sample video')) return;
                setSampleMenuOpen((prev) => !prev);
              }}
              aria-expanded={sampleMenuOpen}
              aria-haspopup="menu"
              className="flex cursor-pointer items-center gap-[5px] whitespace-nowrap border-0 bg-transparent p-0 text-[13px] text-[#3b6fe0] transition-colors hover:text-[#658ff0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <span>Try a sample video</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className={`transition-transform duration-150 ${sampleMenuOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              >
                <path d="M2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>

            {sampleMenuOpen && (
              <div
                role="menu"
                aria-label="Sample videos"
                className="absolute right-0 top-[28px] z-30 w-[258px] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#171717] p-1 shadow-2xl"
              >
                {SAMPLE_VIDEOS.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    role="menuitem"
                    onClick={() => handleSelectSample(sample)}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[#232323] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8aa6ff]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-white">{sample.title}</div>
                      <div className="text-[11px] text-[#8d8d8d]">{sample.platform}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#9c9c9c]">
                      {sample.duration}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            onClick={() => {
              if (!user) requireLogin('Paste a video link');
            }}
            className={`flex h-[44px] items-center gap-[9px] overflow-hidden rounded-[9px] border bg-[#171717] px-[14px] transition-colors ${
              errorMessage
                ? 'border-[#dc2626]'
                : 'border-[#2a2a2a] focus-within:border-[#4a6ee3]'
            }`}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" className="shrink-0" aria-hidden="true">
              <rect width="24" height="24" rx="12" fill="#85c742" />
              <path d="M9.5 7.5v9l7-4.5z" fill="#0b0b0b" />
            </svg>
            <input
              ref={inputRef}
              id="url"
              type="url"
              value={videoUrl}
              readOnly={!user}
              onFocus={() => {
                if (!user) {
                  inputRef.current?.blur();
                  requireLogin('Paste a video link');
                }
              }}
              onChange={(e) => {
                if (!requireLogin('Paste a video link')) return;
                cancelPendingValidation();
                setVideoUrl(e.target.value);
                setErrorMessage(null);
                setStatusMessage(null);
                if (queuedVideo) setQueuedVideo(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleGetClips();
                }
              }}
              placeholder="Paste a YouTube, Twitch, Drive, Dropbox link"
              aria-label="Video link"
              aria-invalid={Boolean(errorMessage)}
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-white placeholder-[#8d8d8d] outline-none"
            />
            {videoUrl && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!requireLogin()) return;
                  cancelPendingValidation();
                  setVideoUrl('');
                  setErrorMessage(null);
                  setStatusMessage(null);
                  setQueuedVideo(null);
                  inputRef.current?.focus();
                }}
                aria-label="Clear video link"
                className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-[#8d8d8d] transition-colors hover:bg-[#242424] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#8aa6ff]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11.5px] text-[#b5b5b5]">
            <input
              type="checkbox"
              checked={ownsRights}
              onChange={(e) => {
                setOwnsRights(e.target.checked);
                if (e.target.checked) setErrorMessage(null);
              }}
              className="h-3.5 w-3.5 rounded border-[#3a3a3a] bg-[#171717] accent-[#3156d4]"
            />
            <span>I own the rights to this video</span>
          </label>

          {errorMessage && (
            <div className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-[1.4] text-[#f87171]" role="alert">
              <AlertCircle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {!errorMessage && statusMessage && !queuedVideo && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-[#8aa6ff]">
              <span className="truncate">{statusMessage}</span>
              {detectedSource && <span className="shrink-0 text-[#9c9c9c]">{detectedSource}</span>}
            </div>
          )}

          <div className="mb-[14px] mt-[19px] text-[11px] text-[#9c9c9c]">
            <div className="flex h-[16px] items-center gap-[7px]">
              <span>Works with</span>
              <button
                type="button"
                title="Load sample YouTube link"
                aria-label="Load sample YouTube link"
                onClick={() => handleSelectSample(SAMPLE_VIDEOS[0])}
                className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <YouTubeBadge />
              </button>
            </div>

            <div className="mt-[8px] flex flex-wrap items-center gap-[5px] text-[#6a6a6a]">
              {SUPPORTED_PLATFORMS.map((platform) => (
                <button
                  key={platform.id}
                  type="button"
                  title={`${platform.name} — click to load example link`}
                  aria-label={`${platform.name} example link`}
                  onClick={() => handlePlatformClick(platform)}
                  className="grid h-4 w-4 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-[#6a6a6a] transition-colors hover:text-[#b5b5b5] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#8aa6ff]"
                >
                  {platform.renderIcon()}
                </button>
              ))}
              <button
                type="button"
                onClick={() => handleSelectSample(SAMPLE_VIDEOS[2])}
                className="ml-[3px] cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[11px] text-[#8a8a8a] transition-colors hover:text-[#c7c7c7] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                + .mp4/.mov links
              </button>
            </div>
          </div>

          {queuedVideo ? (
            <div className="rounded-[8px] border border-[#145a30] bg-[#0a2314] p-3 text-left">
              <div className="flex items-start gap-2.5">
                {queuedVideo.thumbnail ? (
                  <div className="relative h-[44px] w-[76px] shrink-0 overflow-hidden rounded-[6px] border border-[#1d6e3d] bg-[#07190e]">
                    <img
                      src={queuedVideo.thumbnail}
                      alt={queuedVideo.title || 'Validated video thumbnail'}
                      className="h-full w-full object-cover"
                    />
                    {queuedVideo.duration && (
                      <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 py-[1px] text-[9.5px] font-medium text-white">
                        {queuedVideo.duration}
                      </span>
                    )}
                  </div>
                ) : (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#22d36b]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#22d36b]">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{queuedVideo.source} link verified</span>
                  </div>
                  {queuedVideo.title && (
                    <div className="mt-0.5 truncate text-[12.5px] font-semibold text-[#eafff2]">
                      {queuedVideo.title}
                    </div>
                  )}
                  <div className="mt-0.5 truncate text-[11px] text-[#9be8ba]">
                    {queuedVideo.channelName
                      ? `${queuedVideo.channelName}${queuedVideo.duration && !queuedVideo.thumbnail ? ` • ${queuedVideo.duration}` : ''}`
                      : queuedVideo.url}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleResetVideo}
                className="mt-2.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[#1d6e3d] bg-[#0f301c] px-2.5 py-1 text-[11.5px] font-medium text-[#d4fbe3] transition-colors hover:bg-[#143d24] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Change video link</span>
              </button>
            </div>
          ) : (
            <button
              id="go"
              type="button"
              onClick={() => void handleGetClips()}
              disabled={isPreparing}
              className="inline-flex h-[41px] w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-[#4a6ee3] bg-gradient-to-b from-[#3156d4] to-[#2748b6] text-[13px] font-medium text-[#dce5ff] transition-all duration-150 hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              {isPreparing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{isPreparing ? 'Checking video link…' : 'Get clips in 1 click \u00A0→'}</span>
            </button>
          )}

          <div className="my-[17px] flex items-center gap-[12px] text-[11px] text-[#9c9c9c] before:h-[1px] before:flex-1 before:bg-[#2a2a2a] before:content-[''] after:h-[1px] after:flex-1 after:bg-[#2a2a2a] after:content-['']">
            OR
          </div>

          <button
            type="button"
            onClick={() => {
              if (!requireLogin('Upload a file')) return;
              setDroppedFileName(null);
              setUploadModalOpen(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingFile(true);
            }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={handleFileDrop}
            className={`flex h-[106px] w-full cursor-pointer flex-col items-center justify-center gap-[4px] rounded-[12px] border border-dashed bg-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
              isDraggingFile
                ? 'border-[#4a6ee3] bg-[#161c2e]'
                : 'border-[#363636] hover:border-[#4e4e4e] hover:bg-[#151515]'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-[21px] w-[21px] fill-none stroke-[#8f8f8f] stroke-[1.5]"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.7 8 4.5 4.5 0 0 1 17 18" />
              <path d="M12 11v9M8.5 14.5 12 11l3.5 3.5" />
            </svg>
            <h3 className="m-0 mt-[6px] text-[13px] font-medium text-white">Upload a file</h3>
            <p className="m-0 text-[11px] text-[#9c9c9c]">Free direct MP4, MOV, or WebM upload</p>
          </button>
        </section>

        <button
          id="skip"
          type="button"
          onClick={() => {
            if (!requireLogin('Go to workspace')) return;
            setSkipModalOpen(true);
          }}
          className="mx-auto mt-[28px] block cursor-pointer whitespace-nowrap border-0 bg-transparent text-[12px] text-[#9c9c9c] transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
        >
          Not right now, take me to my workspace
        </button>
      </main>

      <ChatSupport
        isAuthenticated={Boolean(user)}
        onRequireAuth={() => requireLogin('Chat support')}
      />

      <UploadPlanModal
        open={uploadModalOpen}
        fileName={droppedFileName}
        onClose={() => setUploadModalOpen(false)}
        onUseLinkInstead={() => {
          setUploadModalOpen(false);
          inputRef.current?.focus();
        }}
      />

      <SkipWorkspaceModal
        open={skipModalOpen}
        onClose={() => setSkipModalOpen(false)}
        onTrySample={() => {
          setSkipModalOpen(false);
          handleSelectSample(SAMPLE_VIDEOS[0]);
        }}
      />
    </div>
  );
}

