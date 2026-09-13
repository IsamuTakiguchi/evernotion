import { NextResponse } from 'next/server';
import { listArchived } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  return NextResponse.json({ pages: listArchived(session.userId) });
}
