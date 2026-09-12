import { NextResponse } from 'next/server';
import { rebuildIndex } from '@/lib/search/index';
import { reindexAll } from '@/lib/ai/indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/** Rebuild the keyword index and, optionally, every embedding. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { embeddings?: boolean };
  const search = rebuildIndex();
  const embeddings = body.embeddings ? await reindexAll() : null;
  return NextResponse.json({ search, embeddings });
}
