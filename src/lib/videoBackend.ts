import type { InspectedVideoMeta } from '../components/ConfigurePage';

export const BACKEND_URL_STORAGE_KEY = 'scalereach_backend_url';
export const DEFAULT_LOCAL_BACKEND_URL = 'http://localhost:8080';

function isValidBackendHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]') {
    return true;
  }
  // Reject bare numeric strings (e.g. "100", "10") or single-word non-domains
  if (/^\d+$/.test(h)) return false;
  return h.includes('.');
}

export function normalizeBackendUrl(raw: string, requireExplicitProtocol = false): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (requireExplicitProtocol && !/^https?:\/\//i.test(trimmed)) {
    return '';
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!isValidBackendHost(parsed.hostname)) return '';
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, ''));
  } catch {
    return '';
  }
}

/**
 * Optional build-time PYTHON_BACKEND_URL (set via VITE_PYTHON_BACKEND_URL).
 * Strictly requires a valid http(s):// URL; invalid values (e.g. numbers/empty)
 * cleanly fall back to the same-origin `/api/*` proxy route.
 */
export const PYTHON_BACKEND_URL = normalizeBackendUrl(
  (import.meta.env.VITE_PYTHON_BACKEND_URL as string | undefined) || '',
  true,
);

export function getStoredBackendUrl(): string {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return '';
    const raw = window.localStorage.getItem(BACKEND_URL_STORAGE_KEY) || '';
    if (!raw) return '';
    const normalized = normalizeBackendUrl(raw);
    if (!normalized) {
      window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      return '';
    }
    return normalized;
  } catch {
    return '';
  }
}

export function setStoredBackendUrl(url: string): string {
  const normalized = normalizeBackendUrl(url);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (normalized) {
        window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized);
      } else {
        window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
  return normalized;
}

export function getBackendBaseUrl(): string {
  return getStoredBackendUrl() || PYTHON_BACKEND_URL;
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getBackendBaseUrl();
  return base ? `${base}${cleanPath}` : cleanPath;
}

export function resolveMediaUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getBackendBaseUrl();
  return base ? `${base}${cleanPath}` : cleanPath;
}

export interface BackendHealthResult {
  ok: boolean;
  endpoint: string;
  latencyMs: number;
  engine?: string;
  version?: string;
  pipeline?: string[];
  error?: string;
}

