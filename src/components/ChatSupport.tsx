import React, { useState, useRef, useEffect } from 'react';
import { X, Send } from 'lucide-react';

interface ChatMessage {
  id: string;
  sender: 'support' | 'user';
  text: string;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'welcome',
    sender: 'support',
    text: 'Hi! Need help dropping your first video link or using your 10 free minutes?',
  },
];

const QUICK_TOPICS: { label: string; reply: string }[] = [
  {
    label: 'Supported links',
    reply: 'You can paste links from YouTube, Twitch, Google Drive, Dropbox, Zoom, Loom, Vimeo, or direct .mp4/.mov URLs.',
  },
  {
    label: '10 free minutes',
    reply: 'Your 10 free minutes are already active on this workspace. Simply paste any video link and click "Get clips in 1 click".',
  },
  {
    label: 'File upload plan',
    reply: 'Direct local file uploads require a paid plan, but public or shared cloud links (Drive, Dropbox, YouTube) work free right now.',
  },
];

interface ChatSupportProps {
  isAuthenticated: boolean;
  onRequireAuth: () => void;
  buttonClassName?: string;
}

export function ChatSupport({ isAuthenticated, onRequireAuth, buttonClassName }: ChatSupportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isAuthenticated && isOpen) {
      setIsOpen(false);
    }
  }, [isAuthenticated, isOpen]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const sendQuestion = async (questionText: string, presetReply?: string) => {
    const trimmed = questionText.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: trimmed,
    };

    setMessages((prev) => [...prev, userMsg]);
    setDraft('');

    if (presetReply) {
      const supportMsg: ChatMessage = {
        id: `s-${Date.now() + 1}`,
        sender: 'support',
        text: presetReply,
      };
      setMessages((prev) => [...prev, supportMsg]);
      return;
    }

    let replyText =
      'Thanks for reaching out! Paste a video link in the box on the left or try a sample video to preview your first clips.';
    try {
      const resp = await fetch('/api/support/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = (await resp.json().catch(() => ({}))) as { reply?: string; error?: string };
      if (resp.ok && data.reply) {
        replyText = data.reply;
      } else if (data.error) {
        replyText = data.error;
      }
    } catch {
      // Fallback to default message
    }

    const supportMsg: ChatMessage = {
      id: `s-${Date.now() + 1}`,
      sender: 'support',
      text: replyText,
    };
    setMessages((prev) => [...prev, supportMsg]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendQuestion(draft);
  };

  const handleToggle = () => {
    if (!isAuthenticated) {
      onRequireAuth();
      return;
    }
    setIsOpen((prev) => !prev);
  };

  return (
    <>
      {isOpen && isAuthenticated && (
        <div
          role="dialog"
          aria-label="Scalereach support chat"
          className="fixed bottom-[106px] right-[max(11px,calc(50%-169px))] z-40 w-[330px] max-w-[calc(100vw-22px)] overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#111111] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
            <div>
              <h3 className="text-[13px] font-semibold text-white">Scalereach Support</h3>
              <p className="text-[11px] text-[#9c9c9c]">Onboarding help</p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close support chat"
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#9c9c9c] transition-colors hover:bg-[#1e1e1e] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={listRef} className="max-h-[220px] space-y-2.5 overflow-y-auto px-4 py-3 text-left">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-xl px-3 py-2 text-[12px] leading-[1.45] ${
                  msg.sender === 'user'
                    ? 'ml-6 bg-[#2748b6] text-white'
                    : 'mr-4 border border-[#242424] bg-[#171717] text-[#e5e5e5]'
                }`}
              >
                {msg.text}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5 border-t border-[#202020] px-4 py-2.5">
            {QUICK_TOPICS.map((topic) => (
              <button
                key={topic.label}
                type="button"
                onClick={() => sendQuestion(topic.label, topic.reply)}
                className="cursor-pointer whitespace-nowrap rounded-md border border-[#2a2a2a] bg-[#171717] px-2.5 py-1 text-[11px] text-[#c7d4ff] transition-colors hover:border-[#3b6fe0] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
              >
                {topic.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-[#242424] bg-[#141414] px-3 py-2.5">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a question..."
              aria-label="Ask support a question"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-white placeholder-[#7a7a7a] outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send message"
              className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg bg-[#1a6cf5] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={handleToggle}
        aria-label={isOpen ? 'Close chat support' : 'Chat support'}
        aria-expanded={isOpen}
        className={
          buttonClassName ??
          'fixed bottom-[calc(46px+env(safe-area-inset-bottom,0px))] right-[max(11px,calc(50%-169px))] z-40 grid h-[50px] w-[50px] cursor-pointer place-items-center rounded-full border-0 bg-[#1a6cf5] shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8aa6ff]'
        }
      >
        {isOpen ? (
          <X className="h-6 w-6 text-white" />
        ) : (
          <svg viewBox="0 0 24 24" className="h-[30px] w-[30px] fill-white" aria-hidden="true">
            <path d="M3 4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6l-3 4v-4H5a2 2 0 0 1-2-2z" />
          </svg>
        )}
      </button>
    </>
  );
}
