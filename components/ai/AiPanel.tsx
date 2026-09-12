'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { IconFile, IconSparkles, IconSpinner } from '@/components/ui/Icons';

type Related = { id: string; title: string; icon: string | null; score: number };
type TagSuggestion = { name: string; reason: string };

/**
 * Per-page AI sidebar.
 *
 * Related notes come from local embeddings and therefore work with no API key;
 * tag suggestions and summaries need Claude and hide themselves when no key is
 * configured, rather than failing when clicked.
 */
export function AiPanel({ pageId }: { pageId: string }) {
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [related, setRelated] = useState<Related[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);
  const [tags, setTags] = useState<TagSuggestion[] | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ aiEnabled: boolean }>('/api/ai/status')
      .then((r) => setAiEnabled(r.aiEnabled))
      .catch(() => setAiEnabled(false));
  }, []);

  useEffect(() => {
    setLoadingRelated(true);
    api
      .get<{ related: Related[] }>(`/api/ai/related?pageId=${pageId}`)
      .then((r) => setRelated(r.related))
      .catch(() => setRelated([]))
      .finally(() => setLoadingRelated(false));
  }, [pageId]);

  const suggestTags = async () => {
    setTagBusy(true);
    setError(null);
    try {
      const r = await api.post<{ tags: TagSuggestion[] }>('/api/ai/tags', { pageId });
      setTags(r.tags);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTagBusy(false);
    }
  };

  const makeSummary = async () => {
    setSummaryBusy(true);
    setError(null);
    try {
      const r = await api.post<{ summary: string }>('/api/ai/summary', { pageId });
      setSummary(r.summary);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSummaryBusy(false);
    }
  };

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
          関連するノート
        </h3>
        {loadingRelated ? (
          <IconSpinner size={14} className="opacity-50" />
        ) : related.length === 0 ? (
          <p className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
            まだ十分なノートがありません。書き進めると意味の近いノートがここに出ます。
          </p>
        ) : (
          <div className="space-y-1">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/p/${r.id}`}
                className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] hover:bg-[var(--bg-hover)]"
              >
                {r.icon ? <span>{r.icon}</span> : <IconFile size={13} />}
                <span className="min-w-0 flex-1 truncate">{r.title || '無題'}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {Math.round(r.score * 100)}%
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {aiEnabled === false ? (
        <section className="rounded-lg border p-3" style={{ background: 'var(--bg-subtle)' }}>
          <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium">
            <IconSparkles size={14} />
            AI機能は未設定です
          </h3>
          <p className="mb-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Claude APIキーを登録すると、チャット・自動タグ・要約が使えます。
            検索・PDF・グラフ・関連ノートはキーなしでも動作しています。
          </p>
          <Link href="/settings" className="text-[12.5px] underline" style={{ color: 'var(--accent-text)' }}>
            設定画面を開く
          </Link>
        </section>
      ) : aiEnabled ? (
        <>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                タグ候補
              </h3>
              <button
                onClick={suggestTags}
                disabled={tagBusy}
                className="rounded border px-2 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {tagBusy ? '生成中…' : '提案'}
              </button>
            </div>
            {tags && (
              <div className="flex flex-wrap gap-1.5">
                {tags.length === 0 ? (
                  <span className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>候補なし</span>
                ) : (
                  tags.map((t) => (
                    <span
                      key={t.name}
                      title={t.reason}
                      className="rounded px-2 py-0.5 text-[12px]"
                      style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
                    >
                      #{t.name}
                    </span>
                  ))
                )}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                要約
              </h3>
              <button
                onClick={makeSummary}
                disabled={summaryBusy}
                className="rounded border px-2 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {summaryBusy ? '生成中…' : '生成'}
              </button>
            </div>
            {summary && (
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {summary}
              </p>
            )}
          </section>
        </>
      ) : null}

      {error && (
        <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
