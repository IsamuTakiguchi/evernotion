import { NextResponse } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';

import { requireSession } from '@/lib/auth/guard';
import { createImport, detectSource, enqueueImport, getImport, listImports } from '@/lib/import/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

/**
 * An Evernote export of a few thousand notes with attachments runs to
 * hundreds of megabytes. The cap is high enough for that and low enough that
 * one upload cannot fill the volume the notes themselves live on.
 */
const MAX_BYTES = 500 * 1024 * 1024;

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    const one = getImport(session.userId, id);
    return one
      ? NextResponse.json({ import: one })
      : NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ imports: listImports(session.userId) });
}

/**
 * Receive an export and start importing it.
 *
 * The body is the file itself rather than multipart form data: formData()
 * buffers the whole upload in memory before handing it over, which for a
 * 500MB export is 500MB of heap on a container that has 1–2GB in total. This
 * streams it to disk and never holds more than a chunk.
 */
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json(
      { error: `ファイルが大きすぎます（上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB）` },
      { status: 413 },
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: 'ファイルが空です' }, { status: 400 });
  }

  const filename = (req.headers.get('x-filename') ?? 'export').slice(0, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernotian-import-'));
  const file = path.join(dir, `upload-${nanoid(8)}`);

  let written = 0;
  try {
    await pipeline(
      Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (chunks) {
        for await (const chunk of chunks) {
          written += (chunk as Buffer).byteLength;
          // content-length can lie, or be absent on a chunked upload, so the
          // limit is enforced against what actually arrives.
          if (written > MAX_BYTES) throw new Error('TOO_LARGE');
          yield chunk;
        }
      },
      fs.createWriteStream(file),
    );
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if ((err as Error).message === 'TOO_LARGE') {
      return NextResponse.json({ error: 'ファイルが大きすぎます' }, { status: 413 });
    }
    throw err;
  }

  if (written === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({ error: 'ファイルが空です' }, { status: 400 });
  }

  // The kind is decided by the first bytes, not the extension: people rename
  // downloads, and a mislabelled file should fail clearly rather than halfway.
  const head = Buffer.alloc(Math.min(4096, written));
  const handle = fs.openSync(file, 'r');
  fs.readSync(handle, head, 0, head.length, 0);
  fs.closeSync(handle);

  const source = detectSource(head);
  if (!source) {
    fs.rmSync(dir, { recursive: true, force: true });
    return NextResponse.json(
      {
        error: 'Evernote の .enex か、Notion の ZIP を選んでください',
        code: 'UNKNOWN_FORMAT',
      },
      { status: 415 },
    );
  }

  const importId = createImport(session.userId, source, filename);
  enqueueImport({ ownerId: session.userId, importId, source, file });

  return NextResponse.json({ import: getImport(session.userId, importId) }, { status: 202 });
}
