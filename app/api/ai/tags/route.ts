import { NextResponse } from 'next/server';
import { getClient, isAiEnabled, MODELS, noKeyResponse } from '@/lib/ai/client';
import { getDb } from '@/lib/db/client';
import { getPage } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isAiEnabled()) return noKeyResponse();

  const { pageId } = (await req.json().catch(() => ({}))) as { pageId?: string };
  const page = pageId ? getPage(pageId) : undefined;
  if (!page) return NextResponse.json({ error: 'page not found' }, { status: 404 });

  // Offer the existing vocabulary so the model reuses tags instead of
  // inventing a near-duplicate of one the user already has.
  const vocabulary = (
    getDb().prepare('SELECT name FROM tags ORDER BY name LIMIT 200').all() as { name: string }[]
  ).map((t) => t.name);

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
