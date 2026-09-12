import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { getBacklinks, getPage, getUnresolvedLinks } from '@/lib/db/queries';
import { PageView } from '@/components/editor/PageView';
import type { JSONContent } from '@/lib/editor/doc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PageRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = getPage(id);
  if (!page) notFound();

  const initial = {
    page: {
      id: page.id,
      title: page.title,
      icon: page.icon,
      doc: JSON.parse(page.doc_json) as JSONContent,
      updated_at: page.updated_at,
    },
    backlinks: getBacklinks(id),
    unresolved: getUnresolvedLinks(id),
  };

  return (
    // useSearchParams in PageView requires a Suspense boundary.
    <Suspense fallback={null}>
      <PageView key={id} initial={initial} />
    </Suspense>
  );
}
