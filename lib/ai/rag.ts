import { getDb } from '../db/client';
import { search } from '../search/search';
import { cosine, embedQuery, fromBlob } from './embed';

export type Source = {
  id: string;            // S1, S2 … the label the model cites
  kind: 'page' | 'pdf';
  pageId: string | null;
  attachmentId: string | null;
  pdfPageNo: number | null;
  title: string;
  text: string;
};

type ChunkRow = {
  id: number;
  kind: 'page' | 'pdf';
  page_id: string | null;
  attachment_id: string | null;
  pdf_page_no: number | null;
  text: string;
  embedding: Buffer | null;
  page_title: string | null;
  filename: string | null;
};

/**
 * Brute-force cosine over every stored vector.
 *
 * Vectors are L2-normalised, so a dot product is the cosine. At a personal
 * scale (tens of thousands of chunks) this is tens of milliseconds — not worth
 * the operational cost of a native vector index.
 */
export async function vectorSearch(query: string, limit = 30): Promise<{ row: ChunkRow; score: number }[]> {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.kind, c.page_id, c.attachment_id, c.pdf_page_no, c.text, c.embedding,
              p.title AS page_title, a.filename
         FROM chunks c
         LEFT JOIN attachments a ON a.id = c.attachment_id
         LEFT JOIN pages p ON p.id = COALESCE(c.page_id, a.page_id) AND p.archived_at IS NULL
        WHERE c.embedding IS NOT NULL
          -- Trashed notes must not resurface through meaning search or as a
          -- citation in chat, the same way they are hidden from keyword search.
          AND (COALESCE(c.page_id, a.page_id) IS NULL OR p.id IS NOT NULL)`,
    )
    .all() as ChunkRow[];

  if (rows.length === 0) return [];

  const q = await embedQuery(query);
  return rows
    .map((row) => ({ row, score: cosine(q, fromBlob(row.embedding!)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const RRF_K = 60;

/**
 * Fuse keyword and vector results with Reciprocal Rank Fusion.
 *
 * bm25 scores and cosine similarities live on incomparable scales, and
 * normalising them is fragile; RRF only needs the rank ordering. Keyword
 * results are weighted higher for short queries (someone looking up a term)
 * and vector results for long ones (someone asking a question).
 */
export async function retrieve(query: string, limit = 8): Promise<Source[]> {
  const isQuestion = query.length > 12 || /[?？か]$/.test(query.trim());
  const wFts = isQuestion ? 0.6 : 1.0;
  const wVec = isQuestion ? 1.0 : 0.6;

  const scores = new Map<string, { score: number; source: Source }>();
  const add = (key: string, weight: number, rank: number, make: () => Source) => {
    const contribution = weight / (RRF_K + rank);
    const existing = scores.get(key);
    if (existing) existing.score += contribution;
    else scores.set(key, { score: contribution, source: make() });
  };

  const keyword = search(query, { limit: 30 });
  keyword.forEach((hit, i) => {
    const key = hit.kind === 'pdf' ? `pdf:${hit.attachmentId}:${hit.pdfPageNo}` : `page:${hit.pageId}`;
    add(key, wFts, i, () => ({
      id: '',
      kind: hit.kind,
      pageId: hit.pageId,
      attachmentId: hit.attachmentId,
      pdfPageNo: hit.pdfPageNo,
      title: hit.title,
      text: hit.snippet.map((s) => s.text).join(''),
    }));
  });

  // A missing model must not break retrieval; keyword results still stand.
  let vector: Awaited<ReturnType<typeof vectorSearch>> = [];
  try {
    vector = await vectorSearch(query, 30);
  } catch (err) {
    console.error('[rag] vector search unavailable:', (err as Error).message);
  }

  vector.forEach(({ row }, i) => {
    const key = row.kind === 'pdf' ? `pdf:${row.attachment_id}:${row.pdf_page_no}` : `page:${row.page_id}`;
    add(key, wVec, i, () => ({
      id: '',
      kind: row.kind,
      pageId: row.page_id,
      attachmentId: row.attachment_id,
      pdfPageNo: row.pdf_page_no,
      title:
        row.kind === 'pdf'
          ? `${row.filename ?? 'PDF'} p.${row.pdf_page_no}`
          : row.page_title || '無題',
      text: row.text,
    }));
    // Prefer the full chunk text over a search snippet for the same document.
    const entry = scores.get(key);
    if (entry && entry.source.text.length < row.text.length) entry.source.text = row.text;
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry, i) => ({ ...entry.source, id: `S${i + 1}` }));
}

/** Notes closest to this one in embedding space, excluding itself. */
export async function relatedPages(pageId: string, limit = 5) {
  const db = getDb();
  const own = db
    .prepare(
      `SELECT c.embedding FROM chunks c
         JOIN pages p ON p.id = c.page_id AND p.archived_at IS NULL
        WHERE c.page_id = ? AND c.embedding IS NOT NULL`,
    )
    .all(pageId) as { embedding: Buffer }[];
  if (own.length === 0) return [];

  // The page's centroid represents it better than any single chunk.
  const vectors = own.map((r) => fromBlob(r.embedding));
  const centroid = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < centroid.length; i++) centroid[i] += v[i];
  let norm = 0;
  for (const value of centroid) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < centroid.length; i++) centroid[i] /= norm;

  const others = db
    .prepare(
      `SELECT c.page_id, c.embedding, p.title, p.icon
         FROM chunks c JOIN pages p ON p.id = c.page_id
        WHERE c.page_id <> ? AND c.embedding IS NOT NULL AND p.archived_at IS NULL`,
    )
    .all(pageId) as { page_id: string; embedding: Buffer; title: string; icon: string | null }[];

  const best = new Map<string, { id: string; title: string; icon: string | null; score: number }>();
  for (const row of others) {
    const score = cosine(centroid, fromBlob(row.embedding));
    const current = best.get(row.page_id);
    if (!current || score > current.score) {
      best.set(row.page_id, { id: row.page_id, title: row.title, icon: row.icon, score });
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
