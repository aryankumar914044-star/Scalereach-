import React, { useEffect } from 'react';
import { X, Link2, Lock, Sparkles } from 'lucide-react';

interface UploadPlanModalProps {
  open: boolean;
  fileName?: string | null;
  onClose: () => void;
  onUseLinkInstead: () => void;
}

export function UploadPlanModal({ open, fileName, onClose, onUseLinkInstead }: UploadPlanModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[336px] rounded-2xl border border-[#2a2a2a] bg-[#111111] p-5 text-left shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#2a2a2a] bg-[#171717] text-[#3b6fe0]">
            <Lock className="h-4 w-4" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9c9c9c] transition-colors hover:bg-[#1c1c1c] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h3 id="upload-modal-title" className="mt-3.5 text-[15px] font-semibold text-white">
          File upload requires a paid plan
        </h3>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-[#9c9c9c]">
          {fileName
            ? `Direct upload for "${fileName}" isn’t available on the free starter tier.`
            : 'Direct device uploads are unlocked on paid plans.'}{' '}
          You can still use your <span className="text-[#22d36b]">10 free minutes</span> right now by pasting a Drive, Dropbox, YouTube, or Twitch link.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={onUseLinkInstead}
            className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#4a6ee3] bg-gradient-to-b from-[#3156d4] to-[#2748b6] px-4 text-[13px] font-medium text-[#dce5ff] transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <Link2 className="h-4 w-4" />
            <span>Paste a video link instead</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-full cursor-pointer whitespace-nowrap rounded-lg border border-[#2a2a2a] bg-[#171717] px-4 text-[12px] font-medium text-[#c5c5c5] transition-colors hover:bg-[#1f1f1f] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

interface SkipWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  onTrySample: () => void;
}

export function SkipWorkspaceModal({ open, onClose, onTrySample }: SkipWorkspaceModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="skip-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[336px] rounded-2xl border border-[#2a2a2a] bg-[#111111] p-5 text-left shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#145a30] bg-[#0a2314] text-[#22d36b]">
            <Sparkles className="h-4 w-4" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9c9c9c] transition-colors hover:bg-[#1c1c1c] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h3 id="skip-modal-title" className="mt-3.5 text-[15px] font-semibold text-white">
          Workspace is ready whenever you are
        </h3>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-[#9c9c9c]">
          Your 10 free minutes are saved to your account. Drop a video link anytime or load a sample video to test clip generation first.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={onTrySample}
            className="h-10 w-full cursor-pointer whitespace-nowrap rounded-lg border border-[#4a6ee3] bg-gradient-to-b from-[#3156d4] to-[#2748b6] px-4 text-[13px] font-medium text-[#dce5ff] transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            Load a sample video
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-full cursor-pointer whitespace-nowrap rounded-lg border border-[#2a2a2a] bg-[#171717] px-4 text-[12px] font-medium text-[#c5c5c5] transition-colors hover:bg-[#1f1f1f] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
          >
            Stay on this page
          </button>
        </div>
      </div>
    </div>
  );
}
