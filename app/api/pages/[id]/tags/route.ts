import { NextResponse } from 'next/server';
import { getPage, getPageTags, setPageTags } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!getPage(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tags: getPageTags(id) });
}

export async function POST(req: Request, { params }: Params) {
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
