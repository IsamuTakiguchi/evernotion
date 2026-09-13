import { NextResponse } from 'next/server';
import { getPage, getPageTags, setPageTags } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await params;
  if (!getPage(session.userId, id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tags: getPageTags(session.userId, id) });
}

export async function POST(req: Request, { params }: Params) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await params;
  if (!getPage(session.userId, id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    add?: string[];
    remove?: string[];
    source?: string;
  };
  const tags = setPageTags(session.userId, id, {
    add: body.add ?? [],
    remove: body.remove ?? [],
    source: body.source === 'ai' ? 'ai' : 'manual',
  });
  return NextResponse.json({ tags });
}
