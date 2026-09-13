import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { isProtected } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness probe; also proves migrations ran. Used by the smoke test and by
 * the platform health check, so it is reachable without a session.
 *
 * Because it is unauthenticated, it reports how much content exists only when
 * the deployment is open anyway — on a password-protected instance even a note
 * count is nobody else's business.
 */
export async function GET() {
  const db = getDb();
  const sqlite = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

  if (isProtected()) return NextResponse.json({ ok: true, sqlite, protected: true });

  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number };
  const docs = db.prepare('SELECT COUNT(*) AS n FROM search_docs').get() as { n: number };
  return NextResponse.json({
    ok: true,
    sqlite,
    protected: false,
    pages: pages.n,
    searchDocs: docs.n,
  });
}
