/**
 * Local sentence embeddings. Runs entirely on-device via transformers.js so
 * semantic search works with no API key and no data leaving the machine.
 *
 * multilingual-e5-small handles Japanese and English in one 384-dim space. The
 * model expects its "query: " / "passage: " prefixes — without them retrieval
 * quality drops noticeably.
 */
export const EMBED_MODEL = 'Xenova/multilingual-e5-small';
export const EMBED_DIMS = 384;

type FeatureExtractor = (
  input: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

export function embeddingsReady(): boolean {
  return extractorPromise !== null;
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      // Downloads the model on first use (~120MB) and caches it on disk.
      return (await pipeline('feature-extraction', EMBED_MODEL, {
        dtype: 'q8',
      })) as unknown as FeatureExtractor;
    })().catch((err) => {
      extractorPromise = null; // let a later call retry a transient failure
      throw err;
    });
  }
  return extractorPromise;
}

async function encode(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const dims = out.dims[1];
  return texts.map((_, i) => out.data.slice(i * dims, (i + 1) * dims) as Float32Array);
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  return encode(texts.map((t) => `passage: ${t}`));
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vec] = await encode([`query: ${text}`]);
  return vec;
}

export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy: the Buffer may be a view into a larger pooled allocation.
  const copy = new ArrayBuffer(blob.byteLength);
  new Uint8Array(copy).set(blob);
  return new Float32Array(copy);
}

/** Vectors are stored normalised, so a dot product is the cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}
