import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getDb, filesDir } from '@/lib/db/client';
import { getPage } from '@/lib/db/queries';
import { enqueuePdf } from '@/lib/pdf/queue';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 200 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const form = await req.formData();
  const file = form.get('file');
  const requestedPage = (form.get('pageId') as string | null) ?? null;
  // Attaching to somebody else's note would put this file in their editor.
  const pageId = requestedPage && getPage(session.userId, requestedPage) ? requestedPage : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large' }, { status: 413 });
  }

  const id = nanoid(12);
  const ext = path.extname(file.name) || '.pdf';
  const storagePath = path.join(filesDir(), `${id}${ext}`);
  fs.writeFileSync(storagePath, Buffer.from(await file.arrayBuffer()));

  const db = getDb();
  db.prepare(
    `INSERT INTO attachments (id, owner_id, page_id, filename, mime, size, storage_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    id, session.userId, pageId, file.name,
    file.type || 'application/pdf', file.size, storagePath,
  );

  // Parsing happens in the background; the editor gets its block immediately.
  enqueuePdf({ attachmentId: id, storagePath, filename: file.name });

  return NextResponse.json(
    { attachment: { id, filename: file.name, status: 'pending' } },
    { status: 201 },
  );
}
