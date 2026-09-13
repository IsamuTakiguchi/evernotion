import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { authMode } from '@/lib/auth/session';
import { getUser } from '@/lib/auth/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who is signed in, for the account menu in the sidebar. */
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const user = getUser(session.userId);
  return NextResponse.json({
    mode: authMode(),
    user: user
      ? { id: user.id, email: user.email, name: user.name, picture: user.picture }
      : null,
  });
}
