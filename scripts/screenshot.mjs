#!/usr/bin/env node
/**
 * Capture the main screens for a visual check. Development aid, not a test.
 *   node scripts/screenshot.mjs [baseUrl] [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:3111';
const outDir = process.argv[3] ?? '.screens';

function chromiumExecutable() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  return fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium'))
    .flatMap((d) => [
      path.join(root, d, 'chrome-linux', 'chrome'),
      path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    ])
    .find((c) => fs.existsSync(c));
}

const executablePath = chromiumExecutable();
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

fs.mkdirSync(outDir, { recursive: true });

const res = await fetch(`${base}/api/pages`);
const { tree } = await res.json();
const firstPage = tree[0]?.id;

const shots = [
  ['home', '/'],
  ...(firstPage ? [['editor', `/p/${firstPage}`]] : []),
  ['graph', '/graph'],
  ['chat', '/chat'],
  ['settings', '/settings'],
  ['tags', '/tags'],
];

for (const [name, url] of shots) {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`${name.padEnd(9)} ${url}`);
}

// Dark mode, on the editor, to check both palettes in one pass.
if (firstPage) {
  await page.goto(`${base}/p/${firstPage}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, 'editor-dark.png') });
  console.log('editor-dark');
}

await browser.close();

if (errors.length) {
  console.log('\nconsole errors:');
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e.slice(0, 220)}`);
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}
