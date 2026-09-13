import { NextResponse } from 'next/server';
import { createPage, listPageTree } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  return NextResponse.json({ tree: listPageTree() });
}

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    parentId?: string | null;
    icon?: string | null;
  };
  const page = createPage({
    title: body.title ?? '',
    parentId: body.parentId ?? null,
    icon: body.icon ?? null,
  });
  return NextResponse.json({ page }, { status: 201 });
}
