import fs from 'node:fs';
import { getDb } from '../db/client';
import { indexSearchDoc, optimizeIndex } from '../search/index';
import { queueAttachmentIndex } from '../ai/indexer';
import { extractTextLayer, loadPdf, joinTextItems } from './extract';
import { ocrImage, renderPageForOcr } from './ocr';

export type IngestProgress = (patch: {
  status?: 'extracting' | 'ocr' | 'ready' | 'error';
  progress?: number;
  pageCount?: number;
  ocrPages?: number;
  error?: string;
}) => void;

/**
 * A page with almost no extractable text is a scan. The threshold is
 * deliberately low: a scanned page often carries a few characters of header
 * text from a stamp or a form field.
 */
const MIN_CHARS = 20;

/** Share of replacement/private-use characters that means the CMap failed. */
const GARBAGE_RATIO = 0.3;

export function looksLikeGarbage(text: string): boolean {
  if (!text) return false;
  let bad = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '�' || (code >= 0xe000 && code <= 0xf8ff)) bad++;
  }
  return bad / [...text].length > GARBAGE_RATIO;
}

export function needsOcr(text: string): boolean {
  return text.trim().length < MIN_CHARS || looksLikeGarbage(text);
}

export async function ingestPdf(
  attachmentId: string,
  storagePath: string,
  filename: string,
  onProgress: IngestProgress,
): Promise<void> {
  const db = getDb();
  const data = new Uint8Array(fs.readFileSync(storagePath));

  onProgress({ status: 'extracting', progress: 0 });

  const textPages = await extractTextLayer(data);
  onProgress({ pageCount: textPages.length, progress: 0.15 });

  const ocrTargets = textPages.filter((p) => needsOcr(p.text));
  let ocrDone = 0;

  // Only open a render pipeline when something actually needs OCR — a normal
  // digital PDF should never pay that cost.
  let opened: Awaited<ReturnType<typeof loadPdf>> | null = null;
  if (ocrTargets.length > 0) {
    onProgress({ status: 'ocr', ocrPages: ocrTargets.length });
    opened = await loadPdf(new Uint8Array(fs.readFileSync(storagePath)));
  }
  const doc = opened?.doc ?? null;

  try {
    for (const page of textPages) {
      let text = page.text;
      let source: 'text' | 'ocr' = 'text';

      if (doc && needsOcr(text)) {
        try {
          const png = await renderPageForOcr(doc, page.pageNo);
          const result = await ocrImage(png);
          if (result.text.trim().length > text.trim().length) {
            text = result.text;
            source = 'ocr';
          }
        } catch (err) {
          // A single unreadable page must not abandon the rest of the document.
          console.error(`[ingest] OCR failed on page ${page.pageNo}:`, err);
        }
        ocrDone++;
      }

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO pdf_pages (attachment_id, page_no, text, source)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attachment_id, page_no) DO UPDATE SET text = excluded.text, source = excluded.source`,
        ).run(attachmentId, page.pageNo, text, source);

        indexSearchDoc(db, {
          kind: 'pdf',
          attachmentId,
          pdfPageNo: page.pageNo,
          title: `${filename} p.${page.pageNo}`,
          body: text,
        });
      });
      tx();

      // Pages become searchable as they finish, rather than all at the end.
      const base = 0.15 + 0.8 * (page.pageNo / textPages.length);
      onProgress({ progress: Math.min(0.95, base), ocrPages: ocrDone });
    }
  } finally {
    await opened?.close();
  }

  optimizeIndex();
  onProgress({ status: 'ready', progress: 1 });

  // Semantic search over the PDF is built in the background.
  queueAttachmentIndex(attachmentId);
}

export { joinTextItems };
