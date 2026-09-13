import { NextResponse } from 'next/server';
import { rebuildIndex } from '@/lib/search/index';
import { reindexAll } from '@/lib/ai/indexer';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/** Rebuild the keyword index and, optionally, every embedding. */
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const body = (await req.json().catch(() => ({}))) as { embeddings?: boolean };
  const search = rebuildIndex(session.userId);
  const embeddings = body.embeddings ? await reindexAll(session.userId) : null;
  return NextResponse.json({ search, embeddings });
}
