import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Extracted per-page text, used by the viewer to locate search matches. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const { id } = await params;
  const pages = getDb()
    .prepare(
      `SELECT pp.page_no, pp.text, pp.source
         FROM pdf_pages pp JOIN attachments a ON a.id = pp.attachment_id
        WHERE pp.attachment_id = ? AND a.owner_id = ?
        ORDER BY pp.page_no`,
    )
    .all(id, session.userId) as { page_no: number; text: string; source: string }[];

  return NextResponse.json({
    pages: pages.map((p) => ({ pageNo: p.page_no, text: p.text, source: p.source })),
  });
}
