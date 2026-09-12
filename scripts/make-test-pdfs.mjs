#!/usr/bin/env node
/**
 * Generate Japanese test PDFs with no external assets.
 *
 * Two fixtures, because the ingest pipeline has two very different paths:
 *   fixture-text.pdf — a real text layer, so extraction should be exact
 *   fixture-scan.pdf — a full-page image with no text layer, forcing OCR
 *
 * Both are printed from headless Chromium using a Japanese system font.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Find a usable Chromium. Playwright normally resolves this itself, but a
 * container may ship a browser build that does not match the installed
 * Playwright version, so fall back to whatever is actually on disk.
 */
function chromiumExecutable() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  const candidates = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium'))
    .flatMap((d) => [
      path.join(root, d, 'chrome-linux', 'chrome'),
      path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    ]);
  return candidates.find((c) => fs.existsSync(c));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tests', 'fixtures');

/** Japanese fonts, in preference order. Fails loudly rather than producing tofu. */
const FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
  '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  'C:\\Windows\\Fonts\\meiryo.ttc',
];

function findFont() {
  const found = FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `日本語フォントが見つかりません。次のいずれかをインストールしてください:\n${FONT_CANDIDATES.join('\n')}`,
    );
  }
  return found;
}

export const FIXTURE_TEXT = {
  page1: '本契約は、甲と乙との間の新規事業に関する情報開示について定める。',
  page1b: '第1条 秘密情報の定義。第2条 目的外使用の禁止。予算案は2026年4月1日に承認された。',
  page2: '第2ページ：取締役会議事録。四半期の売上目標を上方修正する。Budget approved for Q2.',
};

const html = (fontFamily) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  body { font-family: ${fontFamily}, sans-serif; margin: 0; }
  .page { width: 210mm; height: 297mm; box-sizing: border-box; padding: 22mm; page-break-after: always; }
  h1 { font-size: 26px; margin: 0 0 20px; }
  p  { font-size: 17px; line-height: 2.1; margin: 0 0 14px; }
</style></head><body>
  <div class="page">
    <h1>秘密保持契約書</h1>
    <p>${FIXTURE_TEXT.page1}</p>
    <p>${FIXTURE_TEXT.page1b}</p>
  </div>
  <div class="page">
    <h1>議事録</h1>
    <p>${FIXTURE_TEXT.page2}</p>
  </div>
</body></html>`;

async function main() {
  const font = findFont();
  console.log(`using font: ${font}`);
  fs.mkdirSync(outDir, { recursive: true });

  const executablePath = chromiumExecutable();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    // ---- text-layer fixture -------------------------------------------------
    const page = await browser.newPage();
    await page.setContent(html("'IPAGothic'"), { waitUntil: 'load' });
    await page.pdf({ path: path.join(outDir, 'fixture-text.pdf'), format: 'A4', printBackground: true });
    console.log('wrote tests/fixtures/fixture-text.pdf (text layer)');

    // ---- scanned fixture ----------------------------------------------------
    // Screenshot the same markup, then print that image full-bleed. The result
    // carries no text layer at all, which is exactly what a scan looks like.
    const shot = await page.locator('.page').first().screenshot({ scale: 'css' });
    const imgPage = await browser.newPage();
    await imgPage.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
         @page { size: A4; margin: 0; }
         body { margin: 0; }
         img { width: 210mm; height: 297mm; object-fit: contain; display: block; }
       </style></head>
       <body><img src="data:image/png;base64,${shot.toString('base64')}"></body></html>`,
      { waitUntil: 'load' },
    );
    await imgPage.pdf({ path: path.join(outDir, 'fixture-scan.pdf'), format: 'A4', printBackground: true });
    console.log('wrote tests/fixtures/fixture-scan.pdf (image only, needs OCR)');
  } finally {
    await browser.close();
  }
}

await main();
