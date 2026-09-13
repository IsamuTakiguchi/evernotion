import { NextResponse } from 'next/server';
import { isAiEnabled } from '@/lib/ai/client';
import { indexerStatus } from '@/lib/ai/indexer';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lets the UI decide between the live AI panel and the "set a key" state. */
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const db = getDb();
  const chunks = db
    .prepare('SELECT COUNT(*) AS n FROM chunks WHERE owner_id = ? AND embedding IS NOT NULL')
    .get(session.userId) as { n: number };
  return NextResponse.json({
    aiEnabled: isAiEnabled(),
    embeddedChunks: chunks.n,
    indexer: indexerStatus(),
  });
}
