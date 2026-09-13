import { NextResponse } from 'next/server';
import { searchPageTitles } from '@/lib/search/search';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Title-only search, for the [[wikilink]] autocomplete popup. */
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const pages = searchPageTitles(session.userId, url.searchParams.get('q') ?? '', 8);
  return NextResponse.json({ pages });
}
