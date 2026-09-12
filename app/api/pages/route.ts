import { NextResponse } from 'next/server';
import { createPage, listPageTree } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ tree: listPageTree() });
}

export async function POST(req: Request) {
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
