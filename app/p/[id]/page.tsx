import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { getBacklinks, getPage, getUnresolvedLinks } from '@/lib/db/queries';
import { PageView } from '@/components/editor/PageView';
import { requireUserId } from '@/lib/auth/guard';
import type { JSONContent } from '@/lib/editor/doc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PageRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  // getPage returns nothing for another account's page, so somebody else's id
  // in the URL is a 404 — the same answer as an id that never existed, which
  // is the point: confirming it exists would leak that it does.
  const page = getPage(userId, id);
  if (!page) notFound();

  const initial = {
    page: {
      id: page.id,
      title: page.title,
      icon: page.icon,
      doc: JSON.parse(page.doc_json) as JSONContent,
      updated_at: page.updated_at,
    },
    backlinks: getBacklinks(userId, id),
    unresolved: getUnresolvedLinks(userId, id),
  };

  return (
    // useSearchParams in PageView requires a Suspense boundary.
    <Suspense fallback={null}>
      <PageView key={id} initial={initial} />
    </Suspense>
  );
}
