/**
 * Tiptap → Markdown.
 *
 * The round trip is the real assertion: Markdown produced here goes back
 * through the import converter and must land on the same nodes. That is what
 * makes it safe for the MCP tools to read a note out and write one back in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { docToMarkdown, docLinks } from '@/lib/editor/markdown';
import { htmlToDoc } from '@/lib/import/html';
import { notionMarkdownToHtml } from '@/lib/import/notion';
import type { JSONContent } from '@/lib/editor/doc';

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const p = (text: string): JSONContent => ({
  type: 'paragraph', content: [{ type: 'text', text }],
});

/** Markdown out, then back in through the importer. */
const roundTrip = (d: JSONContent) => htmlToDoc(notionMarkdownToHtml(docToMarkdown(d)));

function nodesOf(d: JSONContent, type: string): JSONContent[] {
  const found: JSONContent[] = [];
  const walk = (n: JSONContent) => { if (n.type === type) found.push(n); n.content?.forEach(walk); };
  walk(d);
  return found;
}

// ----------------------------------------------------------------- blocks ---

test('headings keep their level', () => {
  const md = docToMarkdown(doc(
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '大見出し' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '小見出し' }] },
  ));
  assert.match(md, /^# 大見出し$/m);
  assert.match(md, /^### 小見出し$/m);
});

test('paragraphs are separated by a blank line', () => {
  assert.equal(docToMarkdown(doc(p('一行目'), p('二行目'))), '一行目\n\n二行目');
});

test('a paragraph opening with markdown punctuation is escaped', () => {
  // Otherwise reading it back turns the sentence into a heading or a list.
  const md = docToMarkdown(doc(p('# これは見出しではない')));
  assert.equal(md, '\\# これは見出しではない');
  assert.equal(nodesOf(roundTrip(doc(p('# これは見出しではない'))), 'heading').length, 0);
});

test('bullet and ordered lists survive the round trip', () => {
  const source = doc(
    { type: 'bulletList', content: [
      { type: 'listItem', content: [p('あ')] },
      { type: 'listItem', content: [p('い')] },
    ] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [p('一')] }] },
  );
  const md = docToMarkdown(source);
  assert.match(md, /^- あ$/m);
  assert.match(md, /^1\. 一$/m);

  const back = roundTrip(source);
  assert.equal(nodesOf(back, 'bulletList').length, 1);
  assert.equal(nodesOf(back, 'orderedList').length, 1);
});

test('a nested list stays nested', () => {
  const source = doc({ type: 'bulletList', content: [
    { type: 'listItem', content: [
      p('親'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('子')] }] },
    ] },
  ] });

  const back = roundTrip(source);
  const outer = nodesOf(back, 'bulletList')[0];
  assert.ok(
    outer.content![0].content!.some((c) => c.type === 'bulletList'),
    `the child list stayed inside its item:\n${docToMarkdown(source)}`,
  );
});

test('task lists keep their checked state', () => {
  const source = doc({ type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: true }, content: [p('済み')] },
    { type: 'taskItem', attrs: { checked: false }, content: [p('まだ')] },
  ] });
  assert.match(docToMarkdown(source), /^- \[x\] 済み$/m);
  assert.match(docToMarkdown(source), /^- \[ \] まだ$/m);

  const items = nodesOf(roundTrip(source), 'taskItem');
  assert.equal(items.length, 2);
  assert.equal(items[0].attrs?.checked, true);
  assert.equal(items[1].attrs?.checked, false);
});

test('a blockquote round-trips', () => {
  const source = doc({ type: 'blockquote', content: [p('引用文')] });
  assert.match(docToMarkdown(source), /^> 引用文$/m);
  assert.equal(nodesOf(roundTrip(source), 'blockquote').length, 1);
});

