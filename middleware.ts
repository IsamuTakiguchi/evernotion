import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, configuredPassword, verifySessionToken } from '@/lib/auth/session';

/**
 * Optional password gate.
 *
 * Evernotion is designed to run on your own machine, where there is nobody to
 * authenticate. Deployed to a public URL that assumption breaks completely:
 * without this, anyone who learns the address can read every note, download
 * every PDF and upload files. Setting EVERNOTION_PASSWORD turns the gate on;
 * leaving it unset keeps local use frictionless.
 */
export async function middleware(request: NextRequest) {
  const password = configuredPassword();
  if (!password) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, password)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;

  // An expired session on a fetch should surface as an error the client can
  // report, not as a login page delivered where JSON was expected.
  if (pathname.startsWith('/api/')) {
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
     *   login page and its endpoint (or there would be no way in)
     *   /api/health        (the platform health check runs unauthenticated)
     *   Next.js internals and the icons, which are not secrets
     */
    '/((?!login|api/auth|api/health|_next/static|_next/image|icon.svg|apple-icon.png|manifest.webmanifest|icon-192.png|icon-512.png|og-icon.png|favicon.ico).*)',
  ],
};
