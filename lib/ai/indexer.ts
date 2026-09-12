import { getDb } from '../db/client';
import { chunkText, hashText } from './chunk';
import { embedPassages, toBlob } from './embed';

/**
 * Background re-embedding. Editing a note should never block on the model, so
 * saves only enqueue an id here; a single worker drains the queue afterwards.
 * Pending ids are deduplicated, and a rapid burst of keystroke-saves settles
 * into one index pass per page.
 */
const pendingPages = new Set<string>();
const pendingAttachments = new Set<string>();
let draining = false;
let indexError: string | null = null;

export function queuePageIndex(pageId: string) {
  pendingPages.add(pageId);
  void drainSoon();
}

export function queueAttachmentIndex(attachmentId: string) {
  pendingAttachments.add(attachmentId);
  void drainSoon();
}

export function indexerStatus() {
  return {
    pending: pendingPages.size + pendingAttachments.size,
    running: draining,
    error: indexError,
  };
}

const DEBOUNCE_MS = 1500;
let timer: NodeJS.Timeout | null = null;

function drainSoon(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, DEBOUNCE_MS);
  return Promise.resolve();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pendingPages.size || pendingAttachments.size) {
      const pageId = pendingPages.values().next().value as string | undefined;
      if (pageId) {
        pendingPages.delete(pageId);
        await indexPage(pageId);
        continue;
      }
      const attachmentId = pendingAttachments.values().next().value as string | undefined;
      if (attachmentId) {
        pendingAttachments.delete(attachmentId);
        await indexAttachment(attachmentId);
      }
    }
    indexError = null;
  } catch (err) {
    // A missing model or offline machine must not take the app down; semantic
    // search simply stays stale until the next successful pass.
    indexError = (err as Error).message;
    console.error('[indexer]', err);
  } finally {
    draining = false;
  }
}

type ExistingChunk = { id: number; hash: string };

/**
 * Re-chunk a source and embed only what actually changed, matching on content
 * hash. Editing one paragraph of a long note re-embeds one chunk, not all of them.
 */
async function syncChunks(
  where: { kind: 'page'; pageId: string } | { kind: 'pdf'; attachmentId: string },
  pieces: { text: string; ord: number; pdfPageNo?: number }[],
) {
  const db = getDb();
  const scope =
    where.kind === 'page'
      ? { sql: 'page_id = ?', arg: where.pageId }
      : { sql: 'attachment_id = ?', arg: where.attachmentId };

  const existing = db
    .prepare(`SELECT id, hash FROM chunks WHERE ${scope.sql}`)
    .all(scope.arg) as ExistingChunk[];
  const existingByHash = new Map(existing.map((c) => [c.hash, c.id]));

  const hashes = await Promise.all(pieces.map((p) => hashText(p.text)));
  const keep = new Set<number>();
  const toEmbed: { piece: (typeof pieces)[number]; hash: string }[] = [];

  pieces.forEach((piece, i) => {
    const hit = existingByHash.get(hashes[i]);
    if (hit !== undefined) keep.add(hit);
    else toEmbed.push({ piece, hash: hashes[i] });
  });

  const vectors = toEmbed.length
    ? await embedPassages(toEmbed.map((t) => t.piece.text))
    : [];

  const tx = db.transaction(() => {
    const stale = existing.filter((c) => !keep.has(c.id)).map((c) => c.id);
    if (stale.length) {
      db.prepare(`DELETE FROM chunks WHERE id IN (${stale.map(() => '?').join(',')})`).run(...stale);
    }
    const insert = db.prepare(
      `INSERT INTO chunks (kind, page_id, attachment_id, pdf_page_no, ord, text, hash, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    toEmbed.forEach((t, i) => {
      insert.run(
        where.kind,
        where.kind === 'page' ? where.pageId : null,
        where.kind === 'pdf' ? where.attachmentId : null,
        t.piece.pdfPageNo ?? null,
        t.piece.ord,
        t.piece.text,
        t.hash,
        toBlob(vectors[i]),
      );
    });
  });
  tx();
}

export async function indexPage(pageId: string) {
  const db = getDb();
  const row = db.prepare('SELECT title, plain_text FROM pages WHERE id = ?').get(pageId) as
    | { title: string; plain_text: string }
    | undefined;
  if (!row) return;

  // Prefixing each chunk with the title keeps short chunks self-describing.
  const pieces = chunkText(row.plain_text).map((c) => ({
    ord: c.ord,
    text: row.title ? `${row.title}\n${c.text}` : c.text,
  }));
  await syncChunks({ kind: 'page', pageId }, pieces);
}

export async function indexAttachment(attachmentId: string) {
  const db = getDb();
  const pages = db
    .prepare('SELECT page_no, text FROM pdf_pages WHERE attachment_id = ? ORDER BY page_no')
    .all(attachmentId) as { page_no: number; text: string }[];
  const meta = db.prepare('SELECT filename FROM attachments WHERE id = ?').get(attachmentId) as
    | { filename: string }
    | undefined;
  if (!meta) return;

  const pieces: { text: string; ord: number; pdfPageNo: number }[] = [];
  let ord = 0;
  for (const p of pages) {
    for (const c of chunkText(p.text, 700)) {
      pieces.push({
        ord: ord++,
        pdfPageNo: p.page_no,
        text: `${meta.filename} p.${p.page_no}\n${c.text}`,
      });
    }
  }
  await syncChunks({ kind: 'pdf', attachmentId }, pieces);
}

/** Force a full re-index of everything, for the Settings screen. */
export async function reindexAll() {
  const db = getDb();
  const pages = db.prepare('SELECT id FROM pages').all() as { id: string }[];
  const atts = db.prepare(`SELECT id FROM attachments WHERE status = 'ready'`).all() as { id: string }[];
  db.prepare('DELETE FROM chunks').run();
  for (const p of pages) await indexPage(p.id);
  for (const a of atts) await indexAttachment(a.id);
  return { pages: pages.length, attachments: atts.length };
}
