import Link from 'next/link';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const name = decodeURIComponent(tag);

  const pages = getDb()
    .prepare(
      `SELECT p.id, p.title, p.icon, substr(p.plain_text, 1, 160) AS excerpt
         FROM pages p
         JOIN page_tags pt ON pt.page_id = p.id
         JOIN tags t ON t.id = pt.tag_id
        WHERE t.name = ? AND p.archived_at IS NULL
        ORDER BY p.updated_at DESC`,
    )
    .all(name) as { id: string; title: string; icon: string | null; excerpt: string }[];

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-10 sm:py-12">
      <Link href="/tags" className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
        ← すべてのタグ
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold tracking-tight">#{name}</h1>
      <div className="space-y-2">
        {pages.map((p) => (
          <Link key={p.id} href={`/p/${p.id}`} className="block rounded border px-3 py-2.5 hover:bg-[var(--bg-hover)]">
            <span className="block text-[14px] font-medium">
              {p.icon ? `${p.icon} ` : ''}{p.title || '無題'}
            </span>
            <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              {p.excerpt}
            </span>
          </Link>
        ))}
        {pages.length === 0 && (
          <p className="text-[14px]" style={{ color: 'var(--text-faint)' }}>このタグのノートはありません。</p>
        )}
      </div>
    </div>
  );
}