test('a code block keeps its language and contents verbatim', () => {
  const source = doc({
    type: 'codeBlock',
    attrs: { language: 'ts' },
    content: [{ type: 'text', text: 'const a = 1;\n  indented' }],
  });
  const md = docToMarkdown(source);
  assert.match(md, /^```ts$/m);

  const back = nodesOf(roundTrip(source), 'codeBlock')[0];
  assert.equal(back.attrs?.language, 'ts');
  assert.equal(back.content![0].text, 'const a = 1;\n  indented');
});

test('a code block containing backticks is fenced longer than its contents', () => {
  // A three-backtick fence would end inside the code and spill the rest of the
  // note out as prose.
  const source = doc({
    type: 'codeBlock',
    attrs: { language: null },
    content: [{ type: 'text', text: 'これは ``` を含む' }],
  });
  const back = nodesOf(roundTrip(source), 'codeBlock')[0];
  assert.equal(back.content![0].text, 'これは ``` を含む');
});

test('a table round-trips with its header and cells', () => {
  const cell = (text: string, header = false): JSONContent => ({
    type: header ? 'tableHeader' : 'tableCell',
    content: [p(text)],
  });
  const source = doc({ type: 'table', content: [
    { type: 'tableRow', content: [cell('項目', true), cell('金額', true)] },
    { type: 'tableRow', content: [cell('予算'), cell('100万円')] },
  ] });

  const back = roundTrip(source);
  assert.equal(nodesOf(back, 'tableRow').length, 2);
  assert.match(docToMarkdown(back), /100万円/);
});

test('a pipe inside a cell does not break the table', () => {
  const source = doc({ type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('式')] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [p('a | b')] }] },
  ] });
  const back = roundTrip(source);
  assert.equal(nodesOf(back, 'tableRow').length, 2, docToMarkdown(source));
});

test('a horizontal rule round-trips', () => {
  assert.equal(nodesOf(roundTrip(doc(p('前'), { type: 'horizontalRule' }, p('後'))), 'horizontalRule').length, 1);
});

test('details becomes a collapsible section and comes back as one', () => {
  const source = doc({ type: 'details', attrs: { open: false }, content: [
    { type: 'detailsSummary', content: [{ type: 'text', text: 'ここを開く' }] },
    { type: 'detailsContent', content: [p('中身')] },
  ] });
  const back = roundTrip(source);
  assert.equal(nodesOf(back, 'details').length, 1, docToMarkdown(source));
  assert.match(docToMarkdown(back), /ここを開く/);
});

// ----------------------------------------------------------------- inline ---

test('marks become their markdown equivalents', () => {
  const md = docToMarkdown(doc({ type: 'paragraph', content: [
    { type: 'text', text: '太', marks: [{ type: 'bold' }] },
    { type: 'text', text: '斜', marks: [{ type: 'italic' }] },
    { type: 'text', text: '消', marks: [{ type: 'strike' }] },
    { type: 'text', text: 'コード', marks: [{ type: 'code' }] },
  ] }));
  assert.equal(md, '**太***斜*~~消~~`コード`');
});

