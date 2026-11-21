import React, { useEffect, useState } from 'react';
import {
  LogOut,
  Check,
  X,
  KeyRound,
  Webhook,
  Copy,
  Trash2,
  Send,
  Plus,
  Server,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import {
  DEFAULT_LOCAL_BACKEND_URL,
  checkBackendHealth,
  getStoredBackendUrl,
  resolveApiUrl,
  setStoredBackendUrl,
  type BackendHealthResult,
} from '../lib/videoBackend';

interface ScalereachSidebarProps {
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
  onSelectFeedback?: (message: string) => void;
}

interface WorkspaceApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at?: string | null;
  revoked: boolean;
}

interface WorkspaceWebhook {
  id: string;
  url: string;
  secret_preview?: string;
  events: string[];
  active: boolean;
  created_at: string;
}

type SidebarItemId =
  | 'home'
  | 'all-clips'
  | 'favorites'
  | 'brand-templates'
  | 'social-scheduler'
  | 'minute-usage'
  | 'minutes'
  | 'affiliate'
  | 'api-keys'
  | 'settings'
  | 'shortcuts'
  | 'get-help'
  | 'report-issue';

export function ScalereachSidebar({
  open,
  onClose,
  onSignOut,
  onSelectFeedback,
}: ScalereachSidebarProps) {
  const [activeItem, setActiveItem] = useState<SidebarItemId | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [infoModal, setInfoModal] = useState<{ title: string; body: string } | null>(null);

  // Real Workspace API Keys & Webhooks modal
  const [devModalOpen, setDevModalOpen] = useState(false);
  const [devTab, setDevTab] = useState<'keys' | 'webhooks'>('keys');
  const [apiKeys, setApiKeys] = useState<WorkspaceApiKey[]>([]);
  const [webhooks, setWebhooks] = useState<WorkspaceWebhook[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKeySecret, setCreatedKeySecret] = useState<string | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [createdWebhookSecret, setCreatedWebhookSecret] = useState<string | null>(null);
  const [devError, setDevError] = useState<string | null>(null);
  const [devStatusMsg, setDevStatusMsg] = useState<string | null>(null);
  const [devBusy, setDevBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  // Real Backend Server Settings modal (saved in localStorage for Cloud Run / localhost:8080)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [backendUrlDraft, setBackendUrlDraft] = useState(() => getStoredBackendUrl());
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);
  const [testingHealth, setTestingHealth] = useState(false);
  const [healthResult, setHealthResult] = useState<BackendHealthResult | null>(null);

  useEffect(() => {
    if (!devModalOpen) return;
    let cancelled = false;
    setDevError(null);
    Promise.all([
      fetch(resolveApiUrl('/api/workspace/api-keys')).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error('Backend unreachable'))
      ),
      fetch(resolveApiUrl('/api/workspace/webhooks')).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error('Backend unreachable'))
      ),
    ])
      .then(([keysData, hooksData]: [{ keys?: WorkspaceApiKey[] }, { webhooks?: WorkspaceWebhook[] }]) => {
        if (cancelled) return;
        setApiKeys(keysData.keys || []);
        setWebhooks(hooksData.webhooks || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setDevError(err instanceof Error ? err.message : 'Could not load developer settings.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [devModalOpen]);

  if (!open) return null;

  const handleCopySecret = async (val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 1800);
    } catch {
      // Clipboard blocked in iframe
    }
  };

  const handleCreateApiKey = async () => {
    const name = newKeyName.trim();
    if (!name || devBusy) return;
    setDevBusy(true);
    setDevError(null);
    setDevStatusMsg(null);
    try {
      const resp = await fetch(resolveApiUrl('/api/workspace/api-keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = (await resp.json().catch(() => ({}))) as WorkspaceApiKey & {
        api_key?: string;
        detail?: string;
      };
      if (!resp.ok || !data.api_key) {
        throw new Error(data.detail || 'Could not create API key.');
      }
      setCreatedKeySecret(data.api_key);
      setNewKeyName('');
      setApiKeys((prev) => [data, ...prev]);
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Could not create API key.');
    } finally {
      setDevBusy(false);
    }
  };

  const handleRevokeApiKey = async (keyId: string) => {
    setDevError(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/workspace/api-keys/${encodeURIComponent(keyId)}`), {
        method: 'DELETE',
      });
      if (!resp.ok) throw new Error('Could not revoke key.');
      setApiKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, revoked: true } : k)));
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Could not revoke key.');
    }
  };

  const handleCreateWebhook = async () => {
    const url = newWebhookUrl.trim();
    if (!url || devBusy) return;
    setDevBusy(true);
    setDevError(null);
    setDevStatusMsg(null);
    try {
      const resp = await fetch(resolveApiUrl('/api/workspace/webhooks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events: ['job.completed', 'job.failed'] }),
      });
      const data = (await resp.json().catch(() => ({}))) as WorkspaceWebhook & {
        secret?: string;
        detail?: string;
      };
      if (!resp.ok) {
        throw new Error(data.detail || 'Could not register webhook.');
      }
      setCreatedWebhookSecret(data.secret || null);
      setNewWebhookUrl('');
      setWebhooks((prev) => [data, ...prev]);
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Could not register webhook.');
    } finally {
      setDevBusy(false);
    }
  };

  const handleDeleteWebhook = async (webhookId: string) => {
    setDevError(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/workspace/webhooks/${encodeURIComponent(webhookId)}`), {
        method: 'DELETE',
      });
      if (!resp.ok) throw new Error('Could not delete webhook.');
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Could not delete webhook.');
    }
  };

  const handleTestWebhook = async (webhookId: string) => {
    setDevBusy(true);
    setDevError(null);
    setDevStatusMsg(null);
    try {
      const resp = await fetch(resolveApiUrl(`/api/workspace/webhooks/${encodeURIComponent(webhookId)}/test`), {
        method: 'POST',
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        status_code?: number;
        error?: string;
      };
      if (data.ok) {
        setDevStatusMsg(`Test webhook delivered (HTTP ${data.status_code ?? 200}).`);
      } else {
        setDevError(
          data.error
            ? `Webhook test failed: ${data.error}`
            : `Webhook endpoint returned HTTP ${data.status_code ?? 0}.`
        );
      }
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Webhook test failed.');
    } finally {
      setDevBusy(false);
    }
  };

  const handleSaveBackendSettings = () => {
    const saved = setStoredBackendUrl(backendUrlDraft);
    setBackendUrlDraft(saved);
    setSettingsSavedMsg(
      saved
        ? `Saved Backend Server URL: ${saved}`
        : 'Saved: using built-in same-origin backend proxy.'
    );
    onSelectFeedback?.(
      saved ? `Backend set to ${saved}` : 'Backend reset to built-in proxy'
    );
  };

  const handleTestBackendHealth = async (urlOverride?: string) => {
    setTestingHealth(true);
    setHealthResult(null);
    try {
      const target = urlOverride !== undefined ? urlOverride : backendUrlDraft;
      const res = await checkBackendHealth(target);
      setHealthResult(res);
    } finally {
      setTestingHealth(false);
    }
  };

  const handleItemClick = (id: SidebarItemId, label: string) => {
    setActiveItem(id);
    setProfileMenuOpen(false);
    setWorkspaceMenuOpen(false);

    if (id === 'home') {
      onSelectFeedback?.('Switched to Home');
      onClose();
      return;
    }

    if (id === 'api-keys') {
      setCreatedKeySecret(null);
      setCreatedWebhookSecret(null);
      setDevError(null);
      setDevStatusMsg(null);
      setDevModalOpen(true);
      return;
    }

    if (id === 'settings') {
      setBackendUrlDraft(getStoredBackendUrl());
      setSettingsSavedMsg(null);
      setHealthResult(null);
      setSettingsModalOpen(true);
      return;
    }

    setInfoModal({
      title: label,
      body:
        id === 'minutes' || id === 'minute-usage'
          ? 'Your workspace minute balance and usage breakdown are active. Connect YouTube or upgrade to unlock 400 min/month.'
          : id === 'shortcuts'
            ? 'Space: Play/Pause · J/L: Seek 5s · C: Split clip · Cmd/Ctrl+Enter: Export clips.'
            : id === 'report-issue'
              ? 'Need to report a bug? Our team reviews workspace issue reports within 24 hours.'
              : `${label} is selected in your Panda's workspace.`,
    });
  };

  const itemClass = (id: SidebarItemId, extra = '') =>
    `flex h-[34px] w-full cursor-pointer items-center gap-[8px] rounded-[8px] border-0 pr-[8px] pl-0 text-left text-[13.5px] transition-colors hover:bg-[#1b1b1b] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8aa6ff] ${
      activeItem === id ? 'bg-[#1b1b1b]' : 'bg-transparent'
    } ${extra}`;

  return (
    <div
      className="fixed inset-0 z-30 mx-auto max-w-[360px]"
      role="dialog"
      aria-modal="true"
      aria-label="Sidebar"
    >
      {/* Clickable blurred right backdrop matching .bk */}
      <div
        onClick={onClose}
        aria-label="Close sidebar"
        className="absolute inset-y-0 left-[269px] right-0 cursor-pointer bg-black/25"
      />

      <nav
        aria-label="Sidebar"
        className="absolute bottom-0 left-0 top-0 flex w-[269px] flex-col overflow-y-auto border-r border-[#1d1d1d] bg-[#121212] px-[8px] pt-[15px] text-[#f1f1f1] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Workspace Switcher (.ws) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setWorkspaceMenuOpen((prev) => !prev);
              setProfileMenuOpen(false);
            }}
            className="mb-[21px] ml-0 flex h-[32px] w-full cursor-pointer items-center gap-[8px] border-0 bg-transparent p-0 pr-[8px] text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8aa6ff]"
          >
            <span className="grid h-[32px] w-[32px] flex-none place-items-center rounded-[8px] bg-[#1d4ed8]">
              <svg
                className="h-[16px] w-[16px] fill-none stroke-white stroke-[1.6]"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect x="4" y="2" width="16" height="20" rx="2" />
                <path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
              </svg>
            </span>
            <span className="flex-1 leading-[1.15]">
              <b className="block text-[14px] font-medium">Panda&apos;s</b>
              <span className="text-[12px]">Owner</span>
            </span>
            <svg
              className="mr-[4px] h-[14px] w-[14px] flex-none fill-none stroke-current stroke-[1.6]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m7 6 5 5 5-5M7 13l5 5 5-5" />
            </svg>
          </button>

          {workspaceMenuOpen && (
            <div className="mb-3 rounded-[10px] border border-[#2a2a2a] bg-[#181818] p-1.5 text-[12px]">
              <div className="flex items-center justify-between rounded-md bg-[#222222] px-2.5 py-1.5 text-white">
                <span>Panda&apos;s Workspace</span>
                <Check className="h-3.5 w-3.5 text-[#3b6ef0]" />
              </div>
            </div>
          )}
        </div>

        {/* Top Items */}
        <button
          type="button"
          onClick={() => handleItemClick('home', 'Home')}
          className={itemClass('home', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
          </svg>
          <span className="flex-1">Home</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('all-clips', 'All Clips')}
          className={itemClass('all-clips', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
          </svg>
          <span className="flex-1">All Clips</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('favorites', 'Favorites')}
          className={itemClass('favorites', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <span className="flex-1">Favorites</span>
        </button>

        {/* Tools Label */}
        <div className="mb-[5px] mt-[29px] flex h-[20px] items-center text-[13px] text-[#9a9a9a]">
          Tools
        </div>

        <button
          type="button"
          onClick={() => handleItemClick('brand-templates', 'Brand Templates')}
          className={itemClass('brand-templates', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="16" height="6" rx="2" />
            <path d="M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="8" y="16" width="4" height="6" rx="1" />
          </svg>
          <span className="flex-1">Brand Templates</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('social-scheduler', 'Social Scheduler')}
          className={itemClass('social-scheduler', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
            <path d="M14 3h7v7M21 3l-9 9" />
          </svg>
          <span className="flex-1">Social Scheduler</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('minute-usage', 'Minute Usage')}
          className={itemClass('minute-usage', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span className="flex-1">Minute Usage</span>
        </button>

        <div className="h-[11px] flex-none" />

        <button
          type="button"
          onClick={() => handleItemClick('minutes', 'Minutes')}
          className={itemClass('minutes', 'text-[#f59e0b]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span className="flex-1">Minutes</span>
          <span className="inline-flex h-[20px] items-center rounded-[7px] border border-[#7a5208] bg-[#2b1e07] px-[6px] text-[12px] leading-none text-[#f59e0b]">
            0 min
          </span>
        </button>

        <button
          type="button"
          onClick={() =>
            setInfoModal({
              title: 'Unlock more minutes',
              body: 'Upgrade to Pro for 400 min/month, watermark-free exports, and priority AI clip rendering.',
            })
          }
          className="my-[6px] mb-[5px] flex h-[49px] w-full flex-none cursor-pointer items-center gap-[7px] rounded-[14px] border border-[#1f2c63] bg-[#0f1426] px-[8px] text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8aa6ff]"
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-[#3b6ef0] stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m14 3-1.6 5a2 2 0 0 1-1.4 1.4L6 11l5 1.6a2 2 0 0 1 1.4 1.4L14 19l1.6-5a2 2 0 0 1 1.4-1.4L22 11l-5-1.6A2 2 0 0 1 15.6 8z" />
            <path d="m6 14-.8 2.2L3 17l2.2.8L6 20l.8-2.2L9 17l-2.2-.8z" />
          </svg>
          <span>
            <b className="block text-[13px] font-normal leading-[1.2] text-[#3b6ef0]">
              Unlock more minutes
            </b>
            <span className="text-[12px] text-[#a2a2a2]">400 min/month, no watermark</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('affiliate', 'Affiliate')}
          className={itemClass('affiliate', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect x="3" y="8" width="18" height="4" rx="1" />
            <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
            <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
          </svg>
          <span className="flex-1">Affiliate</span>
          <span className="inline-flex h-[20px] items-center rounded-[7px] border border-[#0e6b3a] bg-[#0a2a1a] px-[6px] text-[11.5px] leading-none text-[#22c55e]">
            New
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('api-keys', 'API Keys')}
          className={itemClass('api-keys', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
          </svg>
          <span className="flex-1">API Keys</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('settings', 'Settings')}
          className={itemClass('settings', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="flex-1">Settings</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('shortcuts', 'Shortcuts')}
          className={itemClass('shortcuts', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect x="2" y="8" width="20" height="13" rx="2" />
            <path d="M12 8V4M9 4h6M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 17h8" />
          </svg>
          <span className="flex-1">Shortcuts</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('get-help', 'Get Help')}
          className={itemClass('get-help', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
          </svg>
          <span className="flex-1">Get Help</span>
        </button>

        <button
          type="button"
          onClick={() => handleItemClick('report-issue', 'Report Issue')}
          className={itemClass('report-issue', 'text-[#f1f1f1]')}
        >
          <svg
            className="h-[16px] w-[16px] flex-none fill-none stroke-current stroke-[1.6]"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">Report Issue</span>
        </button>

        {/* Bottom Profile (.me) */}
        <div className="mt-auto pt-3">
          {profileMenuOpen && (
            <div className="mb-2 rounded-[10px] border border-[#2a2a2a] bg-[#181818] p-1.5">
              <button
                type="button"
                onClick={() => {
                  setProfileMenuOpen(false);
                  onClose();
                  onSignOut();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] text-[#f1f1f1] transition-colors hover:bg-[#242424]"
              >
                <LogOut className="h-3.5 w-3.5 text-[#9a9a9a]" />
                <span>Sign out</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setProfileMenuOpen((prev) => !prev);
              setWorkspaceMenuOpen(false);
            }}
            className="mb-[13px] flex h-[32px] w-full cursor-pointer items-center gap-[8px] border-0 bg-transparent p-0 pr-[8px] text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8aa6ff]"
          >
            <span className="grid h-[32px] w-[32px] flex-none place-items-center rounded-full bg-[#1d4ed8] text-[15px] text-white">
              P
            </span>
            <span className="min-w-0 flex-1 leading-[1.15]">
              <b className="block truncate text-[14px] font-medium">Panda Kumar</b>
              <span className="block truncate whitespace-nowrap text-[12px] text-[#e8e8e8]">
                pandakumar8752@gmail.com
              </span>
            </span>
            <svg
              className="mr-[4px] h-[14px] w-[14px] flex-none fill-none stroke-current stroke-[1.6]"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m7 6 5 5 5-5M7 13l5 5 5-5" />
            </svg>
          </button>
        </div>
      </nav>

      {devModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Workspace API Keys and Webhooks"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-[2px]"
          onClick={() => setDevModalOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-[336px] overflow-y-auto rounded-2xl border border-[#2a2a2a] bg-[#121212] p-4 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[14.5px] font-semibold text-white">API Keys &amp; Webhooks</h3>
              <button
                type="button"
                onClick={() => setDevModalOpen(false)}
                aria-label="Close developer dialog"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9a9a9a] hover:bg-[#1e1e1e] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 flex gap-1.5 rounded-[10px] border border-[#262626] bg-[#0b0b0b] p-1">
              <button
                type="button"
                onClick={() => setDevTab('keys')}
                className={`flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] text-[12px] font-medium ${
                  devTab === 'keys' ? 'bg-[#1e3575] text-white' : 'text-[#9d9d9d] hover:text-white'
                }`}
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>API Keys</span>
              </button>
              <button
                type="button"
                onClick={() => setDevTab('webhooks')}
                className={`flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] text-[12px] font-medium ${
                  devTab === 'webhooks' ? 'bg-[#1e3575] text-white' : 'text-[#9d9d9d] hover:text-white'
                }`}
              >
                <Webhook className="h-3.5 w-3.5" />
                <span>Webhooks</span>
              </button>
            </div>

            {devError && (
              <div className="mt-2.5 rounded-[10px] border border-[#5f1e1e] bg-[#2a1010] px-3 py-2 text-[12px] text-[#fca5a5]">
                {devError}
              </div>
            )}
            {devStatusMsg && (
              <div className="mt-2.5 rounded-[10px] border border-[#145a30] bg-[#0a2314] px-3 py-2 text-[12px] text-[#4ade80]">
                {devStatusMsg}
              </div>
            )}

            {devTab === 'keys' ? (
              <div className="mt-3 space-y-3">
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key label (e.g. Zapier Automation)"
                    className="h-9 flex-1 rounded-[9px] border border-[#2e2e2e] bg-[#181818] px-2.5 text-[12.5px] text-white placeholder-[#767676] focus:border-[#4a6ee3] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={devBusy || !newKeyName.trim()}
                    onClick={() => void handleCreateApiKey()}
                    className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-[9px] border border-[#4a6ee3] bg-[#2547b5] px-2.5 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Create</span>
                  </button>
                </div>

                {createdKeySecret && (
                  <div className="rounded-[10px] border border-[#145a30] bg-[#0a2314] p-2.5 text-[11.5px]">
                    <div className="font-medium text-[#4ade80]">Copy your workspace key now (shown once):</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <code className="flex-1 truncate rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-white">
                        {createdKeySecret}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopySecret(createdKeySecret)}
                        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-[#1d6e3e] bg-[#113a22] px-2 text-[11px] text-[#bbf7d0]"
                      >
                        {copiedToken ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {apiKeys.length === 0 ? (
                    <p className="m-0 text-center text-[12px] text-[#7a7a7a]">
                      No workspace API keys created yet.
                    </p>
                  ) : (
                    apiKeys.map((k) => (
                      <div
                        key={k.id}
                        className="flex items-center justify-between gap-2 rounded-[10px] border border-[#242424] bg-[#171717] px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium text-white">{k.name}</div>
                          <div className="font-mono text-[11px] text-[#8d8d8d]">
                            {k.key_prefix}… · {k.revoked ? 'Revoked' : 'Active'}
                          </div>
                        </div>
                        {!k.revoked && (
                          <button
                            type="button"
                            onClick={() => void handleRevokeApiKey(k.id)}
                            className="cursor-pointer rounded-md border border-[#4a2222] bg-[#2a1212] px-2 py-1 text-[11px] text-[#fca5a5] hover:bg-[#3a1818]"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <p className="m-0 text-[11.5px] leading-[1.45] text-[#9a9a9a]">
                  Receive signed <code className="text-[#d4d4d4]">job.completed</code> and{' '}
                  <code className="text-[#d4d4d4]">job.failed</code> HTTP POST callbacks.
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="url"
                    value={newWebhookUrl}
                    onChange={(e) => setNewWebhookUrl(e.target.value)}
                    placeholder="https://example.com/webhooks/scalereach"
                    className="h-9 flex-1 rounded-[9px] border border-[#2e2e2e] bg-[#181818] px-2.5 text-[12px] text-white placeholder-[#767676] focus:border-[#4a6ee3] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={devBusy || !newWebhookUrl.trim()}
                    onClick={() => void handleCreateWebhook()}
                    className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-[9px] border border-[#4a6ee3] bg-[#2547b5] px-2.5 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add</span>
                  </button>
                </div>

                {createdWebhookSecret && (
                  <div className="rounded-[10px] border border-[#145a30] bg-[#0a2314] p-2.5 text-[11.5px]">
                    <div className="font-medium text-[#4ade80]">HMAC signing secret (shown once):</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <code className="flex-1 truncate rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-white">
                        {createdWebhookSecret}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopySecret(createdWebhookSecret)}
                        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-[#1d6e3e] bg-[#113a22] px-2 text-[11px] text-[#bbf7d0]"
                      >
                        {copiedToken ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {webhooks.length === 0 ? (
                    <p className="m-0 text-center text-[12px] text-[#7a7a7a]">
                      No webhooks configured yet.
                    </p>
                  ) : (
                    webhooks.map((wh) => (
                      <div
                        key={wh.id}
                        className="rounded-[10px] border border-[#242424] bg-[#171717] p-2.5"
                      >
                        <div className="truncate text-[12px] font-medium text-white">{wh.url}</div>
                        <div className="mt-0.5 text-[11px] text-[#8d8d8d]">
                          Events: {(wh.events || []).join(', ')}
                        </div>
                        <div className="mt-2 flex gap-1.5">
                          <button
                            type="button"
                            disabled={devBusy}
                            onClick={() => void handleTestWebhook(wh.id)}
                            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-[#2f4da3] bg-[#152552] px-2 text-[11px] text-[#dce5ff] hover:bg-[#1e3470]"
                          >
                            <Send className="h-3 w-3" />
                            <span>Send Test</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteWebhook(wh.id)}
                            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-[#4a2222] bg-[#2a1212] px-2 text-[11px] text-[#fca5a5] hover:bg-[#3a1818]"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {settingsModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Backend Server Settings"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-[2px]"
          onClick={() => setSettingsModalOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-[336px] overflow-y-auto rounded-2xl border border-[#2a2a2a] bg-[#121212] p-4 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[#4f80ff]" />
                <h3 className="text-[14.5px] font-semibold text-white">Server Settings</h3>
              </div>
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                aria-label="Close server settings"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9a9a9a] hover:bg-[#1e1e1e] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="m-0 mt-2 text-[12px] leading-[1.45] text-[#9d9d9d]">
              Point ScaleReach to your Google Cloud Run service or local Docker backend (default{' '}
              <code className="text-[#d4d4d4]">{DEFAULT_LOCAL_BACKEND_URL}</code>). Leave blank to use the built-in proxy.
            </p>

            <label className="mt-3 block text-[11.5px] font-medium text-[#b8b8b8]">
              Backend Server URL
            </label>
            <input
              type="url"
              value={backendUrlDraft}
              onChange={(e) => {
                setBackendUrlDraft(e.target.value);
                setSettingsSavedMsg(null);
              }}
              placeholder="https://your-service-xxxx.a.run.app"
              className="mt-1 h-9 w-full rounded-[9px] border border-[#2e2e2e] bg-[#181818] px-2.5 text-[12.5px] text-white placeholder-[#6f6f6f] focus:border-[#4a6ee3] focus:outline-none"
            />

            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setBackendUrlDraft('');
                  setSettingsSavedMsg(null);
                }}
                className={`h-7 flex-1 cursor-pointer rounded-[8px] border text-[11.5px] font-medium ${
                  !backendUrlDraft
                    ? 'border-[#4a6ee3] bg-[#18295c] text-white'
                    : 'border-[#2b2b2b] bg-[#181818] text-[#b0b0b0] hover:text-white'
                }`}
              >
                Built-in Proxy
              </button>
              <button
                type="button"
                onClick={() => {
                  setBackendUrlDraft(DEFAULT_LOCAL_BACKEND_URL);
                  setSettingsSavedMsg(null);
                }}
                className={`h-7 flex-1 cursor-pointer rounded-[8px] border text-[11.5px] font-medium ${
                  backendUrlDraft === DEFAULT_LOCAL_BACKEND_URL
                    ? 'border-[#4a6ee3] bg-[#18295c] text-white'
                    : 'border-[#2b2b2b] bg-[#181818] text-[#b0b0b0] hover:text-white'
                }`}
              >
                localhost:8080
              </button>
            </div>

            {settingsSavedMsg && (
              <div className="mt-2.5 rounded-[10px] border border-[#145a30] bg-[#0a2314] px-3 py-2 text-[11.5px] text-[#4ade80]">
                {settingsSavedMsg}
              </div>
            )}

            {healthResult && (
              <div
                className={`mt-2.5 rounded-[10px] border px-3 py-2 text-[11.5px] ${
                  healthResult.ok
                    ? 'border-[#145a30] bg-[#0a2314] text-[#bbf7d0]'
                    : 'border-[#5f1e1e] bg-[#2a1010] text-[#fca5a5]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {healthResult.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#4ade80]" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#f87171]" />
                  )}
                  <span>
                    {healthResult.ok
                      ? `Connected (${healthResult.latencyMs}ms)`
                      : `Connection failed (${healthResult.error})`}
                  </span>
                </div>
                {healthResult.ok && healthResult.pipeline && (
                  <div className="mt-1 text-[11px] text-[#86efac]">
                    Engines: {healthResult.pipeline.join(' · ')}
                  </div>
                )}
              </div>
            )}

            <div className="mt-3.5 flex gap-2">
              <button
                type="button"
                disabled={testingHealth}
                onClick={() => void handleTestBackendHealth()}
                className="inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-[#333333] bg-[#181818] text-[12.5px] font-medium text-[#e0e0e0] hover:bg-[#222222] disabled:opacity-60"
              >
                {testingHealth && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{testingHealth ? 'Testing…' : 'Test Connection'}</span>
              </button>
              <button
                type="button"
                onClick={handleSaveBackendSettings}
                className="h-9 flex-1 cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-gradient-to-b from-[#3157d6] to-[#2547b5] text-[12.5px] font-medium text-white hover:brightness-110"
              >
                Save URL
              </button>
            </div>
          </div>
        </div>
      )}

      {infoModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={infoModal.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setInfoModal(null)}
        >
          <div
            className="w-full max-w-[320px] rounded-2xl border border-[#2a2a2a] bg-[#121212] p-4 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-white">{infoModal.title}</h3>
              <button
                type="button"
                onClick={() => setInfoModal(null)}
                aria-label="Close dialog"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9a9a9a] hover:bg-[#1e1e1e] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-[12.5px] leading-[1.5] text-[#a2a2a2]">{infoModal.body}</p>
            <button
              type="button"
              onClick={() => setInfoModal(null)}
              className="mt-3.5 h-9 w-full cursor-pointer rounded-[10px] border border-[#4a6ee3] bg-[#2547b5] text-[13px] font-medium text-white hover:brightness-110"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
