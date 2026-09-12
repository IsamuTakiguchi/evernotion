'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { IconFile, IconPdf, IconSearch, IconSpinner } from '@/components/ui/Icons';

export type SnippetRun = { text: string; mark: boolean };

export type SearchHit = {
  kind: 'page' | 'pdf';
  pageId: string | null;
  title: string;
  icon: string | null;
  attachmentId: string | null;
  filename: string | null;
  pdfPageNo: number | null;
  snippet: SnippetRun[];
  score: number;
};

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&live=1`)
        .then((r) => {
          if (cancelled) return;
          setHits(r.hits);
          setActive(0);
        })
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setLoading(false));
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const open = (hit: SearchHit) => {
    if (hit.kind === 'pdf' && hit.attachmentId) {
      const target = hit.pageId ? `/p/${hit.pageId}` : '/';
      router.push(
        `${target}?file=${hit.attachmentId}&page=${hit.pdfPageNo ?? 1}&q=${encodeURIComponent(q)}`,
      );
    } else if (hit.pageId) {
      router.push(`/p/${hit.pageId}?q=${encodeURIComponent(q)}`);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter during IME composition confirms a candidate; it is not a selection.
    if (composing.current || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      open(hits[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[12vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border"
        style={{ background: 'var(--bg)', boxShadow: 'var(--shadow)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4">
          <IconSearch size={17} className="shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={onKeyDown}
            placeholder="ノートとPDFの中身を検索…"
            className="w-full bg-transparent py-3.5 text-[15px] outline-none"
          />
          {loading && <IconSpinner size={15} className="shrink-0 opacity-60" />}
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {q.trim() && !loading && hits.length === 0 && (
            <p className="px-4 py-8 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              「{q}」に一致する結果はありません
            </p>
          )}
          {!q.trim() && (
            <p className="px-4 py-8 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
              日本語も2文字から検索できます。<code>tag:名前</code> や <code>kind:pdf</code> で絞り込み。
            </p>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.kind}-${hit.pageId ?? hit.attachmentId}-${hit.pdfPageNo ?? 0}-${i}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => open(hit)}
              className="flex w-full gap-3 border-b px-4 py-3 text-left last:border-b-0"
              style={{ background: i === active ? 'var(--bg-hover)' : undefined }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: 'var(--text-faint)' }}>
                {hit.kind === 'pdf' ? <IconPdf size={16} /> : hit.icon ? (
                  <span className="text-[15px]">{hit.icon}</span>
                ) : (
                  <IconFile size={16} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{hit.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {hit.snippet.map((run, j) =>
                    run.mark ? (
                      <mark key={j}>{run.text}</mark>
                    ) : (
                      <span key={j}>{run.text}</span>
                    ),
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
