#!/usr/bin/env node
/**
 * Verify every native module actually loads.
 *
 * The image installs dependencies with `npm ci --ignore-scripts` (see the
 * Dockerfile for why), which relies on each native package shipping a usable
 * prebuilt binary in its own npm tarball. That is true today for all of them,
 * but it is an assumption about other people's packaging, and if it ever stops
 * holding the failure is silent: the build succeeds, the server starts, and
 * then one feature dies at the moment someone uses it.
 *
 * Running this during the build turns that into a failed build instead.
 * Deliberately does not download any model — it only proves the binaries load.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.log(`  FAIL ${name} — ${err.message.split('\n')[0].slice(0, 160)}`);
    failures.push(name);
  }
}

console.log('native module check\n');

await check('better-sqlite3 (notes, search index)', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  // Exercise FTS5 specifically: a SQLite build without it would pass a plain
  // open and fail only once someone searched.
  //
  // The probe matches whole tokens, not a substring of a CJK run — unicode61
  // treats such a run as one token, which is the very limitation the app's
  // bigram index exists to work around. Asserting otherwise here would fail
  // against a perfectly good SQLite.
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='unicode61')");
  db.prepare('INSERT INTO probe VALUES (?)').run('秘密保持契約書 nda tokyo');
  const ascii = db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get('"nda"').n;
  const cjk = db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get('"秘密保持契約書"').n;
  const version = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  if (ascii !== 1 || cjk !== 1) throw new Error('FTS5 MATCH returned no rows');
  return `sqlite ${version}, FTS5 available`;
});

await check('onnxruntime-node (semantic search)', async () => {
  const ort = await import('onnxruntime-node');
  if (typeof ort.InferenceSession !== 'function') throw new Error('InferenceSession missing');
  return 'libonnxruntime loaded';
});

await check('@napi-rs/canvas (PDF page rasterising for OCR)', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  return `${createCanvas(4, 4).toBuffer('image/png').length} byte png`;
});

await check('sharp (icons, image processing)', async () => {
  const { default: sharp } = await import('sharp');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
  return `${(await sharp(Buffer.from(svg)).png().toBuffer()).length} byte png`;
});

await check('tesseract.js worker dependencies (OCR)', async () => {
  // The recogniser runs in a separate Node worker whose requires are invisible
  // to bundlers; a missing one kills OCR only at use time.
  const required = ['bmp-js', 'zlibjs', 'is-url', 'wasm-feature-detect', 'idb-keyval'];
  const missing = required.filter((m) => !fs.existsSync(path.join(root, 'node_modules', m)));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  const core = path.join(root, 'node_modules', 'tesseract.js-core');
  if (!fs.readdirSync(core).some((f) => f.endsWith('.wasm'))) {
    throw new Error('tesseract.js-core has no wasm build');
  }
  return `${required.length} modules + wasm core`;
});

await check('pdf.js CMaps (Japanese PDF text extraction)', async () => {
  // Without these, Japanese PDFs extract as empty text with no error at all.
  const candidates = [
    path.join(root, 'public', 'pdfjs', 'cmaps'),
    path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps'),
  ];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) throw new Error('cmaps directory not found');
  return path.relative(root, found);
});

if (failures.length) {
  console.log(`\n${failures.length} native module(s) unusable: ${failures.join(', ')}`);
  console.log('The image would build but fail at runtime. Aborting.');
  process.exit(1);
}
console.log('\nすべてのネイティブモジュールが利用可能です。');
