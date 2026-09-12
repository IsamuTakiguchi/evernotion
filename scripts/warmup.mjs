#!/usr/bin/env node
/**
 * Pre-download the models the app uses, so the first PDF upload and the first
 * semantic search don't stall on a large fetch.
 *
 *   tesseract jpn + eng traineddata   ~27 MB
 *   multilingual-e5-small (q8) ONNX   ~140 MB
 *
 * Optional: both are fetched on demand otherwise. Run it once after install,
 * or before going offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.EVERNOTION_DATA_DIR
  ? path.resolve(process.env.EVERNOTION_DATA_DIR)
  : path.join(root, 'data');

const TESSDATA_BASE = 'https://tessdata.projectnaptha.com/4.0.0';
const LANGS = ['jpn', 'eng'];

async function fetchTessdata() {
  const dir = path.join(dataDir, 'models', 'tessdata');
  fs.mkdirSync(dir, { recursive: true });

  for (const lang of LANGS) {
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) {
      console.log(`tessdata ${lang}: already present`);
      continue;
    }
    process.stdout.write(`tessdata ${lang}: downloading… `);
    const res = await fetch(`${TESSDATA_BASE}/${lang}.traineddata.gz`);
    if (!res.ok || !res.body) throw new Error(`failed to fetch ${lang}: HTTP ${res.status}`);
    // Write to a temp name first so an interrupted run never leaves a partial
    // file that later looks like a valid cache entry.
    const tmp = `${target}.partial`;
    await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
    console.log(`${(fs.statSync(target).size / 1e6).toFixed(1)} MB`);
  }
}

async function fetchEmbeddingModel() {
  process.stdout.write('embedding model: loading… ');
  process.env.TRANSFORMERS_CACHE ??= path.join(dataDir, 'models', 'hub');
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    dtype: 'q8',
  });
  const out = await extractor(['passage: 動作確認'], { pooling: 'mean', normalize: true });
  console.log(`ready (${out.dims.join('x')})`);
}

try {
  await fetchTessdata();
  await fetchEmbeddingModel();
  console.log('\nすべてのモデルの準備が完了しました。オフラインでも動作します。');
} catch (err) {
  console.error(`\nwarmup failed: ${err.message}`);
  console.error('ネットワークを確認してください。未取得でもアプリは動きますが、初回利用時にダウンロードが走ります。');
  process.exit(1);
}