function isHtmlPayload(contentType: string, rawText: string): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  const trimmed = (rawText || '').trimStart();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function checkBackendHealth(customBaseUrl?: string): Promise<BackendHealthResult> {
  const base =
    customBaseUrl !== undefined ? normalizeBackendUrl(customBaseUrl) : getBackendBaseUrl();
  const endpoint = base ? `${base}/api/health` : '/api/health';
  const started = performance.now();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(endpoint, { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - started);
    const rawText = await resp.text();
    const contentType = resp.headers.get('content-type') || '';

    if (isHtmlPayload(contentType, rawText)) {
      return {
        ok: false,
        endpoint,
        latencyMs,
        error: 'Server is waking up. Please retry in a few seconds.',
      };
    }

    let data: {
      status?: string;
      engine?: string;
      version?: string;
      pipeline?: string[];
      detail?: string;
      error?: string;
    } = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText) as typeof data;
      } catch {
        data = {};
      }
    }

    if (!resp.ok || data.status !== 'ok') {
      return {
        ok: false,
        endpoint,
        latencyMs,
        error: data.detail || data.error || `HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      endpoint,
      latencyMs,
      engine: data.engine || 'fastapi-scalereach',
      version: data.version,
      pipeline: Array.isArray(data.pipeline) ? data.pipeline : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      endpoint,
      latencyMs: Math.round(performance.now() - started),
      error:
        err instanceof Error && err.name === 'AbortError'
          ? 'Connection timed out (8s).'
          : err instanceof Error
            ? err.message
            : 'Unable to reach backend server.',
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export interface BackendVideoValidationResponse {
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
  bootstrapping?: boolean;
}

export interface ValidatedVideoMetadata {
  url: string;
  videoId?: string;
  title: string;
  channelName: string;
  duration: string;
  durationSec: number;
  thumbnail: string;
  platform: string;
}

const VALIDATION_TIMEOUT_MS = 35_000;
const WARMUP_RETRY_DELAYS_MS = [1500, 2500, 4000];

export async function fetchVideoValidation(
  normalizedUrl: string,
  externalSignal?: AbortSignal,
): Promise<ValidatedVideoMetadata> {
  const controller = new AbortController();
  let didTimeout = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, VALIDATION_TIMEOUT_MS);

  try {
    const endpoint = resolveApiUrl('/api/fetch-video');
    let lastErrorMessage = 'Unable to reach the video processing backend. Please try again.';

    for (let attempt = 0; attempt <= WARMUP_RETRY_DELAYS_MS.length; attempt++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: normalizedUrl }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const contentType = response.headers.get('content-type') || '';

      // When the preview container wakes from sleep, the edge proxy briefly returns
      // HTTP 200 HTML ("Starting Server..."). Retry automatically instead of treating it as empty JSON.
      if (isHtmlPayload(contentType, rawText)) {
        lastErrorMessage =
          'Server is waking up from sleep. Please wait a few seconds and click "Get clips" again.';
        if (attempt < WARMUP_RETRY_DELAYS_MS.length) {
          await sleepWithAbort(WARMUP_RETRY_DELAYS_MS[attempt], controller.signal);
          continue;
        }
        throw new Error(lastErrorMessage);
      }

      let data: BackendVideoValidationResponse = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText) as BackendVideoValidationResponse;
        } catch {
          data = {};
        }
      }

      if (!response.ok) {
        const isTransientStartup =
          response.status === 502 || response.status === 503 || response.status === 504;
        lastErrorMessage =
          data.detail ||
          data.error ||
          (response.status === 503
            ? 'Video processing backend is starting up. Please retry in a few seconds.'
            : `Video validation failed (HTTP ${response.status}).`);

        if (isTransientStartup && attempt < WARMUP_RETRY_DELAYS_MS.length) {
          await sleepWithAbort(WARMUP_RETRY_DELAYS_MS[attempt], controller.signal);
          continue;
        }
        throw new Error(lastErrorMessage);
      }

      if (!data.url && !data.title && !data.video_id) {
        lastErrorMessage =
          'Video metadata service is warming up. Please wait a moment and try again.';
        if (attempt < WARMUP_RETRY_DELAYS_MS.length) {
          await sleepWithAbort(WARMUP_RETRY_DELAYS_MS[attempt], controller.signal);
          continue;
        }
        throw new Error(lastErrorMessage);
      }

      const durationSec =
        typeof data.duration_sec === 'number' && Number.isFinite(data.duration_sec)
          ? data.duration_sec
          : 0;
      const duration = data.duration_str || data.duration || '0:00';

      return {
        url: data.url || normalizedUrl,
        videoId: data.video_id,
        title: data.title || 'Untitled Video',
        channelName: data.channel_name || data.author || 'Video Source',
        duration,
        durationSec,
        thumbnail: data.thumbnail_url || data.thumbnail || '',
        platform: data.platform || 'Video Link',
      };
    }

    throw new Error(lastErrorMessage);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (didTimeout) {
        throw new Error('Video validation timed out. Please check the link and try again.');
      }
      throw err;
    }
    throw err instanceof Error
      ? err
      : new Error('Unable to reach the video processing backend. Please try again.');
  } finally {
    window.clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export function toInspectedVideoMeta(meta: ValidatedVideoMetadata): InspectedVideoMeta {
  return {
    url: meta.url,
    title: meta.title,
    author: meta.channelName,
    duration_sec: meta.durationSec,
    duration_str: meta.duration,
    thumbnail_url: meta.thumbnail,
    platform: meta.platform,
  };
}
