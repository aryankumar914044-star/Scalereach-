import React from 'react';

export interface PlatformItem {
  id: string;
  name: string;
  exampleUrl: string;
  renderIcon: () => React.ReactNode;
}

export const SUPPORTED_PLATFORMS: PlatformItem[] = [
  {
    id: 'private',
    name: 'Private / Protected links',
    exampleUrl: 'https://vimeo.com/123456789',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M3 5V4a3 3 0 0 1 6 0v1h1v6H2V5zm1 0h4V4a2 2 0 0 0-4 0z" />
      </svg>
    ),
  },
  {
    id: 'twitch',
    name: 'Twitch',
    exampleUrl: 'https://www.twitch.tv/videos/2145678901',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M1 1h10v7H7l-2 3V8H1z" />
      </svg>
    ),
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    exampleUrl: 'https://x.com/scalereach/status/1800000000000000000',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M2 1h2v4l4-4h2.5L6 6l5 5H8.5L4 6.5V11H2z" />
      </svg>
    ),
  },
  {
    id: 'drive',
    name: 'Google Drive',
    exampleUrl: 'https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/view',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M4 1h4l4 7-2 3H2L0 8z" />
      </svg>
    ),
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    exampleUrl: 'https://www.dropbox.com/s/sample123/keynote-cut.mp4',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M3 1 6 3 3 5 0 3zM9 1l3 2-3 2-3-2zM3 7l3 2-3 2-3-2zM9 7l3 2-3 2-3-2z" />
      </svg>
    ),
  },
  {
    id: 'zoom',
    name: 'Zoom',
    exampleUrl: 'https://zoom.us/rec/share/sample-recording-link',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <circle cx="6" cy="6" r="2" />
        <path d="M5.5 0h1v2.5h-1zM5.5 9.5h1V12h-1zM0 5.5h2.5v1H0zM9.5 5.5H12v1H9.5z" />
      </svg>
    ),
  },
  {
    id: 'loom',
    name: 'Loom',
    exampleUrl: 'https://www.loom.com/share/sample-walkthrough-id',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <circle cx="6" cy="6" r="6" />
      </svg>
    ),
  },
  {
    id: 'patreon',
    name: 'Patreon',
    exampleUrl: 'https://www.patreon.com/posts/sample-episode-998877',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M2 2h5a3 3 0 0 1 0 6H4v3H2z" />
      </svg>
    ),
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    exampleUrl: 'https://vimeo.com/76979871',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <circle cx="6" cy="6" r="6" />
      </svg>
    ),
  },
  {
    id: 'streamyard',
    name: 'StreamYard / Riverside',
    exampleUrl: 'https://riverside.fm/studio/sample-episode',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <path d="M1 3h10v2H1zM1 7h10v2H1z" />
      </svg>
    ),
  },
  {
    id: 'podcast',
    name: 'Podcasts / Direct Audio-Video',
    exampleUrl: 'https://cdn.example.com/episodes/podcast-ep12.mp4',
    renderIcon: () => (
      <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
        <circle cx="6" cy="7" r="4" />
        <path d="M3 1l1 3M9 1 8 4" />
      </svg>
    ),
  },
];

export function ScalereachLogo() {
  return (
    <div className="mt-1 flex h-[30px] items-center justify-center gap-2">
      <span className="grid h-[30px] w-[30px] place-items-center rounded-[7px] bg-gradient-to-br from-[#3f6cf0] to-[#2447b5]">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#d5ddff" aria-hidden="true">
          <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
        </svg>
      </span>
      <span className="text-[12px] font-semibold tracking-[0.1px] text-white">scalereach</span>
    </div>
  );
}

export function YouTubeBadge() {
  return (
    <span
      className="relative inline-block h-[10px] w-[14px] rounded-[3px] bg-[#ff0000]"
      aria-label="YouTube"
      title="YouTube"
    >
      <span
        className="absolute left-[5px] top-[2px] h-0 w-0 border-b-[3px] border-l-[4px] border-t-[3px] border-b-transparent border-l-white border-t-transparent"
        aria-hidden="true"
      />
    </span>
  );
}
