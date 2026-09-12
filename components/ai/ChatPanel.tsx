'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { IconFile, IconPdf, IconSparkles, IconSpinner } from '@/components/ui/Icons';

type Source = {
  id: string;
  kind: 'page' | 'pdf';
  pageId: string | null;
  attachmentId: string | null;
  pdfPageNo: number | null;
  title: string;
  text: string;
};

type Turn = {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  streaming?: boolean;
};

export function ChatPanel() {
  const [status, setStatus] = useState<{ aiEnabled: boolean; embeddedChunks: number } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [deep, setDeep] = useState(false);
  const composing = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ aiEnabled: boolean; embeddedChunks: number }>('/api/ai/status')
      .then(setStatus)
      .catch(() => setStatus({ aiEnabled: false, embeddedChunks: 0 }));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);

    const history = turns
      .filter((t) => !t.streaming)
      .map((t) => ({ role: t.role, content: t.content }));

    setTurns((t) => [
      ...t,
      { role: 'user', content: message },
      { role: 'assistant', content: '', streaming: true },
    ]);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, deep }),
      });

      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setTurns((t) => {
          const next = [...t];
          next[next.length - 1] = {
            role: 'assistant',
            content: err.error ?? `エラー: ${res.status}`,
          };
          return next;
        });
        return;
      }

      // Parse the SSE stream by hand: this is a plain ReadableStream, and
      // EventSource cannot issue a POST.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(7).trim();
          const payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;

          setTurns((t) => {
            const next = [...t];
            const last = { ...next[next.length - 1] };
            if (event === 'sources') last.sources = payload.sources as Source[];
            else if (event === 'delta') last.content += payload.text as string;
            else if (event === 'done') last.streaming = false;
            else if (event === 'error') {
              last.content += `\n\n(エラー: ${String(payload.message)})`;
              last.streaming = false;
            }
            next[next.length - 1] = last;
            return next;
          });
        }
      }
    } catch (err) {
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = { role: 'assistant', content: `通信エラー: ${(err as Error).message}` };
        return next;
      });
    } finally {
      setBusy(false);
      setTurns((t) => t.map((turn) => ({ ...turn, streaming: false })));
    }
  };

  if (status && !status.aiEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-10 py-20">
        <h1 className="mb-3 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <IconSparkles size={22} />
          AIチャット
        </h1>
        <div className="rounded-lg border p-5" style={{ background: 'var(--bg-subtle)' }}>
          <p className="mb-3 text-[14px] leading-relaxed">
            Claude APIキーが未設定のため、チャットは利用できません。
          </p>
          <p className="mb-4 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            検索・PDFの全文検索・OCR・リンク・グラフ・関連ノートの提案は、
            APIキーがなくても今すぐ使えます（埋め込みはこの端末の中で計算しています）。
          </p>
          <Link
            href="/settings"
            className="inline-block rounded px-3 py-1.5 text-[13px] text-white"
            style={{ background: 'var(--accent)' }}
          >
            設定画面でAPIキーを登録
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col px-8">
      <header className="flex items-center gap-2 py-5">
        <IconSparkles size={20} />
        <h1 className="text-[17px] font-semibold tracking-tight">AIチャット</h1>
        <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          ノートとPDFを根拠に回答します
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
          じっくり考える
        </label>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4">
        {turns.length === 0 && (
          <div className="rounded-lg border p-5 text-[13.5px] leading-relaxed" style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}>
            <p className="mb-2">保存したノートとPDFの中身だけを根拠に答えます。例えば:</p>
            <ul className="space-y-1">
              <li>・ 「予算はいつ承認された？」</li>
              <li>・ 「秘密保持契約で禁止されていることは？」</li>
              <li>・ 「先月の議事録の要点をまとめて」</li>
            </ul>
            {status && status.embeddedChunks === 0 && (
              <p className="mt-3" style={{ color: 'var(--text-faint)' }}>
                （まだ意味検索の索引がありません。ノートを保存すると自動で作られます）
              </p>
            )}
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i}>
            {turn.role === 'user' ? (
              <div className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[14px]" style={{ background: 'var(--bg-hover)' }}>
                  {turn.content}
                </p>
              </div>
            ) : (
              <div>
                {turn.sources && turn.sources.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {turn.sources.map((s) => (
                      <SourceChip key={s.id} source={s} />
                    ))}
                  </div>
                )}
                <p className="whitespace-pre-wrap text-[14px] leading-[1.8]">
                  {turn.content}
                  {turn.streaming && <IconSpinner size={13} className="ml-1 inline opacity-60" />}
                </p>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t py-4">
        <div className="flex items-end gap-2 rounded-xl border px-3 py-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              // Enter while converting belongs to the IME, not to sending.
              if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="ノートについて質問する…"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            className="rounded-lg px-3 py-1.5 text-[13px] text-white disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? '生成中' : '送信'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceChip({ source }: { source: Source }) {
  const href =
    source.kind === 'pdf' && source.attachmentId
      ? `${source.pageId ? `/p/${source.pageId}` : '/'}?file=${source.attachmentId}&page=${source.pdfPageNo ?? 1}`
      : source.pageId
        ? `/p/${source.pageId}`
        : '#';

  return (
    <Link
      href={href}
      title={source.text.slice(0, 200)}
      className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)]"
      style={{ color: 'var(--text-muted)' }}
    >
      {source.kind === 'pdf' ? <IconPdf size={11} /> : <IconFile size={11} />}
      <span className="font-medium" style={{ color: 'var(--accent-text)' }}>{source.id}</span>
      <span className="max-w-[180px] truncate">{source.title}</span>
    </Link>
  );
}
