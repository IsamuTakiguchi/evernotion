import { NextResponse } from 'next/server';
import { SESSION_COOKIE, authMode, sessionCookie, sessionUserId } from './session';
import { getUser, localUser } from './users';

/**
 * Resolve the user behind a request, inside the route handler.
 *
 * Defence in depth rather than duplication. proxy.ts gates matched routes, but
 * Next's documentation is explicit that a matcher edit or a moved route can
 * silently drop that coverage, and tells you to check inside the handler as
 * well. A typo in the matcher should cost a redirect, not every note in the
 * database.
 *
 * It returns the user id rather than just a yes, because with multiple accounts
 * every query needs an owner. Making that the only way to obtain one means a
 * handler cannot read the database without having said whose data it wants:
 *
 *     const session = await requireSession(req);
 *     if (session instanceof Response) return session;
 *     const pages = listPageTree(session.userId);
 */
export type Session = { userId: string };

export async function requireSession(req: Request): Promise<Session | Response> {
  const mode = authMode();

  if (mode === 'open') return { userId: localUser().id };

  if (mode === 'locked') {
    return NextResponse.json(
      {
        error: 'この環境ではログインが設定されていません',
        code: 'AUTH_NOT_CONFIGURED',
      },
      { status: 503 },
    );
  }

  const userId = await sessionUserId(sessionCookie(req));
  // A signature can outlive the account it names — a revoked user, or a
  // database restored from before they existed — so the row is checked too.
  if (userId && getUser(userId)) return { userId };

  const response = NextResponse.json(
    { error: 'ログインが必要です', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
  // A token naming a user who is gone will never work again; clearing it stops
  // the client retrying with it forever.
  if (userId) response.cookies.delete(SESSION_COOKIE);
  return response;
}

/**
 * The signed-in user, for Server Components.
 *
 * The same check as requireSession, for callers that render rather than
 * respond: there is no Request to read, and the answer to "not signed in" is
 * the login page rather than a 401.
 *
 * Proxy already redirects these routes, so reaching here unauthenticated means
 * the matcher missed — which is exactly the case Next's documentation says not
 * to rely on it for.
 */
export async function requireUserId(): Promise<string> {
  const mode = authMode();
  if (mode === 'open') return localUser().id;

  const { cookies } = await import('next/headers');
  const { redirect } = await import('next/navigation');

  if (mode === 'google') {
    const userId = await sessionUserId((await cookies()).get(SESSION_COOKIE)?.value);
    if (userId && getUser(userId)) return userId;
  }

  // redirect() throws; the return is for the type checker, which cannot see
  // that through the dynamic import.
  redirect('/login');
  throw new Error('unreachable');
}
