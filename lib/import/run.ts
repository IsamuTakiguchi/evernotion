/**
 * Turning parsed notes into pages.
 *
 * Everything downstream of here is existing machinery: createPage indexes for
 * search, enqueuePdf runs the OCR pipeline, queuePageIndex builds embeddings.
 * This file only decides what becomes a page, what becomes an attachment, and
 * whose they are — nothing about how any of it is stored or found.
 *
 * Runs on a queue of one, like the PDF ingest it feeds. Two imports at once
 * would fight over the same SQLite writer for no gain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { getDb, filesDir } from '../db/client';
import { createPage, setPageTags, updatePage } from '../db/queries';
import { enqueuePdf } from '../pdf/queue';
import { queuePageIndex } from '../ai/indexer';
import type { JSONContent } from '../editor/doc';

import { htmlToDoc } from './html';
import { parseEnex, looksLikeEnex } from './enex';
import {
  readNotionZip, notionMarkdownToHtml, linkResolverFor, assetResolverFor, looksLikeZip,
} from './notion';
import type { ImportedNote, ImportedResource, ImportProgress, ImportSource } from './types';

const IMAGE = /^image\//;
const PDF = 'application/pdf';

// --------------------------------------------------------------- records ---

export function createImport(ownerId: string, source: ImportSource, filename: string): string {
  const id = `imp_${nanoid(10)}`;
  getDb()
    .prepare('INSERT INTO imports (id, owner_id, source, filename) VALUES (?, ?, ?, ?)')
    .run(id, ownerId, source, filename);
  return id;
}

function patch(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

export function getImport(ownerId: string, id: string): ImportProgress | null {
  const row = getDb()
    .prepare('SELECT * FROM imports WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? toProgress(row) : null;
}

/** The most recent imports for this account, newest first. */
export function listImports(ownerId: string, limit = 5): ImportProgress[] {
  return (getDb()
    .prepare('SELECT * FROM imports WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(ownerId, limit) as Record<string, unknown>[]).map(toProgress);
}

function toProgress(row: Record<string, unknown>): ImportProgress {
  return {
    id: String(row.id),
    source: row.source as ImportSource,
    filename: String(row.filename),
    status: row.status as ImportProgress['status'],
    total: Number(row.total),
    done: Number(row.done),
    notes: Number(row.notes),
    attachments: Number(row.attachments),
    skipped: Number(row.skipped),
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/**
 * An import that was running when the process stopped cannot be resumed — the
 * uploaded file is gone with the temp directory. Saying so is better than
 * leaving a progress bar that will never move.
 */
export function failInterruptedImports(): void {
  getDb()
    .prepare(
      `UPDATE imports
          SET status = 'error', error = '再起動により中断されました', finished_at = datetime('now')
        WHERE status IN ('pending', 'running')`,
    )
    .run();
}

// ------------------------------------------------------------ attachments ---

/**
 * Store one file and register it, reusing the same path an upload takes.
 *
 * A PDF goes onto the ingest queue exactly as an uploaded one would, which is
 * why imported PDFs end up searchable by their contents — including scans,
 * through OCR — without this file knowing anything about either.
 */
function saveResource(
  ownerId: string,
  pageId: string,
  resource: ImportedResource,
): { id: string; mime: string } {
  const id = nanoid(12);
  const ext = path.extname(resource.filename) || guessExt(resource.mime);
  const storagePath = path.join(filesDir(), `${id}${ext}`);
  fs.writeFileSync(storagePath, resource.data);

  const isPdf = resource.mime === PDF;
  getDb()
    .prepare(
      `INSERT INTO attachments (id, owner_id, page_id, filename, mime, size, storage_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, ownerId, pageId, resource.filename, resource.mime,
      resource.data.byteLength, storagePath,
      // Only a PDF has anything left to do; everything else is already final.
      isPdf ? 'pending' : 'ready',
    );

  if (isPdf) enqueuePdf({ attachmentId: id, storagePath, filename: resource.filename });
  return { id, mime: resource.mime };
}

function guessExt(mime: string): string {
  if (mime === PDF) return '.pdf';
  const m = mime.match(/^image\/(png|jpeg|gif|webp|bmp)$/);
  if (!m) return '';
  return m[1] === 'jpeg' ? '.jpg' : `.${m[1]}`;
}

/** How a stored file appears in the body. */
function nodeForAttachment(id: string, mime: string, filename: string): JSONContent {
  if (IMAGE.test(mime)) {
    // Served by the existing attachment route, which checks the owner — so an
    // imported image is no more reachable by anyone else than an uploaded one.
    return { type: 'image', attrs: { src: `/api/attachments/${id}/file`, alt: filename } };
  }
  if (mime === PDF) {
    return { type: 'pdfAttachment', attrs: { attachmentId: id, filename } };
  }
  return {
    type: 'paragraph',
    content: [{
      type: 'text',
      text: filename,
      marks: [{ type: 'link', attrs: { href: `/api/attachments/${id}/file` } }],
    }],
  };
}

// ------------------------------------------------------------- importing ---

type Counters = { notes: number; attachments: number; skipped: number };

/** Create one page from a parsed note, with its attachments and tags. */
function writeNote(
  ownerId: string,
  note: ImportedNote,
  counters: Counters,
  opts: { parentId?: string | null; pageId?: string } = {},
): string {
  const pageId = opts.pageId
    ?? createPage(ownerId, { title: note.title, parentId: opts.parentId ?? null }).id;

  // Attachments are stored first: the body refers to them by id, so they have
  // to exist before it is converted.
  const byHash = new Map<string, { id: string; mime: string; filename: string }>();
  const unreferenced: { id: string; mime: string; filename: string }[] = [];

  for (const resource of note.resources) {
    const saved = saveResource(ownerId, pageId, resource);
    counters.attachments++;
    const entry = { ...saved, filename: resource.filename };
    if (resource.hash) byHash.set(resource.hash.toLowerCase(), entry);
    else unreferenced.push(entry);
  }

  const used = new Set<string>();
  const doc = htmlToDoc(note.html, {
    resolveMedia: (ref) => {
      const key = ref.hash?.toLowerCase();
      const hit = key ? byHash.get(key) : undefined;
      if (!hit) return null;
      used.add(key!);
      return nodeForAttachment(hit.id, hit.mime, hit.filename);
    },
  });

  // An attachment the body never referenced still belongs to the note — losing
  // it would lose the file. It goes at the end rather than nowhere.
  const orphans = [
    ...unreferenced,
    ...[...byHash.entries()].filter(([hash]) => !used.has(hash)).map(([, v]) => v),
  ];
  for (const orphan of orphans) {
    doc.content!.push(nodeForAttachment(orphan.id, orphan.mime, orphan.filename));
  }

  updatePage(ownerId, pageId, { title: note.title, doc });
  if (note.tags.length) setPageTags(ownerId, pageId, { add: note.tags, source: 'import' });

  counters.notes++;
  queuePageIndex(pageId);
  return pageId;
}

async function importEnex(
  ownerId: string,
  importId: string,
  file: string,
  counters: Counters,
): Promise<void> {
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  await parseEnex(stream, (note) => {
    writeNote(ownerId, note, counters);
    patch(importId, {
      done: counters.notes, notes: counters.notes, attachments: counters.attachments,
    });
  });
}

function importNotion(
  ownerId: string,
  importId: string,
  file: string,
  counters: Counters,
): void {
  const { notes, assets, bodies, skipped } = readNotionZip(new Uint8Array(fs.readFileSync(file)));
  counters.skipped += skipped.length;
  patch(importId, { total: notes.length, skipped: counters.skipped });

  // Two passes. Every page exists before any body is converted, so a link
  // between two notes resolves whichever order the files happen to be in —
  // and backlinks and the graph work the moment the import finishes.
  const pageIdByPath = new Map<string, string>();
  const titleByPath = new Map<string, string>();

  for (const note of notes) {
    const parentId = note.parentPath ? pageIdByPath.get(note.parentPath) ?? null : null;
    const page = createPage(ownerId, { title: note.title, parentId });
    pageIdByPath.set(note.path!, page.id);
    titleByPath.set(note.path!, note.title);
  }

  for (const note of notes) {
    const pageId = pageIdByPath.get(note.path!)!;
    const resolveAsset = assetResolverFor(note.path!, assets);
    const resolveLink = linkResolverFor(note.path!, pageIdByPath, titleByPath);

    // Only the assets this page actually uses become its attachments; a file
    // shared between pages is stored once per page that shows it.
    const doc = htmlToDoc(notionMarkdownToHtml(bodies.get(note.path!) ?? ''), {
      resolveLink,
      resolveMedia: (ref) => {
        const src = ref.src;
        if (!src) return null;
        const found = resolveAsset(src);
        if (!found) return null;
        const saved = saveResource(ownerId, pageId, found.resource);
        counters.attachments++;
        return nodeForAttachment(saved.id, saved.mime, found.resource.filename);
      },
    });

    updatePage(ownerId, pageId, { title: note.title, doc });
    counters.notes++;
    queuePageIndex(pageId);
    patch(importId, {
      done: counters.notes, notes: counters.notes, attachments: counters.attachments,
    });
  }
}

/** Which importer a file needs, from its first bytes rather than its name. */
export function detectSource(head: Buffer): ImportSource | null {
  if (looksLikeEnex(head)) return 'evernote';
  if (looksLikeZip(head)) return 'notion';
  return null;
}

/**
 * Run an import to completion.
 *
 * The uploaded file is deleted afterwards either way: it has been turned into
 * pages, and a copy of everybody's export sitting in the data directory would
 * quietly fill the volume.
 */
export async function runImport(
  ownerId: string,
  importId: string,
  source: ImportSource,
  file: string,
): Promise<void> {
  const counters: Counters = { notes: 0, attachments: 0, skipped: 0 };
  patch(importId, { status: 'running' });

  try {
    if (source === 'evernote') await importEnex(ownerId, importId, file, counters);
    else importNotion(ownerId, importId, file, counters);

    patch(importId, {
      status: 'done',
      total: counters.notes,
      done: counters.notes,
      notes: counters.notes,
      attachments: counters.attachments,
      skipped: counters.skipped,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[import]', err);
    patch(importId, {
      status: 'error',
      error: (err as Error).message.slice(0, 500),
      notes: counters.notes,
      attachments: counters.attachments,
      finished_at: new Date().toISOString(),
    });
  } finally {
    // Awaited, not fire-and-forget: callers — the tests among them — are
    // entitled to assume the upload is gone once this resolves. A failure to
    // delete must not replace the import's own outcome, hence the catch.
    try {
      await fs.promises.rm(file, { force: true });
      // The route gives each upload its own temp directory; removing it when
      // empty keeps them from accumulating for the life of the container.
      await fs.promises.rmdir(path.dirname(file)).catch(() => undefined);
    } catch (err) {
      console.error('[import] could not remove the uploaded file:', (err as Error).message);
    }
  }
}

/** In-process queue of one, matching the PDF pipeline this feeds. */
type Queued = { ownerId: string; importId: string; source: ImportSource; file: string };
const g = globalThis as typeof globalThis & { __evernotionImports?: { jobs: Queued[]; running: boolean } };

function queue() {
  g.__evernotionImports ??= { jobs: [], running: false };
  return g.__evernotionImports;
}

export function enqueueImport(job: Queued): void {
  const q = queue();
  q.jobs.push(job);
  void drain();
}

async function drain(): Promise<void> {
  const q = queue();
  if (q.running) return;
  q.running = true;
  try {
    while (q.jobs.length) {
      const job = q.jobs.shift()!;
      await runImport(job.ownerId, job.importId, job.source, job.file);
    }
  } finally {
    q.running = false;
  }
}
