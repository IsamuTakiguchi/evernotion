'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconSpinner } from '@/components/ui/Icons';

type ImportProgress = {
  id: string;
  source: 'evernote' | 'notion';
  filename: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  notes: number;
  attachments: number;
  skipped: number;
  error: string | null;
  createdAt: string;
};

const SOURCE_LABEL: Record<string, string> = { evernote: 'Evernote', notion: 'Notion' };

/**
 * Importing an existing Evernote or Notion export.
 *
 * The upload is sent as the raw request body rather than through FormData:
 * the server streams it to disk, and a multipart body would have to be held
 * in memory in full at both ends first.
 */
export function ImportPanel() {
  const [imports, setImports] = useState<ImportProgress[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const active = imports.find((i) => i.status === 'pending' || i.status === 'running');

  const load = () => {
    api.get<{ imports: ImportProgress[] }>('/api/import')
      .then((r) => setImports(r.imports))
      .catch(() => undefined);
  };

  useEffect(load, []);

  // Only poll while something is running; an idle settings page should not
  // wake the server every second forever.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [active?.id, active?.status]);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `取り込みを開始できませんでした (${res.status})`);
        return;
      }
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[15px] font-medium">インポート</h2>
      <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Evernote の <code>.enex</code> か、Notion の書き出し ZIP（Markdown &amp; CSV）を取り込みます。
        添付ファイルも一緒に入り、PDFは中の文字まで検索できるようになります。1ファイル 500MB まで。
      </p>

      <div className="flex items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".enex,.zip,application/zip,text/xml"
          disabled={uploading || !!active}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="text-[13px] file:mr-2 file:rounded-lg file:border file:px-3 file:py-1.5 file:text-[13px] disabled:opacity-50"
        />
        {uploading && <IconSpinner size={14} />}
      </div>

      {error && (
        <p className="mt-2 text-[13px]" style={{ color: 'var(--danger)' }}>{error}</p>
      )}

      {imports.length > 0 && (
        <div className="mt-4 space-y-2">
          {imports.map((job) => <ImportRow key={job.id} job={job} />)}
        </div>
      )}
    </section>
  );
}

function ImportRow({ job }: { job: ImportProgress }) {
  const running = job.status === 'pending' || job.status === 'running';
  // total is unknown while an .enex is still being read, so the bar only
  // appears once there is a real proportion to show.
  const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="ev-glass ev-glass-edge relative rounded-xl border px-3 py-2 text-[13px]">
      <div className="flex items-center gap-2">
        {running && <IconSpinner size={13} />}
        <span className="font-medium">{decodeURIComponent(job.filename)}</span>
        <span style={{ color: 'var(--text-faint)' }}>{SOURCE_LABEL[job.source] ?? job.source}</span>
      </div>

      {running && (
        <div className="mt-1.5" style={{ color: 'var(--text-muted)' }}>
          {pct === null
            ? `読み込み中… ノート ${job.notes} 件`
            : `${job.done} / ${job.total} 件`}
          {pct !== null && (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-hover)' }}>
              <div className="h-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
            </div>
          )}
        </div>
      )}

      {job.status === 'done' && (
        <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
          ノート {job.notes} 件、添付 {job.attachments} 件を取り込みました
          {job.skipped > 0 && `（${job.skipped} 件は対象外）`}
          。PDFの解析は引き続き裏で進みます。
        </div>
      )}

      {job.status === 'error' && (
        <div className="mt-1" style={{ color: 'var(--danger)' }}>
          {job.error ?? '取り込みに失敗しました'}
          {job.notes > 0 && `（${job.notes} 件までは取り込み済みです）`}
        </div>
      )}
    </div>
  );
}
