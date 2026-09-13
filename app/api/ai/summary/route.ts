import { NextResponse } from 'next/server';
import { getClient, isAiEnabled, MODELS, noKeyResponse } from '@/lib/ai/client';
import { getPage } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  if (!isAiEnabled()) return noKeyResponse();

  const { pageId } = (await req.json().catch(() => ({}))) as { pageId?: string };
  const page = pageId ? getPage(pageId) : undefined;
  if (!page) return NextResponse.json({ error: 'page not found' }, { status: 404 });
  if (!page.plain_text.trim()) return NextResponse.json({ summary: '（本文が空です）' });

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 512,
    system: 'ノートの要点を3行以内の箇条書きで、本文と同じ言語でまとめてください。前置きは書かないこと。',
    messages: [{ role: 'user', content: page.plain_text.slice(0, 12000) }],
  });

  const summary = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('')
    .trim();

  return NextResponse.json({ summary });
}
