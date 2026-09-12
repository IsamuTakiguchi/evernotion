#!/usr/bin/env node
/**
 * Browser-driven checks for the parts of the editor that only exist in the UI:
 * the slash menu, [[wikilink]] autocomplete, autosave, the drag handle, and
 * the ⌘K search palette.
 *
 *   npx next start -p 3210 &
 *   node scripts/e2e.mjs http://127.0.0.1:3210
 *
 * Run it against a production server: `next dev`'s HMR client aborts hydration
 * when its websocket cannot connect, which makes every interaction fail for a
 * reason that has nothing to do with the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3210';

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

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const exe = chromiumExecutable();
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  // HMR websocket noise is a dev-server artifact, not an app error.
  if (m.type() === 'error' && !/websocket|hmr/i.test(m.text())) pageErrors.push(m.text());
});

const editor = () => page.locator('.ProseMirror');

try {
  // A page to work in.
  const res = await fetch(`${BASE}/api/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E作業ノート' }),
  });
  const { page: created } = await res.json();
  const noteId = created.id;

  await fetch(`${BASE}/api/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '参照先ノート' }),
  });

  console.log('editor');
  await page.goto(`${BASE}/p/${noteId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  check('the editor mounts', await editor().isVisible());

  // --- typing and autosave ------------------------------------------------
  await editor().click();
  await page.keyboard.type('議事録の下書きです。');
  await page.waitForTimeout(1800); // past the 800ms autosave debounce
  const saved = await (await fetch(`${BASE}/api/pages/${noteId}`)).json();
  check('typed text is autosaved', saved.page.plain_text.includes('議事録の下書き'),
    saved.page.plain_text.slice(0, 40));

  // --- slash menu ---------------------------------------------------------
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.waitForTimeout(700);
  const slashVisible = await page.locator('text=見出し 1').first().isVisible().catch(() => false);
  check('typing "/" opens the block menu', slashVisible);

  if (slashVisible) {
    await page.keyboard.type('見出し');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('第1章');
    await page.waitForTimeout(1800);
    const afterHeading = await (await fetch(`${BASE}/api/pages/${noteId}`)).json();
    const hasHeading = JSON.stringify(afterHeading.page.doc).includes('"heading"');
    check('choosing a block from the menu inserts it', hasHeading);
  }

  // --- wikilink autocomplete ---------------------------------------------
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('関連: [[');
  await page.waitForTimeout(800);
  await page.keyboard.type('参照先');
  await page.waitForTimeout(900);

  const suggestionVisible = await page
    .locator('text=参照先ノート').first().isVisible().catch(() => false);
  check('typing "[[" suggests existing notes', suggestionVisible);

  if (suggestionVisible) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    const linked = await (await fetch(`${BASE}/api/pages/${noteId}`)).json();
    check('choosing a suggestion inserts a wikilink',
      JSON.stringify(linked.page.doc).includes('"wikiLink"'));
    check('the wikilink renders in the editor',
      await page.locator('.ev-wikilink').first().isVisible().catch(() => false));

    const graph = await (await fetch(`${BASE}/api/graph`)).json();
    check('the new link reaches the graph',
      graph.links.length > 0 && graph.nodes.some((n) => n.title === '参照先ノート'));
  }

  // --- drag handle --------------------------------------------------------
  await editor().locator('p, h1, h2').first().hover();
  await page.waitForTimeout(500);
  const handleVisible = await page
    .locator('[data-drag-handle], .ev-drag-handle, [class*="drag-handle"]')
    .first()
    .isVisible()
    .catch(() => false);
  check('a drag handle appears on hover', handleVisible);

  // --- search palette -----------------------------------------------------
  console.log('\nsearch palette');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  const searchInput = page.locator('input[placeholder*="検索"]');
  check('Ctrl/Cmd+K opens the search palette', await searchInput.isVisible().catch(() => false));

  await searchInput.fill('議事録');
  await page.waitForTimeout(1200);
  const resultCount = await page.locator('mark').count();
  check('the palette shows highlighted results', resultCount > 0, `marks=${resultCount}`);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check('choosing a result navigates to the note', page.url().includes('/p/'));

  // --- PDF viewer ---------------------------------------------------------
  // Only reachable in a browser, and it has failed silently before: pdf.js
  // paints the canvas but leaves the render promise unsettled, so the text
  // layer never appears and there is nothing to highlight.
  console.log('\nPDF viewer');
  const pdfHit = (
    await (await fetch(`${BASE}/api/search?q=${encodeURIComponent('目的外使用')}&kind=pdf`)).json()
  ).hits[0];

  if (!pdfHit) {
    console.log('  (no ingested PDF in this database; skipping)');
  } else {
    await page.goto(
      `${BASE}/p/${pdfHit.pageId}?file=${pdfHit.attachmentId}&page=${pdfHit.pdfPageNo}` +
        `&q=${encodeURIComponent('目的外使用')}`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForSelector('.pdf-text-layer span', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const viewer = await page.evaluate(() => {
      const layer = document.querySelector('.pdf-text-layer');
      const canvas = document.querySelector('canvas');
      if (!layer || !canvas) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 240) painted++;
      return {
        spans: layer.querySelectorAll('span').length,
        marks: layer.querySelectorAll('mark').length,
        text: layer.textContent ?? '',
        painted,
        cssWidth: parseFloat(canvas.style.width || '0'),
      };
    });

    check('the PDF page paints onto the canvas', (viewer?.painted ?? 0) > 500,
      `painted=${viewer?.painted}`);
    check('the PDF page fills the available width', (viewer?.cssWidth ?? 0) > 400,
      `width=${viewer?.cssWidth}`);
    check('the text layer renders', (viewer?.spans ?? 0) > 0, `spans=${viewer?.spans}`);
    check('the text layer carries the Japanese text',
      (viewer?.text ?? '').includes('秘密保持契約書'), (viewer?.text ?? '').slice(0, 40));
    check('the searched term is highlighted on the page', (viewer?.marks ?? 0) > 0,
      `marks=${viewer?.marks}`);
  }

  // --- theme --------------------------------------------------------------
  console.log('\ntheme');
  await page.goto(`${BASE}/p/${noteId}`, { waitUntil: 'networkidle' });
  await page.locator('aside button[aria-label*="モード"]').click();
  await page.waitForTimeout(400);
  check('the dark-mode toggle applies',
    await page.evaluate(() => document.documentElement.classList.contains('dark')));

  console.log('\nconsole');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nUIも含めてすべて成功しました。');
