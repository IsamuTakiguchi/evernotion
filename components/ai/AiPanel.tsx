'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { IconFile, IconPlus, IconSparkles, IconSpinner, IconX } from '@/components/ui/Icons';

type Related = { id: string; title: string; icon: string | null; score: number };
type TagSuggestion = { name: string; reason: string };
type PageTag = { name: string; source: string };

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
  const [applied, setApplied] = useState<PageTag[]>([]);
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

  const loadTags = useCallback(() => {
    api
      .get<{ tags: PageTag[] }>(`/api/pages/${pageId}/tags`)
      .then((r) => setApplied(r.tags))
      .catch(() => setApplied([]));
  }, [pageId]);

  useEffect(() => {
    setTags(null);
    loadTags();
  }, [loadTags]);

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

  const toggleTag = async (name: string, add: boolean) => {
    setError(null);
    try {
      const r = await api.post<{ tags: PageTag[] }>(`/api/pages/${pageId}/tags`, {
        [add ? 'add' : 'remove']: [name],
        source: 'ai',
      });
      setApplied(r.tags);
    } catch (err) {
      setError((err as Error).message);
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
                className="ev-row flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--bg-hover)]"
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

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              タグ
            </h3>
          {aiEnabled && (
            <button
              onClick={suggestTags}
              disabled={tagBusy}
              className="ev-btn rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              title="Claudeにタグを提案してもらう"
            >
              {tagBusy ? '生成中…' : 'AIに提案してもらう'}
            </button>
          )}
          </div>
          {applied.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {applied.map((t) => (
                <span
                  key={t.name}
                  className="ev-anim-pop flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px]"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
                >
                  #{t.name}
                  {/* An inline #tag belongs to the document, so it can only be
                      removed by editing the note itself. */}
                  {t.source !== 'inline' && (
                    <button
                      onClick={() => void toggleTag(t.name, false)}
                      aria-label={`#${t.name} を外す`}
                      title="外す"
                      className="opacity-60 hover:opacity-100"
                    >
                      <IconX size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

        {tags && (
            <div className="flex flex-wrap gap-1.5">
              {tags.filter((t) => !applied.some((a) => a.name === t.name)).length === 0 ? (
                <span className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
                  {tags.length === 0 ? '候補なし' : 'すべて追加済み'}
                </span>
              ) : (
                tags
                  .filter((t) => !applied.some((a) => a.name === t.name))
                  .map((t) => (
                    <button
                      key={t.name}
                      title={t.reason}
                      onClick={() => void toggleTag(t.name, true)}
                      className="ev-lift flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-[12px] hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <IconPlus size={10} />
                      {t.name}
                    </button>
                  ))
              )}
            </div>
          )}
          {applied.length === 0 && !tags && (
          <p className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
            本文に <code>#タグ名</code> と書くか、右上から追加できます。
          </p>
        )}
      </section>

      {aiEnabled === false ? (
        <section className="ev-glass ev-glass-edge relative rounded-xl border p-3">
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
                要約
              </h3>
              <button
                onClick={makeSummary}
                disabled={summaryBusy}
                className="ev-btn rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
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
