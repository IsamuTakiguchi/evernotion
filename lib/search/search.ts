import { getDb } from '../db/client';
import { parseQuery } from './query';
import { makeSnippet, type SnippetRun } from './snippet';
import { normalizeFold } from './normalize';

export type SearchHit = {
  kind: 'page' | 'pdf';
  pageId: string | null;
  /** What to show as the result's heading. */
  title: string;
  icon: string | null;
  attachmentId: string | null;
  filename: string | null;
  pdfPageNo: number | null;
  snippet: SnippetRun[];
  score: number;
};

export type SearchOptions = {
  limit?: number;
  offset?: number;
  kind?: 'page' | 'pdf' | null;
  tag?: string | null;
  /** As-you-type: let the last latin term match as a prefix. */
  live?: boolean;
};

type Row = {
  rowid: number;
  kind: 'page' | 'pdf';
  page_id: string | null;
  attachment_id: string | null;
  pdf_page_no: number | null;
  title: string;
  body: string;
  icon: string | null;
  page_title: string | null;
  filename: string | null;
  rank: number;
};

export function search(raw: string, opts: SearchOptions = {}): SearchHit[] {
  const query = raw.trim();
  if (!query) return [];

  const limit = opts.limit ?? 40;
  const offset = opts.offset ?? 0;
  const parsed = parseQuery(query, { live: opts.live });
  const kind = opts.kind ?? parsed.kind;
  const tag = opts.tag ?? parsed.tag;

  const rows = parsed.match
    ? matchRows(parsed.match, { kind, tag, limit, offset })
    : likeRows(parsed.rest, { kind, tag, limit, offset });

  const terms = parsed.terms.length ? parsed.terms : [parsed.rest].filter(Boolean);

  return rows.map((r) => ({
    kind: r.kind,
    pageId: r.page_id,
    title:
      r.kind === 'pdf'
        ? `${r.filename ?? 'PDF'} — p.${r.pdf_page_no}`
        : r.title || r.page_title || '無題',
    icon: r.icon,
    attachmentId: r.attachment_id,
    filename: r.filename,
    pdfPageNo: r.pdf_page_no,
    snippet: makeSnippet(r.body, terms),
    score: -r.rank,
  }));
}

function matchRows(
  match: string,
  o: { kind: 'page' | 'pdf' | null; tag: string | null; limit: number; offset: number },
): Row[] {
  const filters: string[] = [];
  const args: unknown[] = [match];

  if (o.kind) {
    filters.push('d.kind = ?');
    args.push(o.kind);
  }
  if (o.tag) {
    filters.push(
      `COALESCE(d.page_id, a.page_id) IN
         (SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)`,
    );
    args.push(o.tag);
  }
  args.push(o.limit, o.offset);

  // bm25 weights the title column 8x: a hit in the title is nearly always
  // what the user meant.
  return getDb()
    .prepare(
      `WITH hits AS (
         SELECT rowid AS doc_id, bm25(fts_docs, 8.0, 1.0) AS rank
           FROM fts_docs WHERE fts_docs MATCH ?
          ORDER BY rank LIMIT 300
       )
       SELECT d.rowid, d.kind, d.attachment_id, d.pdf_page_no,
              d.title, d.body, h.rank,
              -- A pdf row has no page of its own; it belongs to whichever note
              -- the attachment was uploaded into, and that is where a click on
              -- the result has to land.
              COALESCE(d.page_id, a.page_id) AS page_id,
              p.icon, p.title AS page_title, a.filename
         FROM hits h
         JOIN search_docs d ON d.rowid = h.doc_id
         LEFT JOIN attachments a ON a.id = d.attachment_id
         LEFT JOIN pages p ON p.id = COALESCE(d.page_id, a.page_id) AND p.archived_at IS NULL
        -- Hide anything belonging to a trashed page: the note itself, and any
        -- PDF attached to it, whose text would otherwise stay searchable.
        WHERE COALESCE(d.page_id, a.page_id) IS NULL OR p.id IS NOT NULL
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
        ORDER BY h.rank
        LIMIT ? OFFSET ?`,
    )
    .all(...args) as Row[];
}

/**
 * Fallback for queries the tokenizer reduces to nothing — pure punctuation or
 * emoji. Rare, but it should still find something rather than silently fail.
 */
function likeRows(
  needle: string,
  o: { kind: 'page' | 'pdf' | null; tag: string | null; limit: number; offset: number },
): Row[] {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  const pattern = `%${normalizeFold(trimmed).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const filters: string[] = [];
  const args: unknown[] = [pattern, pattern];
  if (o.kind) {
    filters.push('d.kind = ?');
    args.push(o.kind);
  }
  args.push(o.limit, o.offset);

  return getDb()
    .prepare(
      `SELECT d.rowid, d.kind, d.attachment_id, d.pdf_page_no,
              d.title, d.body, 0 AS rank,
              COALESCE(d.page_id, a.page_id) AS page_id,
              p.icon, p.title AS page_title, a.filename
         FROM search_docs d
         LEFT JOIN attachments a ON a.id = d.attachment_id
         LEFT JOIN pages p ON p.id = COALESCE(d.page_id, a.page_id) AND p.archived_at IS NULL
        WHERE (COALESCE(d.page_id, a.page_id) IS NULL OR p.id IS NOT NULL)
          AND (d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
        ORDER BY d.updated_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args) as Row[];
}

/** Title-only lookup that powers [[wikilink]] autocomplete. */
export function searchPageTitles(raw: string, limit = 8): { id: string; title: string; icon: string | null }[] {
  const query = raw.trim();
  const db = getDb();
  if (!query) {
    return db
      .prepare(`SELECT id, title, icon FROM pages WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as { id: string; title: string; icon: string | null }[];
  }

  const parsed = parseQuery(query, { live: true });
  if (!parsed.match) return [];

  return db
    .prepare(
      `SELECT p.id, p.title, p.icon
         FROM fts_docs f
         JOIN search_docs d ON d.rowid = f.rowid
         JOIN pages p ON p.id = d.page_id
        WHERE f.fts_docs MATCH ? AND d.kind = 'page' AND p.archived_at IS NULL
        ORDER BY bm25(fts_docs, 8.0, 1.0)
        LIMIT ?`,
    )
    .all(`{title_ng} : ${parsed.match}`, limit) as { id: string; title: string; icon: string | null }[];
}
