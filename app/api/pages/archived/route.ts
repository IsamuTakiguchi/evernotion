import { NextResponse } from 'next/server';
import { listArchived } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  return NextResponse.json({ pages: listArchived() });
}
