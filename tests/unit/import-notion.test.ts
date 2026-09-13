import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import {
  readNotionZip, parseNotionName, notionMarkdownToHtml, linkResolverFor,
  assetResolverFor, resolvePath, mimeFor, looksLikeZip,
} from '@/lib/import/notion';
import { htmlToDoc } from '@/lib/import/html';
import { toPlainText, type JSONContent } from '@/lib/editor/doc';

/** Build a zip the way Notion lays one out. */
function notionZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, body] of Object.entries(files)) {
    entries[path] = typeof body === 'string' ? strToU8(body) : body;
  }
  return zipSync(entries);
}

function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const found: JSONContent[] = [];
  const walk = (n: JSONContent) => { if (n.type === type) found.push(n); n.content?.forEach(walk); };
  walk(doc);
  return found;
}

const ID_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ID_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

// ----------------------------------------------------------------- names ---

test('a Notion filename splits into title and id', () => {
  assert.deepEqual(parseNotionName(`会議メモ ${ID_A}.md`), { title: '会議メモ', id: ID_A });
  assert.deepEqual(parseNotionName(`Project Plan ${ID_A}.md`), { title: 'Project Plan', id: ID_A });
});

test('a name without an id is taken as-is', () => {
  assert.deepEqual(parseNotionName('README.md'), { title: 'README', id: null });
});

test('a name that is only an id keeps something readable', () => {
  const parsed = parseNotionName(`${ID_A}.md`);
  assert.ok(parsed.title.length > 0);
});

test('a zip is recognised by its signature', () => {
  assert.equal(looksLikeZip(Buffer.from(notionZip({ 'a.md': '# x' }))), true);
  assert.equal(looksLikeZip(Buffer.from('<?xml version="1.0"?>')), false);
});

test('mime types are guessed from the extension', () => {
  assert.equal(mimeFor('a.png'), 'image/png');
  assert.equal(mimeFor('b.PDF'), 'application/pdf');
  assert.equal(mimeFor('c.unknown'), 'application/octet-stream');
});

// ----------------------------------------------------------------- paths ---

test('relative paths resolve against the page’s folder', () => {
  assert.equal(resolvePath('Export/Parent abc.md', 'Child%20def.md'), 'Export/Child def.md');
  assert.equal(resolvePath('Export/A/B.md', '../C.md'), 'Export/C.md');
  assert.equal(resolvePath('Export/A/B.md', './img.png'), 'Export/A/img.png');
  assert.equal(resolvePath('A.md', 'B.md#section'), 'B.md');
});

// ------------------------------------------------------------ structure ---

test('the folder tree becomes a page tree', () => {
  const { notes } = readNotionZip(notionZip({
    [`Export/親ページ ${ID_A}.md`]: '# 親ページ\n\n本文',
    [`Export/親ページ ${ID_A}/子ページ ${ID_B}.md`]: '# 子ページ\n\n中身',
  }));

  assert.equal(notes.length, 2);
  const parent = notes.find((n) => n.title === '親ページ')!;
  const child = notes.find((n) => n.title === '子ページ')!;
  assert.equal(parent.parentPath, null);
  assert.equal(child.parentPath, parent.path);
});

test('parents come before their children', () => {
  // The caller creates pages in order, so a child must never arrive first.
  const { notes } = readNotionZip(notionZip({
    [`E/A ${ID_A}/B ${ID_B}/C ${ID_A}.md`]: '# C',
    [`E/A ${ID_A}.md`]: '# A',
    [`E/A ${ID_A}/B ${ID_B}.md`]: '# B',
  }));
  assert.deepEqual(notes.map((n) => n.title), ['A', 'B', 'C']);
});

test('the H1 is used as the title in preference to the filename', () => {
  const { notes } = readNotionZip(notionZip({
    [`古いファイル名 ${ID_A}.md`]: '# 新しいタイトル\n\n本文',
  }));
  assert.equal(notes[0].title, '新しいタイトル');
});

test('a page with no heading falls back to its filename', () => {
  const { notes } = readNotionZip(notionZip({ [`ファイル名 ${ID_A}.md`]: '本文だけ' }));
  assert.equal(notes[0].title, 'ファイル名');
});

// ------------------------------------------------------------- database ---

test('database rows become pages and the duplicate CSV is skipped', () => {
  const { notes, skipped } = readNotionZip(notionZip({
    [`E/顧客一覧 ${ID_A}.csv`]: '名前,金額\n田中,100\n鈴木,200\n',
    [`E/顧客一覧 ${ID_A}/田中 ${ID_B}.md`]: '# 田中\n\n担当: 営業部',
    [`E/顧客一覧 ${ID_A}/鈴木 ${ID_A}.md`]: '# 鈴木\n\n担当: 技術部',
  }));

  assert.deepEqual(notes.map((n) => n.title).sort(), ['田中', '鈴木'].sort());
  assert.equal(skipped.length, 1, 'the CSV twin of the row folder is not imported');
  assert.match(skipped[0], /\.csv$/);
});

test('a standalone CSV with no row folder is kept as an attachment', () => {
  const { assets, skipped } = readNotionZip(notionZip({
    [`E/データ ${ID_A}.csv`]: 'a,b\n1,2\n',
    [`E/ページ ${ID_B}.md`]: '# ページ',
  }));
  assert.equal(skipped.length, 0);
  assert.equal([...assets.keys()].some((p) => p.endsWith('.csv')), true);
});

