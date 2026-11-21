import React, { useState, useEffect } from 'react';
import { ScalereachSidebar } from './ScalereachSidebar';
import { ClipsPage } from './ClipsPage';
import { resolveApiUrl, resolveMediaUrl } from '../lib/videoBackend';

import type { InspectedVideoMeta } from './ConfigurePage';

interface ConfigureFullViewProps {
  url: string;
  videoMeta: InspectedVideoMeta;
  ownsRights: boolean;
  onChangeUrl: (nextUrl: string) => void;
  onRemoveVideo: () => void;
  onBack: () => void;
  onSignOut: () => void;
}

const CLIP_PRESETS = [
  { name: 'Viral Clips', desc: 'For several high-impact short videos.' },
  { name: 'Topic Highlights', desc: 'Key moments grouped by chapter.' },
  { name: 'Podcast Moments', desc: 'Best Q&A and reaction exchanges.' },
];

const ASPECT_RATIOS = ['9:16 Portrait', '1:1 Square', '16:9 Landscape'];
const LANGUAGES = ['Auto', 'English', 'Hindi', 'Hinglish', 'Spanish', 'French'];
const DURATION_OPTIONS = ['Auto', '15 - 30s', '30 - 60s', '60 - 90s', '1 - 2 min', '2 - 3 min'];
const MAX_CLIPS_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Auto', value: null },
  { label: '3 clips', value: 3 },
  { label: '5 clips', value: 5 },
  { label: '8 clips', value: 8 },
  { label: '10 clips', value: 10 },
  { label: '12 clips', value: 12 },
  { label: '15 clips', value: 15 },
];
const BG_FILTERS = ['All', '🚗 GTA 5', '⛏️ Minecraft', '🎬 Subway Surfers'];

interface CaptionStyleItem {
  id: string;
  label: string;
  kind: 'classic' | 'blue-glow' | 'toxic' | 'bar' | 'hormozi' | 'minimal' | 'karaoke';
  color?: string;
  italic?: boolean;
}

const CAPTION_STYLES: CaptionStyleItem[] = [
  { id: 'hormozi', label: 'Hormozi Pop', kind: 'hormozi' },
  { id: 'minimal-clean', label: 'Minimal Clean', kind: 'minimal' },
  { id: 'karaoke', label: 'Karaoke', kind: 'karaoke' },
  { id: 'classic', label: 'Classic', kind: 'classic' },
  { id: 'cyan-slide', label: 'Cyan Slide', kind: 'bar', color: '#19b5ff' },
  { id: 'italic-red', label: 'Italic Red', kind: 'bar', color: '#ff2a1a', italic: true },
  { id: 'cream-blue', label: 'Cream Blue', kind: 'bar', color: '#79a4ff' },
  { id: 'red-spin', label: 'Red Spin', kind: 'bar', color: '#ff2a1a' },
  { id: 'violet', label: 'Violet', kind: 'bar', color: '#6a5aff' },
  { id: 'blue-glow', label: 'Blue Glow', kind: 'blue-glow' },
  { id: 'toxic-green', label: 'Toxic Green', kind: 'toxic' },
];

function InfoIcon() {
  return (
    <svg
      className="h-[13px] w-[13px] flex-none fill-none stroke-[#9a9a9a] stroke-[1.7]"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

function UpDownIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`h-[14px] w-[14px] flex-none fill-none stroke-[#aaaaaa] stroke-[1.7] ${className}`}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />
    </svg>
  );
}

function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={`relative h-[18px] w-[30px] flex-none cursor-pointer rounded-[9px] border-0 p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
        checked ? 'bg-[#2a4fd8]' : 'bg-[#2a2a2a]'
      }`}
    >
      <span
        className={`absolute top-[1.5px] h-[15px] w-[15px] rounded-full bg-white transition-[left] duration-150 ${
          checked ? 'left-[13.5px]' : 'left-[1.5px]'
        }`}
      />
    </button>
  );
}

