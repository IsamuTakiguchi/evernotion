import Link from 'next/link';
import { listTags } from '@/lib/db/queries';
import { requireUserId } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TagsPage() {
  const tags = listTags(await requireUserId());

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-10 sm:py-12">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">タグ</h1>
      {tags.length === 0 ? (
        <p className="text-[14px]" style={{ color: 'var(--text-faint)' }}>
          本文に <code>#タグ名</code> と書くと、ここに集まります。
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <Link
              key={t.name}
              href={`/tags/${encodeURIComponent(t.name)}`}
              className="rounded-full border px-3 py-1 text-[13px] hover:bg-[var(--bg-hover)]"
            >
              #{t.name}
              <span className="ml-1.5" style={{ color: 'var(--text-faint)' }}>{t.count}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
