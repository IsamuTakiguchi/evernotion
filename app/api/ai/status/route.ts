import { NextResponse } from 'next/server';
import { isAiEnabled } from '@/lib/ai/client';
import { indexerStatus } from '@/lib/ai/indexer';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lets the UI decide between the live AI panel and the "set a key" state. */
export async function GET() {
  const db = getDb();
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number };
  return NextResponse.json({
    aiEnabled: isAiEnabled(),
    embeddedChunks: chunks.n,
    indexer: indexerStatus(),
  });
}
