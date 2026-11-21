import React, { useState } from 'react';
import { Eye, EyeOff, ArrowLeft, X, CheckCircle2 } from 'lucide-react';

export interface AuthUser {
  identity: string;
  provider: 'email' | 'google';
}

interface LoginPageProps {
  reason?: string | null;
  onSuccess: (user: AuthUser, remember: boolean) => void;
  onBack?: () => void;
}

type AuthMode = 'signin' | 'signup';
type LegalDoc = 'Terms and Conditions' | 'Privacy Policy' | 'Affiliate Agreement' | null;

export function LoginPage({ reason, onSuccess, onBack }: LoginPageProps) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);

  const [googleOpen, setGoogleOpen] = useState(false);
  const [customGoogleEmail, setCustomGoogleEmail] = useState('');
  const [legalDoc, setLegalDoc] = useState<LegalDoc>(null);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedIdentity = identity.trim();

    if (!trimmedIdentity || !password) {
      setError('Enter your email or username and password.');
      return;
    }

    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: trimmedIdentity, password, provider: 'email' }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string; user?: AuthUser };
      if (!resp.ok) {
        setError(data.error || 'Unable to sign in.');
        return;
      }
      onSuccess(data.user || { identity: trimmedIdentity, provider: 'email' }, remember);
    } catch {
      onSuccess({ identity: trimmedIdentity, provider: 'email' }, remember);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async (email: string) => {
    const clean = email.trim();
    if (!clean) return;
    setGoogleOpen(false);
    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: clean, provider: 'google' }),
      });
      const data = (await resp.json().catch(() => ({}))) as { user?: AuthUser };
      onSuccess(data.user || { identity: clean, provider: 'google' }, true);
    } catch {
      onSuccess({ identity: clean, provider: 'google' }, true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) return;
    setResetSent(true);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[#0a0a0a] p-6 text-[#f5f5f5]">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="fixed left-4 top-4 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#2e2e32] bg-[#141414] px-3 py-1.5 text-[13px] text-[#8d8d94] transition-colors hover:border-[#45454b] hover:text-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </button>
      )}

      <main className="w-full max-w-[400px]">
        <div
          className="mx-auto mb-7 grid h-12 w-12 place-items-center rounded-[12px] bg-gradient-to-br from-[#3d63e0] to-[#2a49b8]"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-[26px] w-[26px]">
            <path d="M13 2 5 13h6l-1 9 9-12h-6l0-8Z" fill="#fff" fillOpacity=".85" />
          </svg>
        </div>

        <h1 className="text-center text-[2rem] font-bold leading-tight tracking-[-0.03em] text-[#f5f5f5]">
          {mode === 'signin' ? 'Welcome back' : 'Create account'}
        </h1>
        <p className="mb-8 mt-[10px] text-center text-[1.05rem] text-[#8d8d94]">
          {reason
            ? `Sign in to continue (${reason})`
            : mode === 'signin'
              ? 'Sign in to your account to continue'
              : 'Sign up to start generating clips'}
        </p>

        <form onSubmit={handleFormSubmit} noValidate>
          <div className="mb-5">
            <label htmlFor="identity" className="mb-2 block text-[0.95rem] text-[#f5f5f5]">
              Email or Username
            </label>
            <input
              id="identity"
              name="identity"
              type="text"
              value={identity}
              onChange={(e) => {
                setIdentity(e.target.value);
                if (error) setError('');
              }}
              placeholder="you@example.com or username"
              autoComplete="username"
              required
              className="h-[50px] w-full rounded-[10px] border border-[#2e2e32] bg-[#141414] px-4 text-[1rem] text-[#f5f5f5] placeholder-[#77777e] transition-[border-color,box-shadow] duration-150 focus:border-[#6a6a72] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.12)] focus:outline-none"
            />
          </div>

          <div className="mb-5">
            <label htmlFor="password" className="mb-2 block text-[0.95rem] text-[#f5f5f5]">
              Password
            </label>
            <div className="flex gap-2">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                placeholder={mode === 'signin' ? 'Enter your password' : 'Create a password'}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                className="h-[50px] w-full flex-1 rounded-[10px] border border-[#2e2e32] bg-[#141414] px-4 text-[1rem] text-[#f5f5f5] placeholder-[#77777e] transition-[border-color,box-shadow] duration-150 focus:border-[#6a6a72] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.12)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="grid h-[50px] w-[50px] flex-none cursor-pointer place-items-center rounded-[10px] border border-[#2e2e32] bg-[#141414] text-[#f5f5f5] transition-colors hover:bg-[#1c1c1f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
              >
                {showPassword ? <EyeOff className="h-[22px] w-[22px]" /> : <Eye className="h-[22px] w-[22px]" />}
              </button>
            </div>
          </div>

          <div className="mb-6 mt-1 flex items-center justify-between text-[0.95rem]">
            <label className="m-0 flex cursor-pointer items-center gap-2.5 text-[#f5f5f5]">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="relative h-[22px] w-[22px] cursor-pointer appearance-none rounded-[6px] border border-[#2e2e32] bg-[#141414] transition-colors checked:border-[#2f56d6] checked:bg-[#2f56d6] checked:after:absolute checked:after:left-[7px] checked:after:top-[3px] checked:after:h-[11px] checked:after:w-[6px] checked:after:rotate-45 checked:after:border-b-2 checked:after:border-r-2 checked:after:border-white checked:after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
              />
              <span>Remember me</span>
            </label>

            <button
              type="button"
              onClick={() => {
                setResetEmail(identity.includes('@') ? identity : '');
                setResetSent(false);
                setForgotOpen(true);
              }}
              className="cursor-pointer border-0 bg-transparent p-0 text-[0.95rem] text-[#8d8d94] transition-colors hover:text-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
            >
              Forgot password?
            </button>
          </div>

          <p className="-mt-2 mb-4 min-h-[1.2em] text-[0.9rem] text-[#ff6b6b]" role="alert">
            {error}
          </p>

          <button
            type="submit"
            disabled={submitting}
            className="flex h-[50px] w-full cursor-pointer items-center justify-center gap-3 rounded-[10px] border border-[#4a6fe6] bg-[#2f56d6] text-[1rem] font-medium text-white shadow-[0_4px_18px_rgba(47,86,214,0.35)] transition-colors hover:bg-[#3b65ee] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
          >
            {submitting
              ? mode === 'signin'
                ? 'Signing in...'
                : 'Creating account...'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <div className="my-[18px] flex items-center gap-4 text-[0.95rem] text-[#8d8d94] before:h-[1px] before:flex-1 before:bg-[#2e2e32] before:content-[''] after:h-[1px] after:flex-1 after:bg-[#2e2e32] after:content-['']">
          OR
        </div>

        <button
          type="button"
          onClick={() => setGoogleOpen(true)}
          disabled={submitting}
          className="flex h-[50px] w-full cursor-pointer items-center justify-center gap-3 rounded-[10px] border border-[#2e2e32] bg-[#141414] text-[1rem] text-[#f5f5f5] transition-colors hover:bg-[#1c1c1f] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
        >
          <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"
            />
            <path
              fill="#FBBC05"
              d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
            />
          </svg>
          <span>Sign in with Google</span>
        </button>

        <p className="mt-8 text-center text-[#8d8d94]">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => {
              setMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
              setError('');
            }}
            className="cursor-pointer border-0 bg-transparent p-0 text-[1rem] text-[#3b6ef5] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
          >
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </button>
        </p>

        <p className="mt-7 text-center text-[0.85rem] leading-[1.6] text-[#6b6b72]">
          By proceeding you acknowledge that you have read, understood and agree to our{' '}
          <button
            type="button"
            onClick={() => setLegalDoc('Terms and Conditions')}
            className="cursor-pointer border-0 bg-transparent p-0 text-[0.85rem] text-[#9a9aa2] underline hover:text-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
          >
            Terms and Conditions
          </button>
          ,{' '}
          <button
            type="button"
            onClick={() => setLegalDoc('Privacy Policy')}
            className="cursor-pointer border-0 bg-transparent p-0 text-[0.85rem] text-[#9a9aa2] underline hover:text-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
          >
            Privacy Policy
          </button>
          ,{' '}
          <button
            type="button"
            onClick={() => setLegalDoc('Affiliate Agreement')}
            className="cursor-pointer border-0 bg-transparent p-0 text-[0.85rem] text-[#9a9aa2] underline hover:text-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b6ef5]"
          >
            Affiliate Agreement
          </button>
        </p>
      </main>

      {forgotOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reset password"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setForgotOpen(false)}
        >
          <div
            className="w-full max-w-[360px] rounded-2xl border border-[#2e2e32] bg-[#141414] p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-[#f5f5f5]">Reset password</h2>
              <button
                type="button"
                onClick={() => setForgotOpen(false)}
                aria-label="Close reset password"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#8d8d94] hover:bg-[#1e1e22] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {resetSent ? (
              <div className="mt-3 space-y-3">
                <div className="flex items-start gap-2 rounded-lg border border-[#145a30] bg-[#0a2314] p-3 text-[13px] text-[#22d36b]">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Password reset instructions sent to {resetEmail}.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setForgotOpen(false)}
                  className="h-10 w-full cursor-pointer rounded-[10px] bg-[#2f56d6] text-[14px] font-medium text-white hover:bg-[#3b65ee]"
                >
                  Back to Sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetSubmit} className="mt-3 space-y-3">
                <p className="text-[13px] text-[#8d8d94]">
                  Enter your email address and we’ll send a reset link.
                </p>
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-11 w-full rounded-[10px] border border-[#2e2e32] bg-[#0a0a0a] px-3.5 text-[14px] text-[#f5f5f5] placeholder-[#77777e] focus:border-[#6a6a72] focus:outline-none"
                />
                <button
                  type="submit"
                  className="h-10 w-full cursor-pointer rounded-[10px] bg-[#2f56d6] text-[14px] font-medium text-white hover:bg-[#3b65ee]"
                >
                  Send reset link
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {googleOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a Google account"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setGoogleOpen(false)}
        >
          <div
            className="w-full max-w-[360px] rounded-2xl border border-[#2e2e32] bg-[#141414] p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-[#f5f5f5]">Sign in with Google</h2>
              <button
                type="button"
                onClick={() => setGoogleOpen(false)}
                aria-label="Close Google sign in"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#8d8d94] hover:bg-[#1e1e22] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-[13px] text-[#8d8d94]">Choose an account to continue to Scalereach</p>

            <div className="mt-4 space-y-2.5">
              <button
                type="button"
                onClick={() => handleGoogleSignIn('creator@scalereach.app')}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[#2e2e32] bg-[#1a1a1d] p-3 text-left transition-colors hover:border-[#4a6fe6] hover:bg-[#202026]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#2f56d6] text-[13px] font-semibold text-white">
                  C
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[#f5f5f5]">Creator Workspace</div>
                  <div className="truncate text-[12px] text-[#8d8d94]">creator@scalereach.app</div>
                </div>
              </button>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleGoogleSignIn(customGoogleEmail);
                }}
                className="flex gap-2 pt-1"
              >
                <input
                  type="email"
                  value={customGoogleEmail}
                  onChange={(e) => setCustomGoogleEmail(e.target.value)}
                  placeholder="Or enter your Google email"
                  required
                  className="h-10 min-w-0 flex-1 rounded-[10px] border border-[#2e2e32] bg-[#0a0a0a] px-3 text-[13px] text-[#f5f5f5] placeholder-[#77777e] focus:border-[#6a6a72] focus:outline-none"
                />
                <button
                  type="submit"
                  className="h-10 shrink-0 cursor-pointer rounded-[10px] bg-[#2f56d6] px-3.5 text-[13px] font-medium text-white hover:bg-[#3b65ee]"
                >
                  Continue
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {legalDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={legalDoc}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setLegalDoc(null)}
        >
          <div
            className="w-full max-w-[380px] rounded-2xl border border-[#2e2e32] bg-[#141414] p-5 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold text-[#f5f5f5]">{legalDoc}</h2>
              <button
                type="button"
                onClick={() => setLegalDoc(null)}
                aria-label="Close legal document"
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-[#8d8d94] hover:bg-[#1e1e22] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-[#9a9aa2]">
              By using Scalereach, you agree to process only video content you own or have permission to clip under our {legalDoc}. Your workspace data stays protected in accordance with standard security practices.
            </p>
            <button
              type="button"
              onClick={() => setLegalDoc(null)}
              className="mt-4 h-10 w-full cursor-pointer rounded-[10px] bg-[#2f56d6] text-[14px] font-medium text-white hover:bg-[#3b65ee]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
