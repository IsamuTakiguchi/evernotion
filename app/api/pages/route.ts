import { NextResponse } from 'next/server';
import { createPage, listPageTree } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  return NextResponse.json({ tree: listPageTree(session.userId) });
}

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    parentId?: string | null;
    icon?: string | null;
  };
  const page = createPage(session.userId, {
    title: body.title ?? '',
    parentId: body.parentId ?? null,
    icon: body.icon ?? null,
  });
  return NextResponse.json({ page }, { status: 201 });
}
