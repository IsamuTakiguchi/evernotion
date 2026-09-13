import { NextResponse } from 'next/server';
import { getClient, isAiEnabled, MODELS, noKeyResponse } from '@/lib/ai/client';
import { getPage, listTags } from '@/lib/db/queries';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  if (!isAiEnabled()) return noKeyResponse();

  const { pageId } = (await req.json().catch(() => ({}))) as { pageId?: string };
  const page = pageId ? getPage(session.userId, pageId) : undefined;
  if (!page) return NextResponse.json({ error: 'page not found' }, { status: 404 });

  // Offer the existing vocabulary so the model reuses tags instead of
  // inventing a near-duplicate of one the user already has.
  //
  // This user's tags only. Reading `tags` directly would be shorter and would
  // put every other account's tag names into the prompt — a list of what other
  // people are working on, sent to a third party.
  const vocabulary = listTags(session.userId).slice(0, 200).map((t) => t.name);

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 1024,
    // A tool call forces valid structure; asking for JSON in prose does not.
    tools: [
      {
        name: 'suggest_tags',
        description: 'ノートに付けるタグを提案する',
        input_schema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              maxItems: 5,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'タグ名。#は含めない' },
                  reason: { type: 'string', description: '短い理由' },
                },
                required: ['name', 'reason'],
              },
            },
          },
          required: ['tags'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'suggest_tags' },
    messages: [
      {
        role: 'user',
        content: `次のノートに合うタグを最大5個提案してください。可能な限り既存のタグを再利用してください。

既存のタグ: ${vocabulary.length ? vocabulary.join(', ') : '(まだありません)'}

タイトル: ${page.title || '無題'}
本文:
${page.plain_text.slice(0, 6000)}`,
      },
    ],
  });

  const toolUse = response.content.find((c) => c.type === 'tool_use');
  const tags = toolUse ? ((toolUse.input as { tags?: unknown[] }).tags ?? []) : [];
  return NextResponse.json({ tags });
}
