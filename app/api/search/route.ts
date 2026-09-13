import { NextResponse } from 'next/server';
import { search } from '@/lib/search/search';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const kindParam = url.searchParams.get('kind');
  const kind = kindParam === 'page' || kindParam === 'pdf' ? kindParam : null;

  const hits = search(session.userId, q, {
    kind,
    tag: url.searchParams.get('tag'),
    limit: Number(url.searchParams.get('limit') ?? 40),
    live: url.searchParams.get('live') === '1',
  });
  return NextResponse.json({ hits, query: q });
}
