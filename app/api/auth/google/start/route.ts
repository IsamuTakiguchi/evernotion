import { NextResponse } from 'next/server';
import {
  OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS, redirectUri, startAuthorization,
} from '@/lib/auth/google';
import { authMode } from '@/lib/auth/session';
import { isHostedDeployment } from '@/lib/setup/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Send the browser to Google. The login page's button points here. */
export async function GET(req: Request) {
  if (authMode() !== 'google') {
    return NextResponse.json(
      { error: 'Googleログインが設定されていません', code: 'AUTH_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const hosted = isHostedDeployment();
  let started;
  try {
    started = await startAuthorization({
      redirectUri: redirectUri(req, hosted),
      next: new URL(req.url).searchParams.get('next'),
    });
  } catch (err) {
    console.error('[auth/google/start]', err);
    return NextResponse.json(
      { error: (err as Error).message, code: 'AUTH_MISCONFIGURED' },
      { status: 500 },
    );
  }

  const response = NextResponse.redirect(started.url);
  response.cookies.set(OAUTH_STATE_COOKIE, started.stateCookie, {
    httpOnly: true,
    sameSite: 'lax', // must survive the redirect back from Google
    secure: hosted,
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
