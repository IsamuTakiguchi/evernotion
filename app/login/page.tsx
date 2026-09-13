'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Logo } from '@/components/layout/Logo';
import { IconSpinner } from '@/components/ui/Icons';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'ログインに失敗しました');
        setPassword('');
        return;
      }
      // Full navigation, so the server re-renders with the session cookie.
      window.location.href = params.get('next') ?? '/';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Evernotion</h1>
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              続けるにはパスワードを入力してください
            </p>
          </div>
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder="パスワード"
          className="w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg)' }}
        />

        {error && (
          <p className="mt-2 text-[13px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[14px] text-white disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          {busy && <IconSpinner size={14} />}
          ログイン
        </button>

        <p className="mt-6 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          このパスワードは環境変数 <code>EVERNOTION_PASSWORD</code> で設定されています。
          ローカルで使う場合は設定しなければログイン不要です。
        </p>
      </form>
    </div>
  );
}
