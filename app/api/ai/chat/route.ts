import { getClient, isAiEnabled, MODELS, noKeyResponse } from '@/lib/ai/client';
import { retrieve, type Source } from '@/lib/ai/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYSTEM = `あなたはユーザーの「第2の脳」として、本人のノートとPDFだけを根拠に答えるアシスタントです。

守ること:
- 与えられた <source> の内容だけを根拠にする。推測で補わない。
- 根拠にした箇所は必ず [S1] のように文中で引用する。
- 資料に答えが無いときは、無いとはっきり言う。それらしい作り話をしない。
- 特に指示が無ければユーザーと同じ言語（通常は日本語）で、簡潔に答える。`;

function buildContext(sources: Source[]): string {
  return sources
    .map(
      (s) =>
        `<source id="${s.id}" type="${s.kind}" title="${s.title.replace(/"/g, "'")}">\n${s.text}\n</source>`,
    )
    .join('\n\n');
}

export async function POST(req: Request) {
  if (!isAiEnabled()) return noKeyResponse();

  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    deep?: boolean;
  };
  const message = (body.message ?? '').trim();
  if (!message) return Response.json({ error: 'message is required' }, { status: 400 });

  const sources = await retrieve(message, 8);
  const client = getClient();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Sources go out before the first token so the UI can show them at once.
      send('sources', { sources });

      try {
        const claude = client.messages.stream({
          model: body.deep ? MODELS.deep : MODELS.chat,
          max_tokens: 2048,
          system: SYSTEM,
          messages: [
            ...(body.history ?? []).slice(-8),
            {
              role: 'user',
              content: sources.length
                ? `${buildContext(sources)}\n\n---\n\n質問: ${message}`
                : `（関連するノートは見つかりませんでした）\n\n質問: ${message}`,
            },
          ],
        });

        for await (const event of claude) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            send('delta', { text: event.delta.text });
          }
        }
        send('done', {});
      } catch (err) {
        send('error', { message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
