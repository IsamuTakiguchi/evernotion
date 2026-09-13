import { NextResponse } from 'next/server';
import {
  OAUTH_STATE_COOKIE, exchangeCode, readStateCookie, redirectUri,
} from '@/lib/auth/google';
import {
  SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, authMode, createSessionToken, readCookie,
} from '@/lib/auth/session';
import { isAllowedEmail, upsertUser } from '@/lib/auth/users';
import { seedWelcomeNotes } from '@/lib/setup/seed';
import { isHostedDeployment } from '@/lib/setup/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Where Google sends the browser back to. */
export async function GET(req: Request) {
  if (authMode() !== 'google') {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  const hosted = isHostedDeployment();
  const url = new URL(req.url);
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin));

  // The user pressed Cancel, or Google refused.
  const denied = url.searchParams.get('error');
  if (denied) return fail(denied === 'access_denied' ? 'cancelled' : 'google');

  const saved = await readStateCookie(readCookie(req, OAUTH_STATE_COOKIE));
  const code = url.searchParams.get('code');

  // No state cookie means this request did not start here — either a stale tab
  // or a forged callback. Either way there is nothing to exchange.
  if (!saved || !code) return fail('state');
  if (saved.state !== url.searchParams.get('state')) return fail('state');

  let profile;
  try {
    profile = await exchangeCode({
      code,
      verifier: saved.verifier,
      redirectUri: redirectUri(req, hosted),
    });
  } catch (err) {
    console.error('[auth/google/callback]', err);
    return fail('exchange');
  }

  if (!isAllowedEmail(profile.email, profile.emailVerified)) {
    // Logged, because the owner of the instance is the only person who can fix
    // it, and "it just says not allowed" is not enough to act on.
    console.warn(`[auth] refused sign-in for ${profile.email} (not on the allowlist)`);
    return fail('not_allowed');
  }

  const user = upsertUser(profile);
  // A brand new account opens to an empty sidebar otherwise.
  seedWelcomeNotes(user.id);

  const response = NextResponse.redirect(new URL(saved.next || '/', url.origin));
  response.cookies.set(SESSION_COOKIE, await createSessionToken(user.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: hosted,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
