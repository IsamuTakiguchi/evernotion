'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

type Me = {
  mode: 'google' | 'open' | 'locked';
  user: { id: string; email: string; name: string | null; picture: string | null } | null;
};

/**
 * Who is signed in, at the foot of the sidebar.
 *
 * With accounts, "whose notes am I looking at" stops being obvious — and a
 * shared browser makes getting it wrong easy. Nothing is rendered when the app
 * runs locally, where there is only ever one of you.
 */
export function AccountStrip() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.get<Me>('/api/me').then(setMe).catch(() => setMe(null));
  }, []);

  if (!me?.user || me.mode === 'open') return null;

  const label = me.user.name || me.user.email;

  return (
    <div className="ev-glass mx-2 mb-2 flex items-center gap-2 rounded-xl border px-2 py-1.5">
      {me.user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element -- Google's CDN, not in next.config's allowlist
        <img src={me.user.picture} alt="" width={22} height={22} className="shrink-0 rounded-full" />
      ) : (
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px]"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--text-muted)' }} title={me.user.email}>
        {label}
      </span>

      <button
        onClick={async () => {
          await fetch('/api/auth/logout', { method: 'POST' });
          window.location.href = '/login';
        }}
        className="ev-btn shrink-0 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-faint)' }}
      >
        ログアウト
      </button>
    </div>
  );
}
