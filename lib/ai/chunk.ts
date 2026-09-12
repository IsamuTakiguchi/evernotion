export type Chunk = { ord: number; text: string };

const TARGET = 500;   // characters per chunk
const OVERLAP = 80;   // characters repeated between neighbours, to keep context
const MIN = 30;       // below this a chunk carries no retrievable meaning

/**
 * Split text into overlapping chunks, preferring to break at paragraph and
 * sentence boundaries (Japanese 。！？ included) over cutting mid-word.
 */
export function chunkText(raw: string, target = TARGET): Chunk[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= target) return [{ ord: 0, text }];

  const chunks: Chunk[] = [];
  let start = 0;
  let ord = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + target);

    if (end < text.length) {
      // Look for a natural break in the last third of the window.
      const window = text.slice(start + Math.floor(target * 0.6), end);
      const breaks = [...window.matchAll(/[\n。！？!?]|\.\s/g)];
      const last = breaks.at(-1);
      if (last?.index !== undefined) {
        end = start + Math.floor(target * 0.6) + last.index + last[0].length;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece.length >= MIN || chunks.length === 0) chunks.push({ ord: ord++, text: piece });

    if (end >= text.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }

  return chunks;
}

/** Stable content hash, so unchanged chunks are never re-embedded. */
export async function hashText(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
