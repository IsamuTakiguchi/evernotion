'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconPdf, IconSpinner } from '@/components/ui/Icons';

export type AttachmentStatus = {
  id: string;
  filename: string;
  status: 'pending' | 'extracting' | 'ocr' | 'ready' | 'error';
  progress: number;
  pageCount: number | null;
  ocrPages: number;
  error: string | null;
};

const LABEL: Record<AttachmentStatus['status'], string> = {
  pending: '待機中',
  extracting: 'テキスト抽出中',
  ocr: 'OCR解析中',
  ready: '検索可能',
  error: 'エラー',
};

/**
 * A PDF attachment as a block.
 *
 * renderText() returns '' on purpose: the PDF's text lives in pdf_pages and is
 * indexed there, so repeating it in the note body would double-count every
 * document in search results.
 */
export const PdfBlock = Node.create({
  name: 'pdfAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      filename: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-pdf-attachment]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-pdf-attachment': '' })];
  },

  renderText() {
    return '';
  },

  addNodeView() {
    return ReactNodeViewRenderer(PdfBlockView);
  },
});

function PdfBlockView({ node }: NodeViewProps) {
  const attachmentId = node.attrs.attachmentId as string | null;
  const filename = (node.attrs.filename as string) || 'PDF';
  const [status, setStatus] = useState<AttachmentStatus | null>(null);

  // Poll while the document is still being parsed or OCR'd, then stop.
  useEffect(() => {
    if (!attachmentId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const r = await api.get<{ attachment: AttachmentStatus }>(`/api/attachments/${attachmentId}`);
        if (stop) return;
        setStatus(r.attachment);
        if (r.attachment.status !== 'ready' && r.attachment.status !== 'error') {
          timer = setTimeout(tick, 1200);
        }
      } catch {
        if (!stop) timer = setTimeout(tick, 3000);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [attachmentId]);

  const busy = status && status.status !== 'ready' && status.status !== 'error';

  return (
    <NodeViewWrapper
      className="my-2 rounded-lg border"
      style={{ background: 'var(--bg-subtle)' }}
      data-drag-handle
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <IconPdf size={22} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{filename}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {busy && <IconSpinner size={12} />}
            <span>{status ? LABEL[status.status] : '読み込み中'}</span>
            {status?.pageCount ? <span>· {status.pageCount}ページ</span> : null}
            {status && status.ocrPages > 0 ? <span>· OCR {status.ocrPages}ページ</span> : null}
            {status?.error ? <span style={{ color: 'var(--danger)' }}>· {status.error}</span> : null}
          </div>
        </div>
        {attachmentId && (
          <a
            href={`/api/attachments/${attachmentId}/file`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded border px-2.5 py-1 text-[12.5px] hover:bg-[var(--bg-hover)]"
          >
            開く
          </a>
        )}
      </div>

      {busy && (
        <div className="h-1 overflow-hidden rounded-b-lg" style={{ background: 'var(--bg-active)' }}>
          <div
            className="h-full transition-[width] duration-300"
            style={{ width: `${Math.round((status?.progress ?? 0) * 100)}%`, background: 'var(--accent)' }}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}
