'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconSpinner } from '@/components/ui/Icons';

type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/**
 * Connecting Claude to these notes.
 *
 * The token is shown once, at creation, and never again — so the panel's main
 * job is to put it in front of the person together with the command that uses
 * it, while it is still on screen.
 */
export function ClaudePanel() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [name, setName] = useState('Claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    api.get<{ tokens: ApiToken[] }>('/api/tokens')
      .then((r) => setTokens(r.tokens))
      .catch(() => undefined);
  };
  useEffect(load, []);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const command = `claude mcp add --transport http evernotian ${origin}/api/mcp \\\n`
    + `  --header "Authorization: Bearer ${secret ?? '<トークン>'}"`;

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(`発行できませんでした (${res.status})`);
        return;
      }
      const body = (await res.json()) as { secret: string };
      setSecret(body.secret);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    load();
  };

  const live = tokens.filter((t) => !t.revokedAt);

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[15px] font-medium">Claude と連携</h2>
      <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        アクセストークンを発行すると、Claude Code や Claude Desktop から、
        いつもの会話の中でこのノートを検索・閲覧できるようになります。
        新しいノートの作成と追記もできます（既存ノートの上書きと削除はできません）。
      </p>

      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="用途（例: 自宅のPC）"
          className="rounded border px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
          style={{ background: 'var(--bg)' }}
        />
        <button
          onClick={() => void issue()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border px-3 py-1.5 text-[13px] hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          {busy && <IconSpinner size={13} />}
          トークンを発行
        </button>
      </div>

      {error && <p className="mt-2 text-[13px]" style={{ color: 'var(--danger)' }}>{error}</p>}

      {secret && (
        <div
          className="mt-4 rounded border px-3 py-3"
          style={{ borderColor: 'var(--accent)', background: 'var(--bg-subtle)' }}
        >
          <p className="text-[13px] font-medium">
            このトークンが表示されるのはこの一度きりです。
          </p>
          <code className="mt-2 block break-all rounded px-2 py-1.5 text-[12px]" style={{ background: 'var(--bg)' }}>
            {secret}
          </code>

          <p className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Claude Code なら、これをそのまま実行してください:
          </p>
          <pre
            className="mt-1 overflow-x-auto rounded px-2 py-1.5 text-[12px]"
            style={{ background: 'var(--bg)' }}
          >{command}</pre>

          <button
            onClick={() => {
              void navigator.clipboard.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="mt-2 rounded border px-2.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]"
          >
            {copied ? 'コピーしました' : 'コマンドをコピー'}
          </button>

          <details className="mt-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            <summary className="cursor-pointer">Claude Desktop から使う場合</summary>
            <p className="mt-2 leading-relaxed">
              Claude Desktop はリモートのMCPサーバに直接つながらないため、
              <code>mcp-remote</code> を挟みます。設定ファイル
              （<code>claude_desktop_config.json</code>）に次を追記してください。
            </p>
            <pre
              className="mt-2 overflow-x-auto rounded px-2 py-1.5 text-[11.5px]"
              style={{ background: 'var(--bg)' }}
            >{JSON.stringify({
              mcpServers: {
                evernotian: {
                  command: 'npx',
                  args: ['-y', 'mcp-remote', `${origin}/api/mcp`,
                    '--header', `Authorization: Bearer ${secret}`],
                },
              },
            }, null, 2)}</pre>
          </details>
        </div>
      )}

      {live.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {live.map((token) => (
            <div key={token.id} className="flex items-center gap-2 rounded border px-3 py-2 text-[13px]">
              <span className="font-medium">{token.name || '（名前なし）'}</span>
              <code className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                {token.prefix}…
              </code>
              <span className="flex-1 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                {token.lastUsedAt ? `最終利用 ${token.lastUsedAt}` : '未使用'}
              </span>
              <button
                onClick={() => void revoke(token.id)}
                className="rounded border px-2 py-0.5 text-[12px] hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--danger)' }}
              >
                失効
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
