import path from 'node:path';
import fs from 'node:fs';
import { dataDir } from '../db/client';
import { normalize } from '../search/normalize';
import { isCjk } from '../search/ngram';
import type { PdfDocument } from './extract';

/**
 * OCR for pages with no usable text layer.
 *
 * One worker is reused for the whole run: tesseract's init costs several
 * seconds, and a 200-page scan would otherwise spend most of its time starting
 * workers. It is torn down once the queue goes idle.
 */

type TessWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

let workerPromise: Promise<TessWorker> | null = null;

function tessdataDir(): string {
  const dir = path.join(dataDir(), 'models', 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const OCR_LANGS = 'jpn+eng';

/**
 * True when every language file is already staged locally.
 *
 * This matters more than it looks: passing `langPath` makes tesseract.js treat
 * that directory as the only source and never fall back to downloading, so
 * pointing it at an empty directory fails with ENOENT — asynchronously, inside
 * the worker, where it is easy to miss. So langPath is only ever set once the
 * files are actually there; otherwise tesseract downloads and caches them.
 */
function hasLocalTessdata(): boolean {
  const dir = tessdataDir();
  return OCR_LANGS.split('+').every(
    (lang) =>
      fs.existsSync(path.join(dir, `${lang}.traineddata`)) ||
      fs.existsSync(path.join(dir, `${lang}.traineddata.gz`)),
  );
}

async function getWorker(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const dir = tessdataDir();
      // Languages go in as one '+'-joined string: an array makes tesseract.js
      // emit a spurious "Error opening data file ./.traineddata" warning.
      const worker = await createWorker(OCR_LANGS, 1, {
        ...(hasLocalTessdata() ? { langPath: dir } : {}),
        cachePath: dir,
        gzip: true,
        legacyCore: false,
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

export async function terminateOcrWorker(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  if (current) {
    try {
      await (await current).terminate();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Tesseract inserts spaces between CJK glyphs. Left in, they break the bigram
 * index: 「予 算」 would never match a search for 予算.
 */
export function stripCjkSpaces(text: string): string {
  return text.replace(/(.)[ \t]+(.)/gu, (match, a: string, b: string) =>
    isCjk(a) && isCjk(b) ? a + b : match,
  );
}

/**
 * A page must never be able to stall the queue indefinitely. Worker startup
 * can involve a ~27MB language download, so the budget is generous, but finite.
 */
const OCR_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function ocrImage(png: Buffer): Promise<{ text: string; confidence: number }> {
  const worker = await withTimeout(getWorker(), OCR_TIMEOUT_MS, 'OCR worker startup');
  const { data } = await withTimeout(worker.recognize(png), OCR_TIMEOUT_MS, 'OCR');
  return {
    text: normalize(stripCjkSpaces(data.text)),
    confidence: data.confidence ?? 0,
  };
}

/** Render one PDF page to a grayscale PNG sized for OCR. */
export async function renderPageForOcr(doc: PdfDocument, pageNo: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await doc.getPage(pageNo);

  // 300 DPI is the practical floor for Japanese glyphs; below ~200 accuracy
  // falls off sharply. The cap keeps a long document from growing the heap:
  // a raw 300-DPI A4 RGBA canvas is ~35MB on its own.
  const MAX_SIDE = 2500;
  const base = page.getViewport({ scale: 300 / 72 });
  const scale = Math.min(1, MAX_SIDE / Math.max(base.width, base.height)) * (300 / 72);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;

  const png = canvas.toBuffer('image/png');
  page.cleanup();
  return Buffer.from(png);
}
