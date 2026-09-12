'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconChevron, IconSpinner } from '@/components/ui/Icons';

type PdfPageText = { pageNo: number; text: string; source: string };

type Props = {
  attachmentId: string;
  initialPage?: number;
  highlight?: string;
};

type LoadedDoc = Awaited<ReturnType<typeof loadDocument>>;

async function loadDocument(attachmentId: string) {
  // Must run before pdf.js is evaluated: it calls Map#getOrInsertComputed,
  // which no shipped browser has yet.
  await import('@/lib/pdf/map-upsert-polyfill');
  const pdfjs = await import('pdfjs-dist');
  // The worker ships with the package; resolving it through a bundler URL keeps
  // the viewer working offline, with no CDN involved.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();

  // CMaps and the standard fonts are served from /public (put there by
  // scripts/copy-pdfjs-assets.mjs), so Japanese PDFs render with no network.
  const task = pdfjs.getDocument({
    url: `/api/attachments/${attachmentId}/file`,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  });
  return { pdfjs, task, doc: await task.promise };
}

/**
 * Canvas-based PDF viewer with a text layer for selection and highlighting.
 *
 * The document is loaded once per attachment and kept; only the page is
 * re-rendered when paging. Reloading the document per page would both redo the
 * parse and race the in-flight render, which cancels it midway and leaves a
 * half-painted canvas with no text layer at all.
 *
 * Pages that came from OCR have no text layer, so for those the recognised
 * text is offered below the page instead.
 */
export function PdfViewer({ attachmentId, initialPage = 1, highlight = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  /** Measured for the render scale. The canvas wrapper shrinks to the canvas,
      so measuring that instead would be circular. */
  const frameRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<LoadedDoc | null>(null);
  const renderToken = useRef(0);

  const [loaded, setLoaded] = useState(0); // bumped when a document becomes ready
  const [pageNo, setPageNo] = useState(Math.max(1, initialPage));
  const [numPages, setNumPages] = useState(0);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageTexts, setPageTexts] = useState<PdfPageText[]>([]);

  useEffect(() => setPageNo(Math.max(1, initialPage)), [initialPage, attachmentId]);

  useEffect(() => {
    api
      .get<{ pages: PdfPageText[] }>(`/api/attachments/${attachmentId}/pages`)
      .then((r) => setPageTexts(r.pages))
      .catch(() => setPageTexts([]));
  }, [attachmentId]);

  // --- load the document once per attachment ------------------------------
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRendering(true);

    loadDocument(attachmentId)
      .then((loadedDoc) => {
        if (cancelled) {
          void loadedDoc.task.destroy();
          return;
        }
        docRef.current = loadedDoc;
        setNumPages(loadedDoc.doc.numPages);
        setLoaded((n) => n + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        setRendering(false);
      });

    return () => {
      cancelled = true;
      const current = docRef.current;
      docRef.current = null;
      void current?.task.destroy();
    };
  }, [attachmentId]);

  // --- render the current page -------------------------------------------
  useEffect(() => {
    const loadedDoc = docRef.current;
    const canvas = canvasRef.current;
    if (!loadedDoc || !canvas) return;

    // Each run claims a token, so a superseded run drops its results rather
    // than painting over a newer one.
    const token = ++renderToken.current;
    let renderTask: { cancel: () => void } | null = null;
    setRendering(true);

    void (async () => {
      try {
        const clamped = Math.min(Math.max(1, pageNo), loadedDoc.doc.numPages);
        const page = await loadedDoc.doc.getPage(clamped);
        if (token !== renderToken.current) return;

        const available = frameRef.current?.clientWidth || 680;
        const unscaled = page.getViewport({ scale: 1 });
        const scale = available / unscaled.width;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        // pdf.js v6 takes the canvas and obtains its own context; passing both
        // `canvas` and `canvasContext` is unsupported and leaves the render
        // promise unsettled, so the page paints but nothing downstream of the
        // await ever runs. Device-pixel scaling goes through `transform`.
        const task = page.render({
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        renderTask = { cancel: () => task.cancel() };
        await task.promise;
        if (token !== renderToken.current) return;

        const layer = textLayerRef.current;
        if (layer) {
          layer.replaceChildren();
          layer.style.width = `${viewport.width}px`;
          layer.style.height = `${viewport.height}px`;
          // pdf.js sizes the spans from this variable; without it every one of
          // them lands in the wrong place.
          layer.style.setProperty('--scale-factor', String(scale));

          const textContent = await page.getTextContent();
          if (token !== renderToken.current) return;

          const textLayer = new loadedDoc.pdfjs.TextLayer({
            textContentSource: textContent,
            container: layer,
            viewport,
          });
          await textLayer.render();
          if (token !== renderToken.current) return;
          if (highlight) markMatches(layer, highlight);
        }

        page.cleanup();
      } catch (err) {
        const message = (err as Error).message;
        // Cancellation is the normal result of paging quickly, not a failure.
        if (token === renderToken.current && !/cancel/i.test(message)) setError(message);
      } finally {
        if (token === renderToken.current) setRendering(false);
      }
    })();

    return () => renderTask?.cancel();
  }, [loaded, pageNo, highlight]);

  const current = pageTexts.find((p) => p.pageNo === pageNo);
  const isOcr = current?.source === 'ocr';

  return (
    <div className="overflow-hidden rounded-lg border" style={{ background: 'var(--bg-subtle)' }}>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[13px]">
        <button
          onClick={() => setPageNo((p) => Math.max(1, p - 1))}
          disabled={pageNo <= 1}
          className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-30"
          aria-label="前のページ"
        >
          <IconChevron size={15} className="rotate-180" />
        </button>
        <span style={{ color: 'var(--text-muted)' }}>
          {pageNo} / {numPages || '…'}
        </span>
        <button
          onClick={() => setPageNo((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))}
          disabled={!!numPages && pageNo >= numPages}
          className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-30"
          aria-label="次のページ"
        >
          <IconChevron size={15} />
        </button>
        {isOcr && (
          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
          >
            OCR
          </span>
        )}
        {rendering && <IconSpinner size={14} className="ml-auto opacity-60" />}
      </div>

      <div ref={frameRef} className="w-full">
        <div className="relative mx-auto w-fit" style={{ background: '#fff' }}>
          <canvas ref={canvasRef} className="block max-w-full" />
          <div ref={textLayerRef} className="pdf-text-layer absolute left-0 top-0" />
        </div>
      </div>

      {error && (
        <p className="px-3 py-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>
          PDFの表示に失敗しました: {error}
        </p>
      )}

      {isOcr && current?.text && (
        <details className="border-t px-3 py-2 text-[12.5px]">
          <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            OCRで読み取ったテキスト
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">
            {highlight ? highlightText(current.text, highlight) : current.text}
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * Wrap occurrences of the term in the rendered text-layer spans.
 *
 * pdf.js emits one span per positioned run, so a term split across two runs is
 * missed; matching within each span covers the common case without disturbing
 * the layout pdf.js computed.
 */
function markMatches(layer: HTMLElement, term: string) {
  const needle = term.trim().toLowerCase();
  if (!needle) return;
  for (const span of Array.from(layer.querySelectorAll('span'))) {
    const text = span.textContent ?? '';
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    span.replaceChildren(
      document.createTextNode(text.slice(0, at)),
      mark,
      document.createTextNode(text.slice(at + needle.length)),
    );
  }
}

function highlightText(text: string, term: string) {
  const needle = term.trim();
  if (!needle) return text;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === needle.toLowerCase() ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
  );
}
