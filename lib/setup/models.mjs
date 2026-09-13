/**
 * Model provisioning, shared by the server's startup path and the standalone
 * `npm run warmup` script.
 *
 * Plain JavaScript on purpose: `scripts/warmup.mjs` runs without a build step,
 * so it cannot import TypeScript, and duplicating the download logic in two
 * places is exactly how the two drift apart.
 *
 * Nothing here is required up front — both models are fetched on demand the
 * first time they are used. Pre-fetching only moves that wait off the user's
 * first upload and makes offline operation possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

/** Tesseract language data. jpn is ~16MB, eng ~11MB. */
export const TESSDATA_BASE = 'https://tessdata.projectnaptha.com/4.0.0';
export const OCR_LANGS = ['jpn', 'eng'];

/** Sentence-embedding model: 384 dims, multilingual, ~140MB quantised. */
export const EMBED_MODEL = 'Xenova/multilingual-e5-small';

export function resolveDataDir(explicit) {
  const dir = explicit
    ? path.resolve(explicit)
    : process.env.EVERNOTION_DATA_DIR
      ? path.resolve(process.env.EVERNOTION_DATA_DIR)
      : path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where the OCR and embedding models live.
 *
 * Separate from the data directory on purpose. In the container they are baked
 * into the image and EVERNOTION_MODEL_DIR points at them, so a fresh volume
 * needs no 170MB download and the volume holds only the database and uploads.
 * Locally, with the variable unset, they sit under the data directory as before.
 */
export function modelsRoot(dataDir) {
  const dir = process.env.EVERNOTION_MODEL_DIR
    ? path.resolve(process.env.EVERNOTION_MODEL_DIR)
    : path.join(resolveDataDir(dataDir), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tessdataDir(dataDir) {
  const dir = path.join(modelsRoot(dataDir), 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function modelCacheDir(dataDir) {
  const dir = path.join(modelsRoot(dataDir), 'hub');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function hasTessdata(dataDir) {
  const dir = tessdataDir(dataDir);
  return OCR_LANGS.every(
    (lang) =>
      fs.existsSync(path.join(dir, `${lang}.traineddata`)) ||
      fs.existsSync(path.join(dir, `${lang}.traineddata.gz`)),
  );
}

/**
 * Download the OCR language files.
 * @param {{ dataDir?: string, onProgress?: (msg: string) => void }} [opts]
 */
export async function ensureTessdata(opts = {}) {
  const dir = tessdataDir(opts.dataDir);
  const report = opts.onProgress ?? (() => {});

  for (const lang of OCR_LANGS) {
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target) || fs.existsSync(path.join(dir, `${lang}.traineddata`))) continue;

    report(`OCRモデル (${lang}) をダウンロード中…`);
    const res = await fetch(`${TESSDATA_BASE}/${lang}.traineddata.gz`);
    if (!res.ok || !res.body) throw new Error(`tessdata ${lang}: HTTP ${res.status}`);

    // Write under a temp name first: an interrupted download must not leave a
    // truncated file that later looks like a valid cache entry and makes
    // tesseract fail in a much more confusing way.
    const partial = `${target}.partial`;
    await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
    fs.renameSync(partial, target);
    report(`OCRモデル (${lang}) の準備ができました`);
  }
}

/**
 * Load the embedding model once so it is cached on disk.
 * @param {{ dataDir?: string, onProgress?: (msg: string) => void }} [opts]
 */
export async function ensureEmbeddingModel(opts = {}) {
  const report = opts.onProgress ?? (() => {});
  process.env.TRANSFORMERS_CACHE ??= modelCacheDir(opts.dataDir);

  report('意味検索モデルを準備中…');
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
  // One real inference, so a half-written cache surfaces here rather than on
  // the user's first search.
  await extractor(['passage: 動作確認'], { pooling: 'mean', normalize: true });
  report('意味検索モデルの準備ができました');
}

/**
 * Fetch everything the app needs to run offline.
 * @param {{ dataDir?: string, onProgress?: (msg: string) => void }} [opts]
 */
export async function ensureModels(opts = {}) {
  await ensureTessdata(opts);
  await ensureEmbeddingModel(opts);
}
