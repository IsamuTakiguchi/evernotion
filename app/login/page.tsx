import { Suspense } from 'react';
import { Logo } from '@/components/layout/Logo';
import { authMode } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Why the reason is spelled out rather than shown as "sign-in failed":
 * the person who can fix an allowlist problem is the one being refused, and
 * they cannot read the server log.
 */
const ERRORS: Record<string, string> = {
  not_allowed:
    'このGoogleアカウントは許可されていません。管理者に EVERNOTION_ALLOWED_EMAILS への追加を依頼してください。',
  cancelled: 'ログインがキャンセルされました。',
  state: 'ログインの有効期限が切れました。もう一度お試しください。',
  exchange: 'Googleとの通信に失敗しました。設定を確認してください。',
  google: 'Google側でエラーが返されました。',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const mode = authMode();

  const startUrl = `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;

  return (
    <Suspense fallback={null}>
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-7 flex items-center gap-3">
            <Logo size={40} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Evernotian</h1>
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                ノート、PDF全文検索、第2の脳をひとつに
              </p>
            </div>
          </div>

          {error && (
            <p
              className="mb-4 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed"
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              {ERRORS[error] ?? 'ログインに失敗しました。'}
            </p>
          )}

          {mode === 'google' ? (
            <>
              <a
                href={startUrl}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg border px-4 py-2.5 text-[14px] font-medium hover:bg-[var(--bg-hover)]"
                style={{ background: 'var(--bg)' }}
              >
                <GoogleMark />
                Googleでログイン
              </a>
              <p className="mt-6 text-[12px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
                許可されたGoogleアカウントだけがログインできます。
                ノートとPDFはアカウントごとに分かれていて、他の人からは見えません。
              </p>
            </>
          ) : (
            <div
              className="rounded-lg border px-3 py-3 text-[13px] leading-relaxed"
              style={{ borderColor: 'var(--danger)', color: 'var(--text-muted)' }}
            >
              <p style={{ color: 'var(--danger)' }}>ログインが設定されていません。</p>
              <p className="mt-2">
                この環境は公開されていますが、Googleログインが未設定のため、
                安全側に倒して何も表示していません。
                <code>GOOGLE_CLIENT_ID</code>、<code>GOOGLE_CLIENT_SECRET</code>、
                <code>EVERNOTION_ALLOWED_EMAILS</code> を設定してください。
              </p>
            </div>
          )}
        </div>
      </div>
    </Suspense>
  );
}

/** Google's mark, inlined: an external stylesheet or image would not load. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
