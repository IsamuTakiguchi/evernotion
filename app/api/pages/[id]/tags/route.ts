import { NextResponse } from 'next/server';
import { getPage, getPageTags, setPageTags } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  if (!getPage(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tags: getPageTags(id) });
}

export async function POST(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  if (!getPage(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    add?: string[];
    remove?: string[];
    source?: string;
  };
  const tags = setPageTags(id, {
    add: body.add ?? [],
    remove: body.remove ?? [],
    source: body.source === 'ai' ? 'ai' : 'manual',
  });
  return NextResponse.json({ tags });
}
