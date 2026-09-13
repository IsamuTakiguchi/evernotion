'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconSettings, IconSpinner } from '@/components/ui/Icons';

type SettingsInfo = {
  aiEnabled: boolean;
  hasStoredKey: boolean;
  fromEnv: boolean;
  keyPreview: string | null;
  authMode: 'google' | 'open' | 'locked';
};

type Me = {
  mode: string;
  user: { id: string; email: string; name: string | null; picture: string | null } | null;
};

type AiStatus = {
  aiEnabled: boolean;
  embeddedChunks: number;
  indexer: { pending: number; running: boolean; error: string | null };
};

export default function SettingsPage() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const load = () => {
    api.get<SettingsInfo>('/api/settings').then(setInfo).catch(() => setInfo(null));
    api.get<AiStatus>('/api/ai/status').then(setStatus).catch(() => setStatus(null));
    api.get<Me>('/api/me').then(setMe).catch(() => setMe(null));
  };

  useEffect(load, []);

  const saveKey = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.post('/api/settings', { apiKey: key });
      setKey('');
      setMessage({ kind: 'ok', text: key ? 'APIキーを保存しました。' : 'APIキーを削除しました。' });
      load();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const reindex = async (embeddings: boolean) => {
    setReindexing(true);
    setMessage(null);
    try {
      const r = await api.post<{ search: { pages: number; pdfPages: number } }>('/api/index', { embeddings });
      setMessage({
        kind: 'ok',
        text: `再構築しました: ノート ${r.search.pages}件、PDFページ ${r.search.pdfPages}件`,
      });
      load();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-10 sm:py-12">
      <h1 className="mb-8 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <IconSettings size={22} />
        設定
      </h1>

      <section className="mb-10">
        <h2 className="mb-1 text-[15px] font-medium">Claude APIキー</h2>
        <p className="mb-4 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          AIチャット・自動タグ・要約に使います。<b>未設定でも</b>ノート、PDFの全文検索、OCR、
          リンク、グラフ、関連ノートはすべて動作します（意味検索の埋め込みはこの端末内で計算しています）。
          キーはこの端末のSQLiteにのみ保存され、Anthropic以外には送信されません。
        </p>

        {info && (
          <div className="mb-3 rounded-lg border px-3 py-2 text-[13px]" style={{ background: 'var(--bg-subtle)' }}>
            {info.fromEnv ? (
              <span>環境変数 <code>ANTHROPIC_API_KEY</code> が設定されています（こちらが優先されます）。</span>
            ) : info.hasStoredKey ? (
              <span>保存済み: <code>{info.keyPreview}</code></span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>未設定です。</span>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            className="flex-1 rounded border px-3 py-2 text-[13.5px] outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--bg)' }}
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving}
            className="rounded px-4 py-2 text-[13px] text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        <p className="mt-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          空欄のまま保存すると、保存済みのキーを削除します。
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-[15px] font-medium">索引</h2>
        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          検索索引は保存のたびに自動更新されます。取り込み済みのPDFを含めて作り直したいときだけ使ってください。
        </p>
        {status && (
          <div className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            意味検索のベクトル: {status.embeddedChunks.toLocaleString()} チャンク
            {status.indexer.running && <span className="ml-2">（生成中…）</span>}
            {status.indexer.pending > 0 && <span className="ml-2">待機 {status.indexer.pending}</span>}
            {status.indexer.error && (
              <span className="ml-2" style={{ color: 'var(--danger)' }}>
                エラー: {status.indexer.error}
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => void reindex(false)}
            disabled={reindexing}
            className="rounded border px-3 py-1.5 text-[13px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            検索索引を再構築
          </button>
          <button
            onClick={() => void reindex(true)}
            disabled={reindexing}
            className="flex items-center gap-1.5 rounded border px-3 py-1.5 text-[13px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {reindexing && <IconSpinner size={13} />}
            ベクトルも作り直す（時間がかかります）
          </button>
        </div>
      </section>

      {message && (
        <p
          className="rounded border px-3 py-2 text-[13px]"
          style={{ color: message.kind === 'ok' ? 'var(--text)' : 'var(--danger)' }}
        >
          {message.text}
        </p>
      )}

      {info?.authMode && info.authMode !== 'open' && (
        <section className="mb-10">
          <h2 className="mb-1 text-[15px] font-medium">アカウント</h2>
          <p className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {me?.user
              ? `${me.user.email} でログイン中です。ノートはこのアカウント専用で、他の人からは見えません。`
              : 'Googleアカウントでログインしています。'}
          </p>
          <button
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              window.location.href = '/login';
            }}
            className="rounded border px-3 py-1.5 text-[13px] hover:bg-[var(--bg-hover)]"
          >
            ログアウト
          </button>
        </section>
      )}

      <section className="mt-12 border-t pt-6 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        <p>データはすべて <code>data/</code> 配下（SQLiteと元ファイル）に保存されます。</p>
        <p>バックアップはこのフォルダごとコピーしてください。</p>
      </section>
    </div>
  );
}
