'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Editor } from './Editor';
import { api } from '@/lib/client/api';
import { BacklinksPanel } from '@/components/layout/BacklinksPanel';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { AiPanel } from '@/components/ai/AiPanel';
import type { JSONContent } from '@/lib/editor/doc';
import { IconLink, IconSparkles } from '@/components/ui/Icons';

export type Backlink = { id: string; title: string; icon: string | null; snippet: string };

export type PageData = {
  page: {
    id: string;
    title: string;
    icon: string | null;
    doc: JSONContent;
    updated_at: string;
  };
  backlinks: Backlink[];
  unresolved: string[];
};

const EMOJI_CHOICES = ['📝', '📁', '📚', '💡', '🧠', '📌', '✅', '🔍', '⚖️', '📊', '🗓️', '🏷️'];

export function PageView({ initial }: { initial: PageData }) {
  const params = useSearchParams();
  const [title, setTitle] = useState(initial.page.title);
  const [icon, setIcon] = useState(initial.page.icon);
  const [backlinks, setBacklinks] = useState(initial.backlinks);
  const [unresolved, setUnresolved] = useState(initial.unresolved);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [side, setSide] = useState<'links' | 'ai'>('links');

  const fileId = params.get('file');
  const filePage = Number(params.get('page') ?? 1);
  const highlight = params.get('q') ?? '';

  const refreshLinks = useCallback(async () => {
    try {
      const r = await api.get<PageData>(`/api/pages/${initial.page.id}`);
      setBacklinks(r.backlinks);
      setUnresolved(r.unresolved);
    } catch {
      /* keep what we have */
    }
  }, [initial.page.id]);

  // Reset local state when navigating between pages (the component is reused).
  useEffect(() => {
    setTitle(initial.page.title);
    setIcon(initial.page.icon);
    setBacklinks(initial.backlinks);
    setUnresolved(initial.unresolved);
  }, [initial]);

  const saveMeta = useCallback(
    async (patch: { title?: string; icon?: string | null }) => {
      await api.patch(`/api/pages/${initial.page.id}`, patch);
      window.dispatchEvent(new CustomEvent('ev:pages-changed'));
    },
    [initial.page.id],
  );

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-5 py-8 sm:px-10 lg:px-14 lg:py-14">
          <div className="relative mb-1">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="mb-2 rounded px-1.5 py-1 text-[34px] leading-none hover:bg-[var(--bg-hover)]"
              title="アイコンを変更"
            >
              {icon ?? <span className="text-[15px]" style={{ color: 'var(--text-faint)' }}>＋ アイコン</span>}
            </button>
            {pickerOpen && (
              <div
                className="absolute left-0 top-full z-30 flex w-64 flex-wrap gap-1 rounded-lg border p-2"
                style={{ background: 'var(--bg)', boxShadow: 'var(--shadow)' }}
              >
                {EMOJI_CHOICES.map((e) => (
                  <button
                    key={e}
                    className="rounded p-1.5 text-[20px] hover:bg-[var(--bg-hover)]"
                    onClick={() => {
                      setIcon(e);
                      setPickerOpen(false);
                      void saveMeta({ icon: e });
                    }}
                  >
                    {e}
                  </button>
                ))}
                <button
                  className="rounded px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={() => {
                    setIcon(null);
                    setPickerOpen(false);
                    void saveMeta({ icon: null });
                  }}
                >
                  削除
                </button>
              </div>
            )}
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveMeta({ title })}
            placeholder="無題"
            className="mb-4 w-full bg-transparent text-[30px] font-bold leading-tight tracking-tight outline-none placeholder:text-[var(--text-faint)] sm:text-[40px]"
          />

          {fileId && (
            <div className="mb-6">
              <PdfViewer attachmentId={fileId} initialPage={filePage} highlight={highlight} />
            </div>
          )}

          <Editor pageId={initial.page.id} initialDoc={initial.page.doc} onSaved={refreshLinks} />
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l xl:block">
        <div className="flex border-b text-[13px]">
          <TabButton active={side === 'links'} onClick={() => setSide('links')} icon={<IconLink size={14} />} label="リンク" />
          <TabButton active={side === 'ai'} onClick={() => setSide('ai')} icon={<IconSparkles size={14} />} label="AI" />
        </div>
        {side === 'links' ? (
          <BacklinksPanel backlinks={backlinks} unresolved={unresolved} />
        ) : (
          <AiPanel pageId={initial.page.id} />
        )}
      </aside>
    </div>
  );
}

function TabButton({
  active, onClick, icon, label,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center justify-center gap-1.5 py-2.5"
      style={{
        color: active ? 'var(--text)' : 'var(--text-muted)',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
