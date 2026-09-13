import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db/queries';
import { isAiEnabled } from '@/lib/ai/client';
import { isProtected } from '@/lib/auth/session';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const stored = getSetting('anthropic_api_key');
  return NextResponse.json({
    aiEnabled: isAiEnabled(),
    // Never return the key itself — only enough to show it is configured.
    hasStoredKey: !!stored,
    fromEnv: !!process.env.ANTHROPIC_API_KEY?.trim(),
    keyPreview: stored ? `${stored.slice(0, 8)}…${stored.slice(-4)}` : null,
    protected: isProtected(),
  });
}

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { apiKey?: string };
  const key = (body.apiKey ?? '').trim();

  if (!key) {
    setSetting('anthropic_api_key', '');
    return NextResponse.json({ ok: true, cleared: true });
  }
  if (!key.startsWith('sk-ant-')) {
    return NextResponse.json(
      { error: 'Claude APIキーは sk-ant- で始まります' },
      { status: 400 },
    );
  }
  setSetting('anthropic_api_key', key);
  return NextResponse.json({ ok: true });
}
