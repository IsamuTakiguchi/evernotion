'use client';

import Link from 'next/link';
import { IconFile, IconLink } from '@/components/ui/Icons';

type Backlink = { id: string; title: string; icon: string | null; snippet: string };

export function BacklinksPanel({
  backlinks, unresolved,
}: { backlinks: Backlink[]; unresolved: string[] }) {
  return (
    <div className="p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        <IconLink size={12} />
        バックリンク {backlinks.length > 0 && `(${backlinks.length})`}
      </h3>

      {backlinks.length === 0 ? (
        <p className="mb-6 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
          このノートを参照しているノートはまだありません。
        </p>
      ) : (
        <div className="mb-6 space-y-1.5">
          {backlinks.map((b) => (
            <Link
              key={b.id}
              href={`/p/${b.id}`}
              className="block rounded border px-2.5 py-2 hover:bg-[var(--bg-hover)]"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                {b.icon ? <span>{b.icon}</span> : <IconFile size={12} />}
                <span className="truncate">{b.title || '無題'}</span>
              </span>
              <span className="mt-1 block text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {b.snippet}
              </span>
            </Link>
          ))}
        </div>
      )}

      {unresolved.length > 0 && (
        <>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
            未作成のリンク
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {unresolved.map((t) => (
              <span
                key={t}
                className="rounded border border-dashed px-2 py-0.5 text-[12px]"
                style={{ color: 'var(--text-faint)' }}
              >
                {t}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