test('a link keeps its target', () => {
  const source = doc({ type: 'paragraph', content: [
    { type: 'text', text: '例', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
  ] });
  assert.equal(docToMarkdown(source), '[例](https://example.com)');
  const back = nodesOf(roundTrip(source), 'text')[0];
  assert.equal(back.marks?.[0].attrs?.href, 'https://example.com');
});

test('code marks are not also emphasised from inside', () => {
  // `*a*` inside code must stay literal, not turn into emphasis.
  const md = docToMarkdown(doc({ type: 'paragraph', content: [
    { type: 'text', text: '*a*', marks: [{ type: 'code' }] },
  ] }));
  assert.equal(md, '`*a*`');
});

test('a wikilink keeps the editor’s own syntax', () => {
  const source = doc({ type: 'paragraph', content: [
    { type: 'text', text: '参照: ' },
    { type: 'wikiLink', attrs: { title: '設計メモ', pageId: 'p_1' } },
  ] });
  assert.equal(docToMarkdown(source), '参照: [[設計メモ]]');
});

test('wikilink targets are reported separately, with their ids', () => {
  // The markdown carries the title; a reader that wants to follow the link
  // needs the id, and putting it in the prose would be noise.
  const links = docLinks(doc({ type: 'paragraph', content: [
    { type: 'wikiLink', attrs: { title: '設計メモ', pageId: 'p_1' } },
    { type: 'wikiLink', attrs: { title: '未作成', pageId: null } },
  ] }));
  assert.deepEqual(links, [
    { title: '設計メモ', pageId: 'p_1' },
    { title: '未作成', pageId: null },
  ]);
});

test('a wikilink written as plain text is not escaped away', () => {
  // How an imported note, or one Claude wrote, carries a link: ordinary text
  // that the app reads as a link. Escaping the brackets would show the syntax
  // instead, and what came back would no longer link if it were written again.
  const source = doc(p('関連: [[来期予算]] と [[契約書]]'));
  assert.equal(docToMarkdown(source), '関連: [[来期予算]] と [[契約書]]');
  assert.deepEqual(docLinks(source), [
    { title: '来期予算', pageId: null },
    { title: '契約書', pageId: null },
  ]);

  // Brackets that are not a wikilink are still escaped, either side of one.
  assert.equal(
    docToMarkdown(doc(p('[注] [[本文]] [1]'))),
    '\\[注\\] [[本文]] \\[1\\]',
  );
});

test('a wikilink quoted inside code is an example, not a link', () => {
  const source = doc({ type: 'codeBlock', content: [{ type: 'text', text: '[[foo]]' }] });
  assert.deepEqual(docLinks(source), []);
});

// ------------------------------------------------------------ attachments ---

test('an image becomes an image', () => {
  const source = doc({ type: 'image', attrs: { src: '/api/attachments/a1/file', alt: '図' } });
  assert.equal(docToMarkdown(source), '![図](/api/attachments/a1/file)');
});

test('attachment paths can be made absolute for a reader outside the app', () => {
  const source = doc({ type: 'image', attrs: { src: '/api/attachments/a1/file', alt: '図' } });
  assert.equal(
    docToMarkdown(source, { baseUrl: 'https://notes.example.com/' }),
    '![図](https://notes.example.com/api/attachments/a1/file)',
  );
  // An address that is already absolute is left alone.
  assert.match(
    docToMarkdown(doc({ type: 'image', attrs: { src: 'https://cdn.example.com/x.png', alt: '' } }),
      { baseUrl: 'https://notes.example.com' }),
    /https:\/\/cdn\.example\.com\/x\.png/,
  );
});

test('a PDF block is rendered as a link rather than disappearing', () => {
  const md = docToMarkdown(doc({
    type: 'pdfAttachment', attrs: { attachmentId: 'att1', filename: '契約書.pdf' },
  }));
  assert.equal(md, '[契約書.pdf](/api/attachments/att1/file)');
});

// -------------------------------------------------------------- survival ---

test('an empty or malformed document does not throw', () => {
  for (const d of [
    null, undefined, {}, { type: 'doc' }, { type: 'doc', content: [] },
    { type: 'doc', content: [{ type: 'unknownFutureNode', content: [p('本文')] }] },
    { type: 'doc', content: [{ type: 'table', content: [] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] },
  ] as (JSONContent | null | undefined)[]) {
    assert.doesNotThrow(() => docToMarkdown(d), JSON.stringify(d));
  }
});

test('an unknown node keeps its text rather than losing it', () => {
  const md = docToMarkdown(doc({ type: 'somethingNew', content: [p('残すべき本文')] }));
  assert.match(md, /残すべき本文/);
});

test('a whole note round-trips through markdown and back', () => {
  const source = doc(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '議事録' }] },
    p('来期の予算について。'),
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [p('資料配布')] },
    ] },
    { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT 1;' }] },
  );
  const back = roundTrip(source);

  assert.equal(nodesOf(back, 'heading')[0].attrs?.level, 2);
  assert.equal(nodesOf(back, 'taskItem')[0].attrs?.checked, true);
  assert.equal(nodesOf(back, 'codeBlock')[0].attrs?.language, 'sql');
  assert.match(docToMarkdown(back), /来期の予算について。/);
});