function parseTimeInput(raw: string, fallbackSec: number): number {
  const s = raw.trim();
  if (!s) return fallbackSec;
  if (/^\d+(\.\d+)?$/.test(s)) {
    return Math.max(0, Math.round(Number(s) * 60));
  }
  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return fallbackSec;
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return fallbackSec;
}

export function ConfigureFullView({
  url,
  videoMeta,
  ownsRights: initialOwnsRights,
  onChangeUrl,
  onRemoveVideo,
  onBack,
  onSignOut,
}: ConfigureFullViewProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [clipTab, setClipTab] = useState<'Templates' | 'Custom'>('Templates');
  const [presetIndex, setPresetIndex] = useState(0);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);

  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [selectedStyle, setSelectedStyle] = useState('hormozi');

  const [autoHook, setAutoHook] = useState(true);
  const [smartReframe, setSmartReframe] = useState(true);
  const [aiMusic, setAiMusic] = useState(false);

  const [duration, setDuration] = useState('Auto');
  const [maxClipsIndex, setMaxClipsIndex] = useState(0);
  const [aspectIndex, setAspectIndex] = useState(0);
  const [languageIndex, setLanguageIndex] = useState(0);

  const [splitScreen, setSplitScreen] = useState(false);
  const [bgFilter, setBgFilter] = useState('All');

  const [startTimeText, setStartTimeText] = useState('0:00');
  const [endTimeText, setEndTimeText] = useState(videoMeta.duration_str || '0:00');
  const [rightsConfirmed, setRightsConfirmed] = useState(
    initialOwnsRights || url.trim().startsWith('/uploads/')
  );

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
        setPresetMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const currentPreset = CLIP_PRESETS[presetIndex];

  const handleStartClipping = async (override?: {
    url: string;
    meta?: Partial<InspectedVideoMeta>;
  }) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError('');
    const targetUrl = override?.url || url;
    const isUploaded = targetUrl.startsWith('/uploads/');
    if (!isUploaded && !rightsConfirmed) {
      setSubmitError('Please confirm that you own the rights to this video before generating clips.');
      setIsSubmitting(false);
      return;
    }

    const targetTitle = override?.meta?.title || videoMeta.title;
    const targetAuthor = override?.meta?.author || videoMeta.author;
    const targetPlatform = override?.meta?.platform || videoMeta.platform;
    const targetThumb = override?.meta?.thumbnail_url ?? videoMeta.thumbnail_url;
    const targetDur = override?.meta?.duration_sec || videoMeta.duration_sec;
    const parsedStart = parseTimeInput(startTimeText, 0);
    const parsedEnd = parseTimeInput(endTimeText, targetDur || 0);
    const effectiveEnd = parsedEnd > parsedStart ? parsedEnd : targetDur;

    try {
      const resp = await fetch(resolveApiUrl('/api/generate-clips'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          videoTitle: targetTitle,
          author: targetAuthor,
          platform: targetPlatform,
          thumbnailUrl: targetThumb,
          durationSec: targetDur,
          clipType: clipTab,
          preset: currentPreset.name,
          captionsEnabled,
          captionStyle: selectedStyle,
          autoHook,
          smartReframe,
          aiMusic,
          durationRange: duration,
          maxClips: MAX_CLIPS_OPTIONS[maxClipsIndex].value,
          aspectRatio: splitScreen ? '9:16 Portrait' : ASPECT_RATIOS[aspectIndex],
          language: LANGUAGES[languageIndex],
          splitScreen,
          backgroundVideo: bgFilter,
          startSec: parsedStart,
          endSec: effectiveEnd,
          ownsRights: isUploaded ? true : rightsConfirmed,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        job_id?: string;
        jobId?: string;
        error?: string;
        detail?: string;
      };
      const resolvedJobId = data.job_id || data.jobId;
      if (!resp.ok || !resolvedJobId) {
        throw new Error(data.detail || data.error || 'Could not start clip generation.');
      }
      setActiveJobId(resolvedJobId);
      window.scrollTo(0, 0);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not start clip generation.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (activeJobId) {
    return (
      <ClipsPage
        jobId={activeJobId}
        videoTitle={videoMeta.title}
        platform={videoMeta.platform}
        thumbnailUrl={videoMeta.thumbnail_url}
        aspectRatio={ASPECT_RATIOS[aspectIndex]}
        clipPreset={currentPreset.name}
        onRetry={() => handleStartClipping()}
        onUploadAndClip={(uploaded) =>
          handleStartClipping({
            url: uploaded.url,
            meta: uploaded,
          })
        }
        onBack={() => setActiveJobId(null)}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f2f2f2]">
      <div
        className={`mx-auto max-w-[360px] pb-[78px] transition-[filter,opacity] duration-150 ${
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
          className="ml-[30px] mt-[11px] flex h-[24px] cursor-pointer items-center gap-[13px] border-0 bg-transparent p-0 text-[14px] text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
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

        {/* 1: Scanned Video Card */}
        <section className="mx-4 mt-[22px] overflow-hidden rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pt-4">
          <div className="flex h-5 items-center gap-2 text-[14px]">
            <span className="relative h-[11px] w-4 flex-none rounded-[3px] bg-[#ff0000]">
              <span className="absolute left-[6px] top-[2.5px] h-0 w-0 border-b-[3px] border-l-[5px] border-t-[3px] border-b-transparent border-l-white border-t-transparent" />
            </span>
            <span>YouTube URL</span>
          </div>

          <div className="mt-[13px] flex h-[39px] items-center gap-2 rounded-[12px] border-[1.5px] border-[#22c55e] bg-[#151515] pl-[11px] pr-3">
            <input
              type="text"
              value={url}
              onChange={(e) => onChangeUrl(e.target.value)}
              aria-label="YouTube URL"
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-white outline-none"
            />
            <svg
              className="h-[15px] w-[15px] flex-none fill-none stroke-[#22c55e] stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m4 12 5 5L20 6" />
            </svg>
          </div>

          <div className="-mx-[17px] mt-[17px] border-t border-[#1f1f1f]">
            <div
              className="relative h-[183px]"
              style={{
                background: videoMeta.thumbnail_url
                  ? `url("${resolveMediaUrl(videoMeta.thumbnail_url)}") center/cover no-repeat, linear-gradient(135deg,#6a1a9a,#b02ac8 55%,#3a1060)`
                  : 'radial-gradient(circle at 80% 14%,#ff9cff 0,#c433dd 10%,transparent 34%),radial-gradient(circle at 32% 38%,#9a7a68 0,#6a5568 18%,transparent 36%),radial-gradient(circle at 66% 52%,#2c1226 0,#4a1a38 18%,transparent 34%),radial-gradient(circle at 52% 85%,#9a1a24 0,#6a1018 14%,transparent 30%),linear-gradient(135deg,#6a1a9a,#b02ac8 55%,#3a1060)',
              }}
            >
              <span className="absolute bottom-2 left-[9px] grid h-[25px] w-[25px] place-items-center rounded-full bg-[#0aa5e8] text-[7px] font-bold text-white">
                {videoMeta.author.slice(0, 4).toLowerCase()}
              </span>
            </div>

            <div className="flex justify-between gap-[10px] px-[13px] py-[11px]">
              <div>
                <p className="m-0 text-[14px] leading-[20px] text-[#f2f2f2]">
                  {videoMeta.title}
                </p>
                <span className="block text-[13px] leading-[20px] text-[#9d9d9d]">
                  {videoMeta.author} • {videoMeta.duration_str}
                </span>
              </div>
              <button
                type="button"
                onClick={onRemoveVideo}
                aria-label="Remove"
                className="mr-2 mt-1 h-5 w-5 flex-none cursor-pointer border-0 bg-transparent p-0 text-[#dddddd] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                <svg
                  className="h-[14px] w-[14px] fill-none stroke-current stroke-[1.7]"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M5 5l14 14M19 5 5 19" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        {/* 2: Clip Type */}
        <section className="mx-4 mt-[21px] rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pb-[17px] pt-4">
          <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
            <span>Clip Type</span>
            <InfoIcon />
          </div>
          <p className="m-0 mt-[2px] text-[12px] leading-4 text-[#a2a2a2]">
            Choose what kind of clips to generate
          </p>

          <div className="mt-[11px] inline-flex h-9 rounded-[12px] bg-[#1d1d1d] px-1 py-[3px]">
            {(['Templates', 'Custom'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setClipTab(tab)}
                className={`cursor-pointer rounded-[10px] border px-[13px] text-[14px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                  clipTab === tab
                    ? 'border-[#4a4a4a] bg-[#2a2a2a] text-white'
                    : 'border-transparent bg-transparent text-[#a2a2a2] hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="relative mt-5">
            <button
              type="button"
              onClick={() => setPresetMenuOpen((prev) => !prev)}
              className="flex h-[53px] w-full cursor-pointer items-center justify-between rounded-[14px] border border-[#333333] bg-[#161616] pl-[13px] pr-[10px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <div>
                <b className="block text-[14px] font-normal leading-5 text-[#f2f2f2]">
                  {currentPreset.name}
                </b>
                <span className="block text-[13px] leading-[18px] text-[#a0a0a0]">
                  {currentPreset.desc}
                </span>
              </div>
              <UpDownIcon />
            </button>

            {presetMenuOpen && (
              <div className="mt-1.5 rounded-[12px] border border-[#333333] bg-[#181818] p-1 shadow-xl">
                {CLIP_PRESETS.map((preset, idx) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      setPresetIndex(idx);
                      setPresetMenuOpen(false);
                    }}
                    className={`block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left text-[13px] ${
                      idx === presetIndex ? 'bg-[#2a2a2a] text-white' : 'text-[#b5b5b5] hover:bg-[#222222]'
                    }`}
                  >
                    <div className="font-medium">{preset.name}</div>
                    <div className="text-[11.5px] text-[#8f8f8f]">{preset.desc}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* 3: Captions */}
        <section className="mx-4 mt-[21px] rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pb-[17px] pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
                <span>Captions</span>
                <InfoIcon />
              </div>
              <p className="m-0 mt-[2px] text-[12px] leading-4 text-[#a2a2a2]">
                Add captions to your clips and choose a style
              </p>
            </div>
            <ToggleSwitch
              checked={captionsEnabled}
              onToggle={() => setCaptionsEnabled((prev) => !prev)}
              label="Captions"
            />
          </div>

          <div
            className={`mt-[17px] grid grid-cols-3 gap-2 px-[3px] transition-opacity ${
              captionsEnabled ? 'opacity-100' : 'pointer-events-none opacity-45'
            }`}
          >
            {CAPTION_STYLES.map((style) => {
              const isSelected = selectedStyle === style.id;
              return (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => setSelectedStyle(style.id)}
                  className={`flex cursor-pointer flex-col items-center rounded-[14px] bg-[#1b1b1b] p-0 text-[12px] text-[#a8a8a8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                    isSelected
                      ? '-mx-[2px] -my-[3px] h-[78px] border-2 border-[#2f55e0] pt-[2px]'
                      : 'h-[72px] border border-[#2c2c2c]'
                  }`}
                >
                  {style.kind === 'hormozi' && (
                    <div className="mt-2.5 text-center font-sans text-[14.5px] font-black uppercase leading-none text-white [text-shadow:0_2px_0_#000]">
                      BOLD
                      <br />
                      <span className="text-[#ffd700]">POP</span>
                    </div>
                  )}

                  {style.kind === 'minimal' && (
                    <div className="mt-3.5 text-center font-sans text-[13.5px] font-semibold leading-tight text-[#f8f8f8]">
                      Clean
                      <br />
                      <span className="rounded bg-white/15 px-1 text-[11px] font-medium text-white">
                        subtitle
                      </span>
                    </div>
                  )}

                  {style.kind === 'karaoke' && (
                    <div className="mt-3 text-center font-sans text-[13.5px] font-extrabold uppercase leading-none text-[#b8b8b8]">
                      WORD
                      <br />
                      <span className="text-[#fff200]">SYNC</span>
                    </div>
                  )}

                  {style.kind === 'classic' && (
                    <div className="mt-3 text-center font-sans text-[15px] font-extrabold uppercase leading-none text-white">
                      TO GET
                      <br />
                      <span className="text-[#fff200]">STARTED</span>
                    </div>
                  )}

                  {style.kind === 'blue-glow' && (
                    <div className="mt-3 text-center font-sans text-[15px] font-extrabold leading-none text-white">
                      <span className="text-[16px] font-medium">to get</span>
                      <br />
                      <span className="text-[14px] uppercase text-[#3aa0ff]">STARTED</span>
                    </div>
                  )}

                  {style.kind === 'toxic' && (
                    <div
                      className="mt-3 text-center text-[15px] font-normal uppercase leading-none text-[#3ee03a] [text-shadow:0_1px_2px_#000]"
                      style={{ fontFamily: 'Impact, "Arial Narrow", sans-serif' }}
                    >
                      TO GET
                      <br />
                      STARTED
                    </div>
                  )}

                  {style.kind === 'bar' && (
                    <div
                      className={`mt-4 grid h-[29px] w-[72px] place-items-center overflow-hidden rounded-[6px] text-[7.2px] font-black uppercase leading-none whitespace-nowrap ${
                        isSelected
                          ? ''
                          : 'bg-[linear-gradient(110deg,#6a5a50,#222_28%,#101010_60%,#6a4a3a)] [text-shadow:0_0_4px_currentColor]'
                      }`}
                      style={{
                        fontFamily: 'Impact, "Arial Narrow", Arial, sans-serif',
                        color: style.color,
                        fontStyle: style.italic ? 'italic' : 'normal',
                      }}
                    >
                      More founders than
                    </div>
                  )}

                  <span className="mb-2 mt-auto">{style.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 4: Feature Toggles */}
        <section className="mx-4 mt-[21px] overflow-hidden rounded-[20px] border border-[#262626] bg-[#121212]">
          <div className="flex items-center justify-between px-[17px] py-3">
            <div>
              <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
                <span>Auto Hook</span>
                <InfoIcon />
              </div>
              <p className="m-0 mt-[2px] pr-3 text-[12px] leading-4 text-[#a2a2a2]">
                AI hook title at the top of every clip to grab attention
              </p>
            </div>
            <ToggleSwitch
              checked={autoHook}
              onToggle={() => setAutoHook((prev) => !prev)}
              label="Auto Hook"
            />
          </div>

          <div className="flex items-center justify-between border-t border-[#222222] px-[17px] py-3">
            <div>
              <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
                <span>Smart AI Reframing</span>
                <InfoIcon />
              </div>
              <p className="m-0 mt-[2px] pr-3 text-[12px] leading-4 text-[#a2a2a2]">
                Automatically reframe horizontal video to 9:16 by tracking faces
              </p>
            </div>
            <ToggleSwitch
              checked={smartReframe}
              onToggle={() => setSmartReframe((prev) => !prev)}
              label="Smart AI Reframing"
            />
          </div>

          <div className="flex items-center justify-between border-t border-[#222222] px-[17px] py-3">
            <div>
              <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
                <span>AI Music</span>
                <span className="flex h-[15px] items-center rounded-[8px] border border-[#1f3a8a] bg-[#101a3a] px-[6px] text-[11px] text-[#4a7cf0]">
                  PRO
                </span>
                <InfoIcon />
              </div>
              <p className="m-0 mt-[2px] pr-3 text-[12px] leading-4 text-[#a2a2a2]">
                Add background music that fits each clip, mixed under the speaker
              </p>
            </div>
            <ToggleSwitch
              checked={aiMusic}
              onToggle={() => setAiMusic((prev) => !prev)}
              label="AI Music"
            />
          </div>
        </section>

        {/* 5: Duration, Aspect Ratio, Language */}
        <section className="mx-4 mt-[21px] overflow-hidden rounded-[20px] border border-[#262626] bg-[#121212]">
          <div className="flex items-center px-[17px] py-3">
            <div className="flex flex-[0_0_114px] items-center gap-[7px] whitespace-nowrap text-[14px] font-medium">
              <span>Clip Duration</span>
              <InfoIcon />
            </div>
            <div className="flex flex-1 flex-wrap gap-x-2 gap-y-[9px]">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setDuration(opt)}
                  className={`h-[29px] cursor-pointer rounded-[13px] border bg-[#1a1a1a] px-[13px] text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                    duration === opt
                      ? 'border-[#4a6ee3] shadow-[0_0_0_1.5px_#2447d8]'
                      : 'border-[#333333]'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center border-t border-[#222222] px-[17px] py-[12.5px]">
            <div className="flex flex-[0_0_114px] items-center gap-[7px] whitespace-nowrap text-[14px] font-medium">
              <span>Aspect Ratio</span>
              <InfoIcon />
            </div>
            <button
              type="button"
              onClick={() => setAspectIndex((prev) => (prev + 1) % ASPECT_RATIOS.length)}
              className="ml-auto flex h-9 w-[143px] cursor-pointer items-center gap-[9px] rounded-[12px] border border-[#3a3a3a] bg-[#181818] pl-3 pr-[9px] text-[14px] text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <svg
                className="h-[14px] w-[12px] flex-none fill-none stroke-current stroke-[1.7]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 12 14"
                aria-hidden="true"
              >
                <rect x="1.5" y="1" width="9" height="12" rx="2" />
                <path d="M5 11h2" />
              </svg>
              <span className="truncate">{ASPECT_RATIOS[aspectIndex]}</span>
              <UpDownIcon className="ml-auto" />
            </button>
          </div>

          <div className="flex items-center border-t border-[#222222] px-[17px] py-[12.5px]">
            <div className="flex flex-[0_0_114px] items-center gap-[7px] whitespace-nowrap text-[14px] font-medium">
              <span>Language</span>
              <InfoIcon />
            </div>
            <button
              type="button"
              onClick={() => setLanguageIndex((prev) => (prev + 1) % LANGUAGES.length)}
              className="ml-auto flex h-9 w-[143px] cursor-pointer items-center gap-[9px] rounded-[12px] border border-[#3a3a3a] bg-[#181818] pl-[13px] pr-[9px] text-[14px] text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <span className="truncate">{LANGUAGES[languageIndex]}</span>
              <UpDownIcon className="ml-auto" />
            </button>
          </div>

          <div className="flex items-center border-t border-[#222222] px-[17px] py-[12.5px]">
            <div className="flex flex-[0_0_114px] items-center gap-[7px] whitespace-nowrap text-[14px] font-medium">
              <span>Clip Count</span>
              <InfoIcon />
            </div>
            <button
              type="button"
              onClick={() => setMaxClipsIndex((prev) => (prev + 1) % MAX_CLIPS_OPTIONS.length)}
              className="ml-auto flex h-9 w-[143px] cursor-pointer items-center gap-[9px] rounded-[12px] border border-[#3a3a3a] bg-[#181818] pl-[13px] pr-[9px] text-[14px] text-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <span className="truncate">{MAX_CLIPS_OPTIONS[maxClipsIndex].label}</span>
              <UpDownIcon className="ml-auto" />
            </button>
          </div>
        </section>

        {/* 6: Processing Timeframe */}
        <section className="mx-4 mt-[21px] rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pb-[17px] pt-4">
          <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
            <span>Processing Timeframe</span>
            <InfoIcon />
          </div>
          <p className="m-0 mt-[2px] text-[12px] leading-4 text-[#a2a2a2]">
            Select which part of the video to process
          </p>

          <div className="relative mt-4 h-4">
            <i className="absolute left-2 right-2 top-1 h-2 rounded-[4px] bg-[#2a4fd8]" />
            <b className="absolute left-0 top-0 h-[15px] w-[15px] rounded-full border-2 border-[#2a4fd8] bg-[#0b0b0b]" />
            <b className="absolute right-0 top-0 h-[15px] w-[15px] rounded-full border-2 border-[#2a4fd8] bg-[#0b0b0b]" />
          </div>

          <div className="mt-4 grid grid-cols-[1fr_35px_1fr] items-center">
            <div className="mb-[5px] h-4 text-[13px] text-[#a2a2a2]">Start</div>
            <div />
            <div className="mb-[5px] h-4 text-[13px] text-[#a2a2a2]">End</div>

            <div className="flex h-[31px] items-center gap-[9px] rounded-[12px] border border-[#3a3a3a] bg-[#181818] px-[10px] font-mono text-[15px] tabular-nums">
              <svg
                className="h-3 w-3 flex-none fill-none stroke-[#aaaaaa] stroke-[1.7]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <input
                type="text"
                value={startTimeText}
                onChange={(e) => setStartTimeText(e.target.value)}
                aria-label="Start time"
                className="w-full min-w-0 border-0 bg-transparent font-mono text-[14px] text-white outline-none"
              />
            </div>

            <div className="text-center text-[13px] text-[#a2a2a2]">to</div>

            <div className="flex h-[31px] items-center gap-[9px] rounded-[12px] border border-[#3a3a3a] bg-[#181818] px-[10px] font-mono text-[15px] tabular-nums">
              <svg
                className="h-3 w-3 flex-none fill-none stroke-[#aaaaaa] stroke-[1.7]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <input
                type="text"
                value={endTimeText}
                onChange={(e) => setEndTimeText(e.target.value)}
                aria-label="End time"
                className="w-full min-w-0 border-0 bg-transparent font-mono text-[14px] text-white outline-none"
              />
            </div>
          </div>

          <p className="m-0 mt-3 text-[12.5px] leading-4 text-[#a5a5a5]">
            Type 10 for 10 minutes, or 2:30 for 2 min 30 sec.
          </p>

          <div className="mt-[17px] flex h-[31px] items-center rounded-[12px] bg-[#1c1c1c] px-3 text-[13px] text-[#c8c8c8]">
            Processing {startTimeText} to {endTimeText || videoMeta.duration_str || 'end'}
          </div>

          {!url.trim().startsWith('/uploads/') && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-[#c8c8c8]">
              <input
                type="checkbox"
                checked={rightsConfirmed}
                onChange={(e) => {
                  setRightsConfirmed(e.target.checked);
                  if (e.target.checked) setSubmitError('');
                }}
                className="h-3.5 w-3.5 rounded border-[#3a3a3a] bg-[#181818] accent-[#3157d6]"
              />
              <span>I own the rights to this video</span>
            </label>
          )}
        </section>

        {/* 7: Layout Options */}
        <section className="mx-4 mt-[21px] rounded-[20px] border border-[#262626] bg-[#121212] px-[17px] pb-[17px] pt-4">
          <div className="flex h-5 items-center gap-[7px] text-[14px] font-medium">
            <span>Layout Options</span>
            <InfoIcon />
          </div>

          <div className="mt-2 flex h-7 items-center gap-[10px] text-[14px]">
            <svg
              className="h-[14px] w-[14px] flex-none fill-none stroke-[#aaaaaa] stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M3 12h18" />
            </svg>
            <span>Split Screen</span>
            <span className="flex h-[19px] items-center gap-1 rounded-[10px] border border-[#3a3a3a] bg-[#1a1a1a] px-[7px] text-[13px]">
              <svg
                className="h-[10px] w-[10px] flex-none fill-none stroke-current stroke-[1.7]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect x="4" y="10" width="16" height="11" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              Upgrade
            </span>
            <div className="ml-auto">
              <ToggleSwitch
                checked={splitScreen}
                onToggle={() => setSplitScreen((prev) => !prev)}
                label="Split Screen"
              />
            </div>
          </div>

          <p className="m-0 ml-[31px] mt-3 text-[13px] leading-4 text-[#a8a8a8]">
            Add engaging background videos like Subway Surfer, Minecraft, and more to boost retention.
          </p>

          <div className="ml-[6px] mt-6 flex h-4 items-center gap-[13px] text-[13px] text-[#6e6e6e]">
            <svg
              className="h-3 w-3 flex-none fill-none stroke-current stroke-[1.7]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
            <span>Aspect ratio locked to 9:16 for split-screen mode</span>
          </div>

          <div className={`transition-opacity ${splitScreen ? 'opacity-100' : 'opacity-50'}`}>
            <div className="mt-5 text-[14.5px] leading-5">Background Video</div>
            <p className="m-0 mt-[10px] text-[12.5px] leading-4 text-[#a2a2a2]">
              Select one or more - each clip gets a random pick from your selection. Leave all unselected for fully random.
            </p>

            <div className="mt-[10px] flex gap-2 overflow-hidden">
              {BG_FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setBgFilter(item)}
                  className={`flex h-7 flex-none cursor-pointer items-center gap-2 rounded-[10px] border-0 px-3 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff] ${
                    bgFilter === item
                      ? 'bg-[#1d3fa8] text-white'
                      : 'bg-[#1d1d1d] text-[#aaaaaa]'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="-ml-1 mt-[1px] h-1 w-[202px] rounded-[2px] bg-[#555555]" />

            <div className="mt-[11px] grid grid-cols-2 gap-3">
              <i
                className="block h-[79px] rounded-[10px]"
                style={{ background: 'linear-gradient(#6a3a2a,#a84a2a 40%,#3a2a2a 70%,#5a6a3a)' }}
              />
              <i
                className="block h-[79px] rounded-[10px]"
                style={{ background: 'linear-gradient(#3a8a2a,#6a7a3a 30%,#a8502a 55%,#5a3a2a)' }}
              />
            </div>
          </div>
        </section>
      </div>

      {/* Sticky Bottom Get Clips Button */}
      <div className="pointer-events-none fixed bottom-0 left-0 right-0 z-20 flex justify-center bg-gradient-to-b from-transparent via-[#0a0a0acc] to-[#0a0a0acc] pb-[calc(3px+env(safe-area-inset-bottom,0px))]">
        <div className="pointer-events-auto w-full max-w-[360px] px-4 pt-[14px]">
          {submitError && (
            <p className="mb-1.5 text-center text-[12px] text-[#fca5a5]" role="alert">
              {submitError}
            </p>
          )}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleStartClipping()}
            className="flex h-[35px] w-full cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-[#5a7ced] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[15px] text-[#dfe6ff] shadow-[0_0_14px_rgba(36,71,216,0.6)] hover:brightness-110 disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="m10 4-1.6 5.4L3 11l5.4 1.6L10 18l1.6-5.4L17 11l-5.4-1.6zM18 3l-.7 2.3L15 6l2.3.7L18 9l.7-2.3L21 6l-2.3-.7zM18 15l-.7 2.3L15 18l2.3.7L18 21l.7-2.3L21 18l-2.3-.7z" />
            </svg>
            <span>{isSubmitting ? 'Starting AI Pipeline...' : 'Get Clips'}</span>
          </button>
        </div>
      </div>

      <ScalereachSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSignOut={onSignOut}
      />
    </div>
  );
}
