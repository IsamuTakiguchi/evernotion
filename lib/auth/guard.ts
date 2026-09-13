import { NextResponse } from 'next/server';
import { SESSION_COOKIE, configuredPassword, verifySessionToken } from './session';

/**
 * Verify the session inside a route handler.
 *
 * Defence in depth rather than duplication. proxy.ts gates matched routes, but
 * Next's documentation is explicit that a matcher edit or a moved route can
 * silently drop that coverage, and tells you to check inside the handler as
 * well. A typo in the matcher should cost a redirect, not every note in the
 * database.
 *
 * Returns a 401 Response when the caller is not authenticated, or null when the
 * request may proceed:
 *
 *     const denied = await requireSession(req);
 *     if (denied) return denied;
 */
export async function requireSession(req: Request): Promise<Response | null> {
  const password = configuredPassword();
  if (!password) return null; // open instance, by configuration

  const cookie = req.headers.get('cookie') ?? '';
  const token = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (await verifySessionToken(token, password)) return null;

  return NextResponse.json(
    { error: 'ログインが必要です', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}
