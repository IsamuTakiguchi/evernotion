import { NextResponse } from 'next/server';

import { requireSession } from '@/lib/auth/guard';
import { createToken, listTokens, revokeToken } from '@/lib/mcp/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Managing the tokens that let Claude in.
 *
 * Signed-in only, by cookie — issuing a credential that bypasses sign-in must
 * itself require signing in, or a leaked token could mint replacements for
 * itself and revoking it would achieve nothing.
 */
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  return NextResponse.json({ tokens: listTokens(session.userId) });
}

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const { token, secret } = createToken(session.userId, body.name ?? 'Claude');

  // The only time the plaintext exists outside this response.
  return NextResponse.json({ token, secret }, { status: 201 });
}

export async function DELETE(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  return revokeToken(session.userId, id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'not found' }, { status: 404 });
}
