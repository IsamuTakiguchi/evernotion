import { NextResponse } from 'next/server';
import { archivePage, restorePage } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Move a page and its descendants to the trash. */
export async function POST(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const count = archivePage(id);
  if (count === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, archived: count });
}

/** Restore from the trash. */
export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const { id } = await params;
  const count = restorePage(id);
  if (count === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, restored: count });
}
