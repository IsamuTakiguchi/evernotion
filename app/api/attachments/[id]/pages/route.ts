import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Extracted per-page text, used by the viewer to locate search matches. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const pages = getDb()
    .prepare('SELECT page_no, text, source FROM pdf_pages WHERE attachment_id = ? ORDER BY page_no')
    .all(id) as { page_no: number; text: string; source: string }[];

  return NextResponse.json({
    pages: pages.map((p) => ({ pageNo: p.page_no, text: p.text, source: p.source })),
  });
}
