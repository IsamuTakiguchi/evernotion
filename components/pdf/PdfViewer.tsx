'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconChevron, IconSpinner } from '@/components/ui/Icons';

type PdfPageText = { pageNo: number; text: string; source: string };

type Props = {
  attachmentId: string;
  initialPage?: number;
  highlight?: string;
};

/**
 * Canvas-based PDF viewer.
 *
 * Renders with pdf.js in the browser and, on top of it, positions the text
 * layer so a search term can be highlighted. Pages that came from OCR have no
 * text layer at all, so for those the extracted text is shown beneath the page
 * instead — the match is still visible, just not overlaid on the image.
 */
export function PdfViewer({ attachmentId, initialPage = 1, highlight = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTask = useRef<{ cancel: () => void } | null>(null);
  const [pageNo, setPageNo] = useState(Math.max(1, initialPage));
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageTexts, setPageTexts] = useState<PdfPageText[]>([]);

  useEffect(() => setPageNo(Math.max(1, initialPage)), [initialPage, attachmentId]);

  useEffect(() => {
    api
      .get<{ pages: PdfPageText[] }>(`/api/attachments/${attachmentId}/pages`)
      .then((r) => setPageTexts(r.pages))
      .catch(() => setPageTexts([]));
  }, [attachmentId]);

  const render = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pdfjs = await import('pdfjs-dist');
      // The worker ships with the package; point at it via a bundler URL so no
      // CDN is involved and the viewer works offline.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.mjs',
        import.meta.url,
      ).toString();

      // cMaps and the standard fonts are served from /public, so Japanese PDFs
      // render correctly with no CDN and no network.
      const loadingTask = pdfjs.getDocument({
        url: `/api/attachments/${attachmentId}/file`,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      });
      const doc = await loadingTask.promise;

      setNumPages(doc.numPages);
      const clamped = Math.min(Math.max(1, pageNo), doc.numPages);
      const page = await doc.getPage(clamped);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const container = canvas.parentElement!;
      const unscaled = page.getViewport({ scale: 1 });
      const scale = (container.clientWidth || 680) / unscaled.width;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      renderTask.current?.cancel();
      const task = page.render({ canvasContext: ctx, viewport, canvas });
      renderTask.current = { cancel: () => task.cancel() };
      await task.promise;

      // Text layer, for selection and highlighting.
      const layer = textLayerRef.current;
      if (layer) {
        layer.replaceChildren();
        layer.style.width = `${viewport.width}px`;
        layer.style.height = `${viewport.height}px`;
        const textContent = await page.getTextContent();
        const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: layer, viewport });
        await textLayer.render();
        if (highlight) markMatches(layer, highlight);
      }

      await loadingTask.destroy();
    } catch (err) {
      const message = (err as Error).message;
      // A cancelled render is the expected result of paging quickly.
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setLoading(false);
    }
  }, [attachmentId, pageNo, highlight]);

  useEffect(() => {
    void render();
    return () => renderTask.current?.cancel();
  }, [render]);

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
          <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
            OCR
          </span>
        )}
        {loading && <IconSpinner size={14} className="ml-auto opacity-60" />}
      </div>

      <div className="relative mx-auto" style={{ background: '#fff' }}>
        <canvas ref={canvasRef} className="block max-w-full" />
        <div
          ref={textLayerRef}
          className="pdf-text-layer pointer-events-none absolute left-0 top-0"
          aria-hidden="true"
        />
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

/** Wrap occurrences of the term in the rendered text layer spans. */
function markMatches(layer: HTMLElement, term: string) {
  const needle = term.trim().toLowerCase();
  if (!needle) return;
  for (const span of Array.from(layer.querySelectorAll('span'))) {
    const text = span.textContent ?? '';
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    span.replaceChildren(
      document.createTextNode(text.slice(0, at)),
      Object.assign(document.createElement('mark'), { textContent: text.slice(at, at + needle.length) }),
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
