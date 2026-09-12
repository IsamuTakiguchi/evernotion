import { NextResponse } from 'next/server';
import { search } from '@/lib/search/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const kindParam = url.searchParams.get('kind');
  const kind = kindParam === 'page' || kindParam === 'pdf' ? kindParam : null;

  const hits = search(q, {
    kind,
    tag: url.searchParams.get('tag'),
    limit: Number(url.searchParams.get('limit') ?? 40),
    live: url.searchParams.get('live') === '1',
  });
  return NextResponse.json({ hits, query: q });
}
