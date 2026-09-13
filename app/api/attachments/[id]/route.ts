import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  filename: string;
  status: string;
  progress: number;
  page_count: number | null;
  ocr_pages: number;
  error: string | null;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const row = getDb()
    .prepare(
      `SELECT id, filename, status, progress, page_count, ocr_pages, error
         FROM attachments WHERE id = ?`,
    )
    .get(id) as Row | undefined;

  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    attachment: {
      id: row.id,
      filename: row.filename,
      status: row.status,
      progress: row.progress,
      pageCount: row.page_count,
      ocrPages: row.ocr_pages,
      error: row.error,
    },
  });
}
