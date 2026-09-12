import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Readiness probe; also proves migrations ran. Used by the smoke test. */
export async function GET() {
  const db = getDb();
  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number };
  const docs = db.prepare('SELECT COUNT(*) AS n FROM search_docs').get() as { n: number };
  return NextResponse.json({
    ok: true,
    sqlite: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    pages: pages.n,
    searchDocs: docs.n,
  });
}
