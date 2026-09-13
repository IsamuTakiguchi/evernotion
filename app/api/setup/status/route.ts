import { NextResponse } from 'next/server';
import { setupState } from '@/lib/setup/bootstrap';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lets the UI show first-run progress instead of failing quietly. */
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  return NextResponse.json(setupState());
}
