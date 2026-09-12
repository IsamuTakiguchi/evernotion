import { NextResponse } from 'next/server';
import { searchPageTitles } from '@/lib/search/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Title-only search, for the [[wikilink]] autocomplete popup. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pages = searchPageTitles(url.searchParams.get('q') ?? '', 8);
  return NextResponse.json({ pages });
}
