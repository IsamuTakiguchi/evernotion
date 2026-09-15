import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, authMode, sessionUserId } from '@/lib/auth/session';

/**
 * Sign-in gate, run in front of every matched request.
 *
 * Next 16 renamed `middleware` to `proxy`; the behaviour is identical and it
 * now defaults to the Node.js runtime.
 *
 * This is an early exit, NOT the security boundary. Next's own guidance:
 *
 *   "A matcher change or a refactor that moves a Server Function to a
 *    different route can silently remove Proxy coverage. Always verify
 *    authentication and authorization inside each Server Function rather than
 *    relying on Proxy alone."
 *
 * So this only reads the cookie — no database, because Proxy runs on every
 * request including prefetches — and the real checks live in requireSession()
 * and requireUserId(), which also resolve *which* user is asking. A mistake in
 * the matcher below costs a redirect, not the notes.
 */
export async function proxy(request: NextRequest) {
  const mode = authMode();

  // Nobody to authenticate against: this is somebody's own machine.
  if (mode === 'open') return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  // Reachable from the internet but with no sign-in configured. Serving the
  // notes would be the worst possible reading of "not configured yet".
  if (mode === 'locked') {
    if (isApi) {
      return NextResponse.json(
        { error: 'この環境ではログインが設定されていません', code: 'AUTH_NOT_CONFIGURED' },
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await sessionUserId(token)) return NextResponse.next();

  // An expired session on a fetch should surface as an error the client can
  // report, not as a login page delivered where JSON was expected.
  if (isApi) {
    return NextResponse.json(
      { error: 'ログインが必要です', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = '';
  if (pathname !== '/') login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   login page and the sign-in endpoints (or there would be no way in)
     *   /api/health        (the platform health check runs unauthenticated)
     *   /api/mcp           (Claude authenticates with a bearer token, not a
     *                       cookie; the route verifies it itself)
     *   Next.js internals and the icons, which are not secrets
     */
    '/((?!login|api/auth|api/health|api/mcp|_next/static|_next/image|icon.svg|apple-icon.png|manifest.webmanifest|icon-192.png|icon-512.png|og-icon.png|favicon.ico).*)',
  ],
};
