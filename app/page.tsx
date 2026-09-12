import Link from 'next/link';
import { listPageTree } from '@/lib/db/queries';
import { Logo } from '@/components/layout/Logo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
  const tree = listPageTree();

  return (
    <div className="mx-auto max-w-2xl px-8 py-20">
      <div className="mb-6 flex items-center gap-3">
        <Logo size={44} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evernotion</h1>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            ノート、PDF全文検索、第2の脳をひとつに
          </p>
        </div>
      </div>

      <ul className="mb-10 space-y-2 text-[14px]" style={{ color: 'var(--text-muted)' }}>
        <li>・ Notion風のブロックエディタ。<code>/</code> でブロックを挿入</li>
        <li>・ PDFをドロップすると中の文字まで検索対象に（スキャン画像はOCR）</li>
        <li>・ <code>[[ノート名]]</code> でリンク、バックリンクとグラフで全体を俯瞰</li>
        <li>・ ノートとPDFを根拠にAIが答える（APIキー未設定でも他の機能は全て動きます）</li>
      </ul>

      {tree.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
            最近のノート
          </h2>
          <div className="space-y-1">
            {tree.slice(0, 8).map((n) => (
              <Link
                key={n.id}
                href={`/p/${n.id}`}
                className="block rounded px-3 py-2 text-[14px] hover:bg-[var(--bg-hover)]"
              >
                {n.icon ? `${n.icon} ` : ''}
                {n.title || '無題'}
              </Link>
            ))}
          </div>
        </section>
      ) : (
        <p className="text-[14px]" style={{ color: 'var(--text-faint)' }}>
          左のサイドバーから最初のノートを作成してください。
        </p>
      )}
    </div>
  );
}
