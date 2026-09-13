import { NextResponse } from 'next/server';
import { setupState } from '@/lib/setup/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lets the UI show first-run progress instead of failing quietly. */
export async function GET() {
  return NextResponse.json(setupState());
}
