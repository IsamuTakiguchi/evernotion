'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconFile, IconSpinner, IconTrash } from '@/components/ui/Icons';

type ArchivedPage = {
  id: string;
  title: string;
  icon: string | null;
  archivedAt: string;
  excerpt: string;
  descendants: number;
};

export default function TrashPage() {
  const [pages, setPages] = useState<ArchivedPage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ pages: ArchivedPage[] }>('/api/pages/archived')
      .then((r) => setPages(r.pages))
      .catch(() => setPages([]));
  }, []);

  useEffect(load, [load]);

  const restore = async (page: ArchivedPage) => {
    setBusy(page.id);
    try {
      await api.del(`/api/pages/${page.id}/archive`);
      load();
      window.dispatchEvent(new CustomEvent('ev:pages-changed'));
    } finally {
      setBusy(null);
    }
  };

  const destroy = async (page: ArchivedPage) => {
    const extra = page.descendants > 0 ? `と子ページ${page.descendants}件` : '';
    if (!confirm(`「${page.title || '無題'}」${extra}を完全に削除します。元に戻せません。`)) return;
    setBusy(page.id);
    try {
      await api.del(`/api/pages/${page.id}`);
      load();
      window.dispatchEvent(new CustomEvent('ev:pages-changed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-8 lg:px-10 lg:py-12">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <IconTrash size={21} />
        ゴミ箱
      </h1>
      <p className="mb-6 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        削除したノートはここに残ります。元に戻すか、完全に削除できます。
      </p>

      {pages === null ? (
        <IconSpinner size={16} className="opacity-50" />
      ) : pages.length === 0 ? (
        <p className="text-[14px]" style={{ color: 'var(--text-faint)' }}>
          ゴミ箱は空です。
        </p>
      ) : (
        <div className="space-y-2">
          {pages.map((page) => (
            <div
              key={page.id}
              className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[14px] font-medium">
                  {page.icon ? <span>{page.icon}</span> : <IconFile size={13} />}
                  <span className="truncate">{page.title || '無題'}</span>
                  {page.descendants > 0 && (
                    <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                      +{page.descendants}件
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {page.excerpt || '（本文なし）'}
                </div>
                <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                  {page.archivedAt} に削除
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => void restore(page)}
                  disabled={busy === page.id}
                  className="rounded border px-2.5 py-1 text-[12.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                >
                  元に戻す
                </button>
                <button
                  onClick={() => void destroy(page)}
                  disabled={busy === page.id}
                  className="rounded border px-2.5 py-1 text-[12.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  style={{ color: 'var(--danger)' }}
                >
                  完全に削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
