import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, configuredPassword,
  createSessionToken, passwordMatches,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const expected = configuredPassword();
  if (!expected) {
    return NextResponse.json({ error: 'パスワードは設定されていません' }, { status: 400 });
  }

  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !(await passwordMatches(password, expected))) {
    return NextResponse.json({ error: 'パスワードが違います' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(expected), {
    httpOnly: true,
    sameSite: 'lax',
    // Railway and every other hosted deployment terminates TLS in front of the
    // app, so trust the forwarded protocol rather than the local connection.
    secure: req.headers.get('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
