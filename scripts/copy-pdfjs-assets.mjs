#!/usr/bin/env node
/**
 * Copy pdf.js's CMap tables and standard fonts into public/.
 *
 * Both the server-side extractor and the browser viewer need them, and without
 * the CMaps Japanese PDFs extract as empty text or mojibake. Serving them from
 * public/ keeps a stable path that survives bundling — a bundled build cannot
 * use require.resolve() to find them, because it returns a module id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', 'pdfjs-dist');
const to = path.join(root, 'public', 'pdfjs');

if (!fs.existsSync(from)) {
  console.error('pdfjs-dist is not installed; run npm install first');
  process.exit(1);
}

for (const dir of ['cmaps', 'standard_fonts']) {
  const src = path.join(from, dir);
  const dest = path.join(to, dir);
  if (!fs.existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(1);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`copied ${dir} -> public/pdfjs/${dir}`);
}
