import path from 'node:path';
import { createRequire } from 'node:module';
import { normalize } from '../search/normalize';

const require_ = createRequire(import.meta.url);

export type PdfTextPage = {
  pageNo: number;
  text: string;
  width: number;
  height: number;
};

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

function pdfjs(): Promise<PdfjsModule> {
  // The legacy build is the one meant for Node; the modern build assumes DOM APIs.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** Resource directories that ship inside pdfjs-dist. */
function pdfjsAssets() {
  const base = path.dirname(require_.resolve('pdfjs-dist/package.json'));
  return {
    cMapUrl: `${path.join(base, 'cmaps')}${path.sep}`,
    standardFontDataUrl: `${path.join(base, 'standard_fonts')}${path.sep}`,
  };
}

export type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;

export type OpenPdf = {
  doc: PdfDocument;
  /** Aborts the worker. In pdf.js v6 destroy() is on the loading task, not the doc. */
  close: () => Promise<void>;
};

export async function loadPdf(data: Uint8Array): Promise<OpenPdf> {
  const { getDocument } = await pdfjs();
  const { cMapUrl, standardFontDataUrl } = pdfjsAssets();

  const task = getDocument({
    data,
    // Without cMapUrl + cMapPacked, getTextContent() on Adobe-Japan1 encoded
    // PDFs returns empty strings or mojibake — silently, with no error. Every
    // page then looks like a scan and gets sent to OCR, which makes the whole
    // feature seem broken and slow. This is the single most important setting
    // in the ingest path for Japanese documents.
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  });

  return { doc: await task.promise, close: () => task.destroy() };
}

/**
 * Join the text items of one page.
 *
 * pdf.js emits positioned runs, not lines, so `hasEOL` is the only signal for
 * where a line actually ends. Japanese has no inter-word spaces, so runs are
 * concatenated directly rather than space-joined — inserting spaces would
 * corrupt the bigram index.
 */
export function joinTextItems(items: { str: string; hasEOL?: boolean }[]): string {
  let out = '';
  for (const item of items) {
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return normalize(out.replace(/\n{3,}/g, '\n\n'));
}

export async function extractTextLayer(data: Uint8Array): Promise<PdfTextPage[]> {
  const { doc, close } = await loadPdf(data);
  const pages: PdfTextPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      pages.push({
        pageNo: i,
        text: joinTextItems(content.items as { str: string; hasEOL?: boolean }[]),
        width: viewport.width,
        height: viewport.height,
      });
      page.cleanup();
    }
  } finally {
    await close();
  }
  return pages;
}