// ------------------------------------------------------------ markdown ---

test('markdown becomes the editor’s nodes', () => {
  const html = notionMarkdownToHtml([
    '# タイトル',
    '',
    '## 見出し2',
    '',
    '- 箇条書き',
    '',
    '- [x] 済んだ作業',
    '- [ ] まだの作業',
    '',
    '| 項目 | 金額 |',
    '| --- | --- |',
    '| 予算 | 100万円 |',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '> 引用文',
  ].join('\n'));

  const doc = htmlToDoc(html);
  assert.equal(nodesOf(doc, 'heading').length, 1, 'the H1 title is not repeated in the body');
  assert.equal(nodesOf(doc, 'heading')[0].attrs?.level, 2);
  assert.equal(nodesOf(doc, 'bulletList').length, 1);
  assert.equal(nodesOf(doc, 'taskItem').length, 2);
  assert.equal(nodesOf(doc, 'taskItem')[0].attrs?.checked, true);
  assert.equal(nodesOf(doc, 'taskItem')[1].attrs?.checked, false);
  assert.equal(nodesOf(doc, 'table').length, 1);
  assert.equal(nodesOf(doc, 'codeBlock')[0].attrs?.language, 'ts');
  assert.equal(nodesOf(doc, 'blockquote').length, 1);
  assert.match(toPlainText(doc), /100万円/);
});

test('the title heading is removed even when preceded by blank lines', () => {
  const html = notionMarkdownToHtml('\n\n# タイトル\n\n本文');
  const doc = htmlToDoc(html);
  assert.equal(nodesOf(doc, 'heading').length, 0);
  assert.match(toPlainText(doc), /本文/);
});

// ---------------------------------------------------------------- links ---

test('a link between two exported pages resolves to a page link', () => {
  const pageIds = new Map([[`E/相手 ${ID_B}.md`, 'p_other']]);
  const titles = new Map([[`E/相手 ${ID_B}.md`, '相手']]);
  const resolve = linkResolverFor(`E/こちら ${ID_A}.md`, pageIds, titles);

  const html = notionMarkdownToHtml(`# こちら\n\n[あちらを見る](相手%20${ID_B}.md)`);
  const doc = htmlToDoc(html, { resolveLink: resolve });

  const link = nodesOf(doc, 'wikiLink')[0];
  assert.ok(link, 'the markdown link became a page link');
  assert.equal(link.attrs?.pageId, 'p_other');
  assert.equal(link.attrs?.title, 'あちらを見る');
});

test('links both ways resolve, not just forwards', () => {
  const a = `E/A ${ID_A}.md`;
  const b = `E/B ${ID_B}.md`;
  const ids = new Map([[a, 'p_a'], [b, 'p_b']]);
  const titles = new Map([[a, 'A'], [b, 'B']]);

  const docA = htmlToDoc(notionMarkdownToHtml(`[B へ](B%20${ID_B}.md)`),
    { resolveLink: linkResolverFor(a, ids, titles) });
  const docB = htmlToDoc(notionMarkdownToHtml(`[A へ](A%20${ID_A}.md)`),
    { resolveLink: linkResolverFor(b, ids, titles) });

  assert.equal(nodesOf(docA, 'wikiLink')[0].attrs?.pageId, 'p_b');
  assert.equal(nodesOf(docB, 'wikiLink')[0].attrs?.pageId, 'p_a');
});

test('a link to something outside the export stays an ordinary link', () => {
  const resolve = linkResolverFor('E/A.md', new Map(), new Map());
  const doc = htmlToDoc(notionMarkdownToHtml('[外部](https://example.com)'), { resolveLink: resolve });
  assert.equal(nodesOf(doc, 'wikiLink').length, 0);
  assert.equal(nodesOf(doc, 'text')[0].marks?.[0].type, 'link');
});

// ---------------------------------------------------------------- assets ---

test('an image beside a page is found by its relative path', () => {
  const zip = notionZip({
    [`E/ページ ${ID_A}.md`]: `# ページ\n\n![図](ページ%20${ID_A}/図.png)`,
    [`E/ページ ${ID_A}/図.png`]: new Uint8Array([1, 2, 3]),
  });
  const { assets } = readNotionZip(zip);
  const resolve = assetResolverFor(`E/ページ ${ID_A}.md`, assets);

  const found = resolve(`ページ%20${ID_A}/図.png`);
  assert.ok(found, 'the image was located');
  assert.equal(found.resource.filename, '図.png');
  assert.equal(found.resource.mime, 'image/png');
});

test('an asset that is not there resolves to nothing rather than throwing', () => {
  const resolve = assetResolverFor('E/A.md', new Map());
  assert.equal(resolve('missing.png'), null);
  assert.equal(resolve('https://example.com/x.png'), null);
});

// -------------------------------------------------------------- survival ---

test('an empty zip imports nothing and does not throw', () => {
  const { notes, assets } = readNotionZip(notionZip({ 'placeholder.txt': 'x' }));
  assert.deepEqual(notes, []);
  assert.equal(assets.size, 1);
});

test('macOS metadata and dotfiles are ignored', () => {
  const { notes, assets } = readNotionZip(notionZip({
    '__MACOSX/._A.md': 'junk',
    '.DS_Store': 'junk',
    [`E/本物 ${ID_A}.md`]: '# 本物',
  }));
  assert.deepEqual(notes.map((n) => n.title), ['本物']);
  assert.equal(assets.size, 0);
});
