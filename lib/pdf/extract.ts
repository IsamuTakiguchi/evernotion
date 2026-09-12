import fs from 'node:fs';
import path from 'node:path';
import { normalize } from '../search/normalize';

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

/**
 * Locate pdf.js's CMap tables and standard fonts on disk.
 *
 * Deliberately not require.resolve(): under a bundler that returns a numeric
 * module id rather than a path, which fails at runtime in the production build
 * only. These are copied into public/ at install and build time
 * (scripts/copy-pdfjs-assets.mjs), which is also where the browser viewer
 * loads them from.
 */
let assetsCache: { cMapUrl: string; standardFontDataUrl: string } | null = null;

function pdfjsAssets() {
  if (assetsCache) return assetsCache;

  const roots = [
    path.join(process.cwd(), 'public', 'pdfjs'),
    path.join(process.cwd(), 'node_modules', 'pdfjs-dist'),
  ];
  const base = roots.find((dir) => fs.existsSync(path.join(dir, 'cmaps')));
  if (!base) {
    throw new Error(
      'pdf.js assets not found. Run "npm run pdfjs-assets" to copy them into public/pdfjs. ' +
        'Without the CMap tables, Japanese PDFs extract as empty text.',
    );
  }

  assetsCache = {
    cMapUrl: `${path.join(base, 'cmaps')}${path.sep}`,
    standardFontDataUrl: `${path.join(base, 'standard_fonts')}${path.sep}`,
  };
  return assetsCache;
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
