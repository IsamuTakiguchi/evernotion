import { NextResponse } from 'next/server';
import { relatedPages } from '@/lib/ai/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Purely local: runs on embeddings, so it works without an API key. */
export async function GET(req: Request) {
  const pageId = new URL(req.url).searchParams.get('pageId');
  if (!pageId) return NextResponse.json({ error: 'pageId is required' }, { status: 400 });

  try {
    return NextResponse.json({ related: await relatedPages(pageId, 5) });
  } catch (err) {
    // The embedding model may still be downloading; an empty list is fine here.
    console.error('[ai/related]', err);
    return NextResponse.json({ related: [] });
  }
}
