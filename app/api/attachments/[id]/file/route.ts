import fs from 'node:fs';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Serves the stored PDF with range support, which pdf.js relies on. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const row = getDb()
    .prepare('SELECT storage_path, mime, filename FROM attachments WHERE id = ?')
    .get(id) as { storage_path: string; mime: string; filename: string } | undefined;

  if (!row || !fs.existsSync(row.storage_path)) {
    return new Response('not found', { status: 404 });
  }

  const size = fs.statSync(row.storage_path).size;
  const range = req.headers.get('range');
  const headers: Record<string, string> = {
    'Content-Type': row.mime || 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
  };

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const chunk = fs.readFileSync(row.storage_path).subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(chunk.length),
      },
    });
  }

  return new Response(new Uint8Array(fs.readFileSync(row.storage_path)), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  });
}
