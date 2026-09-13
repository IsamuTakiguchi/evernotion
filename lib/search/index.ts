import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { ngramText } from './ngram';
import { normalize } from './normalize';

export type IndexInput = { ownerId: string } & (
  | { kind: 'page'; pageId: string; title: string; body: string }
  | { kind: 'pdf'; attachmentId: string; pdfPageNo: number; title: string; body: string }
);

/**
 * The one and only writer of the search index.
 *
 * Deliberately app-level rather than SQL triggers: a trigger would have to call
 * a JS-registered function to build n-grams, and that function only exists on
 * connections that registered it. A migration runner or a sqlite3 shell
 * touching the table would then fail or, worse, write a half-built index.
 * Always call inside the same transaction as the row it indexes.
 */
export function indexSearchDoc(db: DB, input: IndexInput): void {
  const title = normalize(input.title);
  const body = normalize(input.body);

  const existing =
    input.kind === 'page'
      ? (db.prepare(`SELECT rowid FROM search_docs WHERE kind = 'page' AND page_id = ?`).get(input.pageId) as { rowid: number } | undefined)
      : (db.prepare(`SELECT rowid FROM search_docs WHERE kind = 'pdf' AND attachment_id = ? AND pdf_page_no = ?`).get(input.attachmentId, input.pdfPageNo) as { rowid: number } | undefined);

  let rowid: number;
  if (existing) {
    rowid = existing.rowid;
    db.prepare(
      `UPDATE search_docs SET title = ?, body = ?, owner_id = ?, updated_at = datetime('now')
        WHERE rowid = ?`,
    ).run(title, body, input.ownerId, rowid);
  } else {
    const info = db
      .prepare(
        `INSERT INTO search_docs (kind, owner_id, page_id, attachment_id, pdf_page_no, title, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.ownerId,
        input.kind === 'page' ? input.pageId : null,
        input.kind === 'pdf' ? input.attachmentId : null,
        input.kind === 'pdf' ? input.pdfPageNo : null,
        title,
        body,
      );
    rowid = Number(info.lastInsertRowid);
  }

  db.prepare('DELETE FROM fts_docs WHERE rowid = ?').run(rowid);
  db.prepare('INSERT INTO fts_docs(rowid, title_ng, body_ng) VALUES (?, ?, ?)')
    .run(rowid, ngramText(title), ngramText(body));
}

export function removeSearchDoc(
  db: DB,
  where: { kind: 'page'; pageId: string } | { kind: 'pdf'; attachmentId: string },
): void {
  const rows =
    where.kind === 'page'
      ? (db.prepare(`SELECT rowid FROM search_docs WHERE kind = 'page' AND page_id = ?`).all(where.pageId) as { rowid: number }[])
      : (db.prepare(`SELECT rowid FROM search_docs WHERE kind = 'pdf' AND attachment_id = ?`).all(where.attachmentId) as { rowid: number }[]);

  for (const { rowid } of rows) {
    db.prepare('DELETE FROM fts_docs WHERE rowid = ?').run(rowid);
    db.prepare('DELETE FROM search_docs WHERE rowid = ?').run(rowid);
  }
}

/** Compact the FTS index. Worth running after a bulk ingest. */
export function optimizeIndex(): void {
  getDb().prepare(`INSERT INTO fts_docs(fts_docs) VALUES ('optimize')`).run();
}

/**
 * Rebuild one owner's slice of the index from their pages and PDF pages.
 *
 * Per owner rather than global: this is reachable from the UI, and a global
 * rebuild triggered by one account would drop and re-derive everybody's rows —
 * fine if it completes, a shared outage if it does not.
 */
export function rebuildIndex(ownerId: string): { pages: number; pdfPages: number } {
  const db = getDb();
  const pages = db
    .prepare('SELECT id, title, plain_text FROM pages WHERE owner_id = ?')
    .all(ownerId) as { id: string; title: string; plain_text: string }[];
  const pdfPages = db
    .prepare(
      `SELECT pp.attachment_id, pp.page_no, pp.text, a.filename
         FROM pdf_pages pp JOIN attachments a ON a.id = pp.attachment_id
        WHERE a.owner_id = ?`,
    )
    .all(ownerId) as { attachment_id: string; page_no: number; text: string; filename: string }[];

  const tx = db.transaction(() => {
    for (const row of db
      .prepare('SELECT rowid FROM search_docs WHERE owner_id = ?')
      .all(ownerId) as { rowid: number }[]) {
      db.prepare('DELETE FROM fts_docs WHERE rowid = ?').run(row.rowid);
    }
    db.prepare('DELETE FROM search_docs WHERE owner_id = ?').run(ownerId);

    for (const p of pages) {
      indexSearchDoc(db, {
        ownerId, kind: 'page', pageId: p.id, title: p.title, body: p.plain_text,
      });
    }
    for (const pp of pdfPages) {
      indexSearchDoc(db, {
        ownerId,
        kind: 'pdf',
        attachmentId: pp.attachment_id,
        pdfPageNo: pp.page_no,
        title: `${pp.filename} p.${pp.page_no}`,
        body: pp.text,
      });
    }
  });
  tx();
  optimizeIndex();
  return { pages: pages.length, pdfPages: pdfPages.length };
}
