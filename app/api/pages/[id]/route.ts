import { NextResponse } from 'next/server';
import { deletePage, getBacklinks, getPage, getUnresolvedLinks, updatePage } from '@/lib/db/queries';
import { queuePageIndex } from '@/lib/ai/indexer';
import type { JSONContent } from '@/lib/editor/doc';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const page = getPage(id);
  if (!page) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    page: { ...page, doc: JSON.parse(page.doc_json) as JSONContent },
    backlinks: getBacklinks(id),
    unresolved: getUnresolvedLinks(id),
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    icon?: string | null;
    doc?: JSONContent;
    parentId?: string | null;
    isFavorite?: boolean;
  };
  const page = updatePage(id, body);
  if (!page) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Re-embed in the background; the editor should never wait on the model.
  queuePageIndex(id);

  return NextResponse.json({
    page,
    backlinks: getBacklinks(id),
    unresolved: getUnresolvedLinks(id),
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  deletePage(id);
  return NextResponse.json({ ok: true });
}
