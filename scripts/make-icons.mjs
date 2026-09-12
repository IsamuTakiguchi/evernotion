#!/usr/bin/env node
/**
 * Rasterise assets/icon.svg into the icon set the app and the browser need.
 * Run with `npm run icons` after editing the SVG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'));

const targets = [
  { file: 'app/apple-icon.png', size: 180 },
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/og-icon.png', size: 512 },
];

for (const { file, size } of targets) {
  const out = path.join(root, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`wrote ${file} (${size}px)`);
}

// Next.js serves app/icon.svg as the favicon automatically.
fs.copyFileSync(path.join(root, 'assets', 'icon.svg'), path.join(root, 'app', 'icon.svg'));
console.log('wrote app/icon.svg');

const manifest = {
  name: 'Evernotion',
  short_name: 'Evernotion',
  description: 'ノート・PDF全文検索・第2の脳を1つにしたローカルノートアプリ',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#6366f1',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
};
fs.writeFileSync(
  path.join(root, 'public', 'manifest.webmanifest'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log('wrote public/manifest.webmanifest');
