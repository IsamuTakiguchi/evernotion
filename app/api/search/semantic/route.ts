import { NextResponse } from 'next/server';
import { vectorSearch } from '@/lib/ai/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Meaning-based search over notes and PDF pages.
 *
 * Separate from /api/search on purpose: keyword results come back in
 * milliseconds and should never wait on an embedding, so the palette renders
 * them first and folds these in when they arrive.
 *
 * Runs entirely locally, so it needs no API key.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ hits: [] });

  try {
    const results = await vectorSearch(q, 24);

    // Several chunks of one note can match; keep each note once, at its best score.
    const best = new Map<string, { score: number; hit: Record<string, unknown> }>();
    for (const { row, score } of results) {
      const key = row.kind === 'pdf' ? `pdf:${row.attachment_id}:${row.pdf_page_no}` : `page:${row.page_id}`;
      if (best.has(key) && best.get(key)!.score >= score) continue;
      best.set(key, {
        score,
        hit: {
          kind: row.kind,
          pageId: row.page_id,
          attachmentId: row.attachment_id,
          pdfPageNo: row.pdf_page_no,
          title:
            row.kind === 'pdf'
              ? `${row.filename ?? 'PDF'} — p.${row.pdf_page_no}`
              : row.page_title || '無題',
          excerpt: row.text.slice(0, 160),
          score,
        },
      });
    }

    return NextResponse.json({
      hits: [...best.values()].sort((a, b) => b.score - a.score).slice(0, 6).map((e) => e.hit),
    });
  } catch (err) {
    // The model may still be downloading. Keyword search carries the palette
    // until it is ready, so this is not worth surfacing as an error.
    console.error('[search/semantic]', (err as Error).message);
    return NextResponse.json({ hits: [], unavailable: true });
  }
}
