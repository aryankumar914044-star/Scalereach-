import React, { useState, useEffect, useRef } from 'react';
import { ChatSupport } from './ChatSupport';
import { ScalereachSidebar } from './ScalereachSidebar';
import { ConfigureFullView } from './ConfigureFullView';
import { resolveApiUrl } from '../lib/videoBackend';

export interface InspectedVideoMeta {
  url: string;
  title: string;
  author: string;
  duration_sec: number;
  duration_str: string;
  thumbnail_url: string;
  platform: string;
}

interface ConfigurePageProps {
  initialUrl: string;
  initialMeta?: InspectedVideoMeta | null;
  initialOwnsRights?: boolean;
  onBack: () => void;
  onSignOut: () => void;
}

function isUrlReadyToScan(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/uploads/')) return true;
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return true;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    return parsed.hostname.includes('.');
  } catch {
    return false;
  }
}

export function ConfigurePage({
  initialUrl,
  initialMeta = null,
  initialOwnsRights = false,
  onBack,
  onSignOut,
}: ConfigurePageProps) {
  const [urlValue, setUrlValue] = useState(initialUrl);
  const [ownsRights, setOwnsRights] = useState(
    initialOwnsRights || initialUrl.trim().startsWith('/uploads/')
  );
  const [isScanned, setIsScanned] = useState(Boolean(initialMeta));
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanNonce, setScanNonce] = useState(0);
  const [videoMeta, setVideoMeta] = useState<InspectedVideoMeta | null>(initialMeta);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUrlValue(initialUrl);
    if (initialMeta) {
      setVideoMeta(initialMeta);
      setIsScanned(true);
      setIsScanning(false);
      setScanError('');
    } else {
      setIsScanned(false);
      setScanError('');
      setVideoMeta(null);
    }
  }, [initialUrl, initialMeta]);

  useEffect(() => {
    if (isScanned) return;
    if (!isUrlReadyToScan(urlValue)) {
      setIsScanning(false);
      return;
    }

    const controller = new AbortController();
    let timedOut = false;
    setIsScanning(true);
    setScanError('');

    const timer = window.setTimeout(async () => {
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 12000);

      try {
        const resp = await fetch(resolveApiUrl('/api/fetch-video'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlValue.trim() }),
          signal: controller.signal,
        });
        const data = (await resp.json().catch(() => ({}))) as {
          video_id?: string;
          url?: string;
          title?: string;
          thumbnail?: string;
          thumbnail_url?: string;
          duration?: string;
          duration_str?: string;
          duration_sec?: number;
          channel_name?: string;
          author?: string;
          platform?: string;
          detail?: string;
          error?: string;
        };
        if (!resp.ok) {
          throw new Error(data.detail || data.error || 'Could not inspect video URL.');
        }
        setVideoMeta({
          url: data.url || urlValue.trim(),
          title: data.title || 'Untitled Video',
          author: data.channel_name || data.author || 'Creator',
          duration_sec: data.duration_sec || 0,
          duration_str: data.duration || data.duration_str || '0:00',
          thumbnail_url: data.thumbnail || data.thumbnail_url || '',
          platform: data.platform || 'YouTube',
        });
        setIsScanned(true);
      } catch (err) {
        if (timedOut) {
          setScanError('Scanning timed out. Click Retry or upload an MP4/MOV file directly.');
        } else if ((err as Error).name === 'AbortError') {
          return;
        } else {
          setScanError(err instanceof Error ? err.message : 'Could not inspect video URL.');
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (!controller.signal.aborted || timedOut) {
          setIsScanning(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [urlValue, isScanned, scanNonce]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleRetryScan = () => {
    if (!isUrlReadyToScan(urlValue)) {
      setScanError('Enter a valid YouTube or direct .mp4/.mov video link.');
      return;
    }
    setScanError('');
    setIsScanned(false);
    setScanNonce((n) => n + 1);
  };

  const handleLocalFileSelect = (file: File | undefined) => {
    if (!file || isUploading) return;
    setScanError('');
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
          setUrlValue(data.url);
          setOwnsRights(true);
          setVideoMeta({
            url: data.url,
            title: data.title || file.name,
            author: data.author || data.channel_name || 'Uploaded File',
            duration_sec: data.duration_sec || 30,
            duration_str: data.duration_str || data.duration || '0:30',
            thumbnail_url: data.thumbnail_url || data.thumbnail || '',
            platform: data.platform || 'Uploaded File',
          });
          setIsScanned(true);
        } else {
          setScanError(data.error || data.detail || 'Could not upload video file.');
        }
      } catch {
        setScanError('Could not upload video file.');
      }
    };
    xhr.onerror = () => {
      setIsUploading(false);
      setScanError('Upload failed. Please check your connection and try again.');
    };
    xhr.send(formData);
  };

  if (isScanned && videoMeta) {
    return (
      <ConfigureFullView
        url={videoMeta.url || urlValue}
        videoMeta={videoMeta}
        ownsRights={ownsRights || (videoMeta.url || urlValue).startsWith('/uploads/')}
        onChangeUrl={(nextUrl) => {
          setUrlValue(nextUrl);
          setIsScanned(false);
          setVideoMeta(null);
        }}
        onRemoveVideo={() => {
          setUrlValue('');
          setIsScanned(false);
          setVideoMeta(null);
        }}
        onBack={onBack}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f2f2f2]">
      <div
        className={`relative mx-auto min-h-screen max-w-[360px] pb-[90px] transition-[filter,opacity] duration-150 ${
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
            <b className="font-normal text-white">Configure</b>
          </div>

          <span className="flex h-[20px] items-center rounded-[8px] border border-[#3a3a3a] bg-[#1a1a1a] px-[6px] text-[12px] text-[#eeeeee]">
            Free
          </span>
        </header>

        <button
          type="button"
          onClick={onBack}
          className="ml-[30px] mt-[29px] flex h-[24px] cursor-pointer items-center gap-[13px] border-0 bg-transparent p-0 text-[14px] text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
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
          <span>Back</span>
        </button>

        <section className="mx-4 mt-[21px] rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pb-[17px] pt-4">
          <div className="flex h-5 items-center gap-2 text-[14px]">
            <span className="relative h-[11px] w-4 flex-none rounded-[3px] bg-[#ff0000]">
              <span className="absolute left-[6px] top-[2.5px] h-0 w-0 border-b-[3px] border-l-[5px] border-t-[3px] border-b-transparent border-l-white border-t-transparent" />
            </span>
            <span>YouTube URL</span>
          </div>

          <div className="mt-[13px] flex h-[39px] items-center gap-2 rounded-[12px] border border-[#3a3a3a] bg-[#151515] pl-[11px] pr-3 focus-within:border-[#55555c]">
            <input
              type="text"
              value={urlValue}
              onChange={(e) => {
                setUrlValue(e.target.value);
                setIsScanned(false);
                setScanError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleRetryScan();
                }
              }}
              placeholder="Paste a video link"
              aria-label="YouTube URL"
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-white placeholder-[#7d7d7d] outline-none"
            />
            {isScanning && (
              <span
                aria-label="Checking video URL"
                role="status"
                className="h-[14px] w-[14px] flex-none animate-spin rounded-full border-[1.6px] border-[#4a4a4a] border-t-[#a8a8a8] motion-reduce:animate-none"
              />
            )}
          </div>

          {!urlValue.trim().startsWith('/uploads/') && (
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-[#b8b8b8]">
              <input
                type="checkbox"
                checked={ownsRights}
                onChange={(e) => setOwnsRights(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-[#3a3a3a] bg-[#181818] accent-[#3157d6]"
              />
              <span>I own the rights to this video</span>
            </label>
          )}

          {isScanning && (
            <p className="mt-2 text-[12px] text-[#9d9d9d]">
              Checking video details...
            </p>
          )}

          {scanError && (
            <div className="mt-2.5 rounded-[10px] border border-[#5c1e1e] bg-[#241010] p-2.5" role="alert">
              <p className="m-0 text-[12px] leading-4 text-[#fca5a5]">{scanError}</p>
              <button
                type="button"
                onClick={handleRetryScan}
                className="mt-2 h-7 cursor-pointer rounded-[8px] border border-[#4a6ee3] bg-[#2748b6] px-3 text-[12px] font-medium text-white hover:brightness-110"
              >
                Retry Scan
              </button>
            </div>
          )}

          {!isScanning && !scanError && isUrlReadyToScan(urlValue) && (
            <button
              type="button"
              onClick={handleRetryScan}
              className="mt-2.5 h-8 w-full cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[13px] font-medium text-[#e3e9ff] hover:brightness-110"
            >
              Continue to Configure
            </button>
          )}
        </section>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            handleLocalFileSelect(file);
          }}
        />

        <section className="mx-4 mt-[25px] flex min-h-[275px] flex-col items-center justify-center rounded-[20px] border border-dashed border-[#2c2c2c] bg-[#121212] py-5">
          <div className="grid h-[47px] w-[47px] place-items-center rounded-[16px] bg-[#141a2a]">
            <span className="relative h-4 w-6 flex-none rounded-[5px] bg-[#ff0000]">
              <span className="absolute left-[9px] top-[4px] h-0 w-0 border-b-[4px] border-l-[7px] border-t-[4px] border-b-transparent border-l-white border-t-transparent" />
            </span>
          </div>

          <p className="mt-[14px] px-4 text-center text-[13.5px] leading-5 text-[#b8b8b8]">
            Paste a video link or upload an MP4/MOV file to configure your clips
          </p>

          <button
            type="button"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
            className="mt-3 flex h-[34px] cursor-pointer items-center gap-2 rounded-[10px] border border-[#3a3a3a] bg-[#181818] px-4 text-[13px] font-medium text-white hover:border-[#4a6ee3] hover:bg-[#1f1f1f] disabled:cursor-wait disabled:opacity-70"
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
            <span>{isUploading ? `Uploading video (${uploadPercent}%)...` : 'Upload MP4 / MOV file'}</span>
          </button>

          <div className="mt-[17px] flex h-[18px] items-center gap-2 text-[12px] text-[#a9a9a9]">
            <span>Works with</span>
            <span className="relative h-[10px] w-[14px] flex-none rounded-[3px] bg-[#ff0000]">
              <span className="absolute left-[5px] top-[2px] h-0 w-0 border-b-[3px] border-l-[4px] border-t-[3px] border-b-transparent border-l-white border-t-transparent" />
            </span>
          </div>

          <div className="ml-[18px] mt-[10px] flex h-[14px] items-center gap-1 self-stretch" aria-hidden="true">
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M3 5V4a3 3 0 0 1 6 0v1h1v6H2V5zm1 0h4V4a2 2 0 0 0-4 0z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M1 1h10v7H7l-2 3V8H1z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M2 1h2v4l4-4h2.5L6 6l5 5H8.5L4 6.5V11H2z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M4 1h4l4 7-2 3H2L0 8z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M3 1 6 3 3 5 0 3zM9 1l3 2-3 2-3-2zM3 7l3 2-3 2-3-2zM9 7l3 2-3 2-3-2z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <circle cx="6" cy="6" r="2" />
              <path d="M5.5 0h1v2.5h-1zM5.5 9.5h1V12h-1zM0 5.5h2.5v1H0zM9.5 5.5H12v1H9.5z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <circle cx="6" cy="6" r="6" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M2 2h5a3 3 0 0 1 0 6H4v3H2z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <circle cx="6" cy="6" r="6" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <path d="M1 3h10v2H1zM1 7h10v2H1z" />
            </svg>
            <svg viewBox="0 0 12 12" className="h-[14px] w-[14px] flex-none fill-[#777777]">
              <circle cx="6" cy="7" r="4" />
            </svg>
          </div>

          <div className="ml-[17px] mt-[7px] self-stretch text-[12.5px] leading-4 text-[#8c8c8c]">
            + .mp4/.mov links & direct uploads
          </div>
        </section>
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
    </div>
  );
}
