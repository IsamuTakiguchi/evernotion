/**
 * The HTML → Tiptap converter.
 *
 * Both importers funnel through this, so a mistake here loses notes in a way
 * nobody notices until they go looking for one. The assertions are about
 * schema validity as much as content: Tiptap discards a block nested where
 * only inline content is allowed, without an error, so "the text is in there
 * somewhere" is not enough.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToDoc } from '@/lib/import/html';
import { toPlainText, type JSONContent } from '@/lib/editor/doc';

/** Every node of a given type, depth first. */
function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const found: JSONContent[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === type) found.push(n);
    n.content?.forEach(walk);
  };
  walk(doc);
  return found;
}

const first = (doc: JSONContent, type: string) => nodesOf(doc, type)[0];

/**
 * The schema rules that matter, checked structurally.
 *
 * These are the ones Tiptap enforces by deleting content rather than by
 * complaining, which is why they are asserted on every fixture below.
 */
function assertValid(doc: JSONContent) {
  assert.equal(doc.type, 'doc');
  assert.ok((doc.content?.length ?? 0) > 0, 'a document must have content');

  const BLOCKS = new Set([
    'paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'listItem',
    'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'table', 'tableRow',
    'tableCell', 'tableHeader', 'details', 'detailsSummary', 'detailsContent', 'image',
  ]);

  const walk = (node: JSONContent, parent: string) => {
    if (parent === 'paragraph' || parent === 'heading' || parent === 'detailsSummary') {
      assert.ok(!BLOCKS.has(node.type ?? ''),
        `${node.type} must not sit inside ${parent}`);
    }
    if (parent === 'bulletList' || parent === 'orderedList') {
      assert.equal(node.type, 'listItem', 'a list may only contain listItem');
    }
    if (parent === 'taskList') assert.equal(node.type, 'taskItem');
    if (parent === 'table') assert.equal(node.type, 'tableRow');
    if (parent === 'tableRow') {
      assert.ok(['tableCell', 'tableHeader'].includes(node.type ?? ''));
    }
    if (node.type === 'text') assert.equal(typeof node.text, 'string');
    node.content?.forEach((c) => walk(c, node.type ?? ''));
  };
  doc.content!.forEach((n) => walk(n, 'doc'));
}

const convert = (html: string, opts?: Parameters<typeof htmlToDoc>[1]) => {
  const doc = htmlToDoc(html, opts);
  assertValid(doc);
  return doc;
};

// ------------------------------------------------------------ structure ---

test('headings keep their level', () => {
  const doc = convert('<h1>大見出し</h1><h3>小見出し</h3>');
  const headings = nodesOf(doc, 'heading');
  assert.equal(headings.length, 2);
  assert.equal(headings[0].attrs?.level, 1);
  assert.equal(headings[1].attrs?.level, 3);
});

test('Evernote’s div-per-line becomes one paragraph each', () => {
  const doc = convert('<en-note><div>一行目</div><div>二行目</div></en-note>');
  const paras = nodesOf(doc, 'paragraph');
  assert.equal(paras.length, 2);
  assert.equal(toPlainText(doc).trim(), '一行目\n二行目');
});

test('a div wrapping blocks does not become a paragraph around them', () => {
  // This is the case that silently loses content: a paragraph may not contain
  // a list, so Tiptap would drop the list entirely.
  const doc = convert('<div><ul><li>項目</li></ul></div>');
  assert.equal(nodesOf(doc, 'bulletList').length, 1);
  assert.equal(nodesOf(doc, 'listItem').length, 1);
});

test('loose inline content is wrapped in a paragraph', () => {
  const doc = convert('<en-note>裸のテキスト<b>太字</b></en-note>');
  assert.equal(doc.content![0].type, 'paragraph');
  assert.match(toPlainText(doc), /裸のテキスト太字/);
});

test('an empty body still produces a usable document', () => {
  for (const html of ['', '<en-note></en-note>', '   ', '<div></div>']) {
    const doc = convert(html);
    assert.equal(doc.content!.length, 1);
    assert.equal(doc.content![0].type, 'paragraph');
  }
});

// ---------------------------------------------------------------- lists ---

test('ordered and unordered lists keep their kind', () => {
  const doc = convert('<ul><li>あ</li></ul><ol><li>い</li></ol>');
  assert.equal(nodesOf(doc, 'bulletList').length, 1);
  assert.equal(nodesOf(doc, 'orderedList').length, 1);
});

test('nested lists stay nested inside their item', () => {
  const doc = convert('<ul><li>親<ul><li>子</li></ul></li></ul>');
  const outer = first(doc, 'bulletList');
  const item = outer.content![0];
  assert.equal(item.type, 'listItem');
  assert.ok(item.content!.some((c) => c.type === 'bulletList'), 'the child list is inside the item');
});

test('a GFM task list becomes a task list, not a bullet list', () => {
  const doc = convert(
    '<ul><li><input checked="" disabled="" type="checkbox"> 済み</li>'
    + '<li><input disabled="" type="checkbox"> まだ</li></ul>',
  );
  assert.equal(nodesOf(doc, 'bulletList').length, 0);
  const items = nodesOf(doc, 'taskItem');
  assert.equal(items.length, 2);
  assert.equal(items[0].attrs?.checked, true);
  assert.equal(items[1].attrs?.checked, false);
});

test('Evernote checkboxes group into one list', () => {
  const doc = convert(
    '<en-note><div><en-todo checked="true"/>買った</div>'
    + '<div><en-todo checked="false"/>まだ</div>'
    + '<div>ふつうの行</div></en-note>',
  );
  const lists = nodesOf(doc, 'taskList');
  assert.equal(lists.length, 1, 'consecutive to-dos are one list');
  assert.equal(lists[0].content!.length, 2);
  assert.equal(lists[0].content![0].attrs?.checked, true);
  assert.equal(lists[0].content![1].attrs?.checked, false);
  // The ordinary line after them is not swallowed into the list.
  assert.equal(nodesOf(doc, 'paragraph').some((p) => toPlainText(p).includes('ふつうの行')), true);
});

// --------------------------------------------------------------- tables ---

test('a table keeps its rows, header cells and text', () => {
  const doc = convert(
    '<table><thead><tr><th>項目</th><th>金額</th></tr></thead>'
    + '<tbody><tr><td>予算</td><td>100万円</td></tr></tbody></table>',
  );
  const rows = nodesOf(doc, 'tableRow');
  assert.equal(rows.length, 2, 'thead and tbody are flattened away, rows are not');
  assert.equal(nodesOf(doc, 'tableHeader').length, 2);
  assert.equal(nodesOf(doc, 'tableCell').length, 2);
  assert.match(toPlainText(doc), /100万円/);
});

test('table cells hold block content, not bare text', () => {
  const doc = convert('<table><tr><td>値</td></tr></table>');
  const cell = first(doc, 'tableCell');
  assert.equal(cell.content![0].type, 'paragraph');
});

test('colspan and rowspan survive', () => {
  const doc = convert('<table><tr><td colspan="2" rowspan="3">結合</td></tr></table>');
  const cell = first(doc, 'tableCell');
  assert.equal(cell.attrs?.colspan, 2);
  assert.equal(cell.attrs?.rowspan, 3);
});

// ----------------------------------------------------------------- code ---

test('a fenced code block keeps its language and whitespace', () => {
  const doc = convert('<pre><code class="language-ts">const a = 1;\n  indented\n</code></pre>');
  const code = first(doc, 'codeBlock');
  assert.equal(code.attrs?.language, 'ts');
  assert.equal(code.content![0].text, 'const a = 1;\n  indented');
});

test('a code block without a language is still a code block', () => {
  const doc = convert('<pre><code>plain</code></pre>');
  assert.equal(first(doc, 'codeBlock').attrs?.language, null);
});

// ---------------------------------------------------------------- marks ---

test('bold, italic, strike and code become marks', () => {
  const doc = convert('<p><b>ふ</b><em>い</em><del>と</del><code>こ</code></p>');
  const marks = nodesOf(doc, 'text').map((t) => t.marks?.[0]?.type);
  assert.deepEqual(marks, ['bold', 'italic', 'strike', 'code']);
});

test('nested formatting carries both marks', () => {
  const doc = convert('<p><b>太字と<em>斜体</em></b></p>');
  const nested = nodesOf(doc, 'text').find((t) => t.text === '斜体');
  assert.deepEqual(nested!.marks!.map((m) => m.type).sort(), ['bold', 'italic']);
});

test('an unsupported tag keeps its text', () => {
  // <u> has no mark in this editor. Dropping the word with the tag would be
  // the wrong trade.
  const doc = convert('<p>前<u>下線</u>後</p>');
  assert.match(toPlainText(doc), /前下線後/);
});

test('a line break becomes a hard break', () => {
  const doc = convert('<p>上<br/>下</p>');
  assert.equal(nodesOf(doc, 'hardBreak').length, 1);
});

// ---------------------------------------------------------------- links ---

test('an external link becomes a link mark', () => {
  const doc = convert('<p><a href="https://example.com">例</a></p>');
  const text = nodesOf(doc, 'text')[0];
  assert.equal(text.marks?.[0].type, 'link');
  assert.equal(text.marks?.[0].attrs?.href, 'https://example.com');
});

test('a link into the same export becomes a page link', () => {
  const doc = convert('<p><a href="Other%20Page%20abc.md">あちら</a></p>', {
    resolveLink: (href) =>
      href.includes('Other') ? { pageId: 'p_other', title: 'Other Page' } : null,
  });
  const link = first(doc, 'wikiLink');
  assert.equal(link.attrs?.pageId, 'p_other');
  assert.equal(link.attrs?.title, 'あちら');
});

test('an evernote:// link degrades to plain text rather than a dead link', () => {
  const doc = convert('<p><a href="evernote:///view/123/s1/">元のノート</a></p>');
  assert.equal(nodesOf(doc, 'wikiLink').length, 0);
  const text = nodesOf(doc, 'text')[0];
  assert.equal(text.marks, undefined);
  assert.equal(text.text, '元のノート');
});

test('a javascript: href is not turned into a link', () => {
  const doc = convert('<p><a href="javascript:alert(1)">押すな</a></p>');
  const text = nodesOf(doc, 'text')[0];
  assert.equal(text.marks, undefined, 'only http(s), mailto, anchors and paths become links');
});

// ---------------------------------------------------------------- media ---

test('Evernote media is resolved by hash', () => {
  const seen: string[] = [];
  const doc = convert('<en-note><en-media hash="abc123" type="image/png"/></en-note>', {
    resolveMedia: (ref) => {
      seen.push(ref.hash ?? '');
      return { type: 'image', attrs: { src: '/api/attachments/x/file' } };
    },
  });
  assert.deepEqual(seen, ['abc123']);
  assert.equal(nodesOf(doc, 'image').length, 1);
});

test('media the caller declines to resolve is dropped, not left broken', () => {
  const doc = convert('<p>前<img src="missing.png"/>後</p>', { resolveMedia: () => null });
  assert.equal(nodesOf(doc, 'image').length, 0);
  assert.match(toPlainText(doc), /前後/);
});

test('with no resolver at all, media is simply dropped', () => {
  const doc = convert('<p><img src="x.png"/>text</p>');
  assert.equal(nodesOf(doc, 'image').length, 0);
});

// ------------------------------------------------------------- survival ---

test('malformed HTML does not throw', () => {
  for (const html of [
    '<p>閉じてない<b>太字',
    '<ul><li>項目</ul></li>',
    '<table><td>行の外</td></table>',
    '<div'.repeat(50),
    '<p>' + 'あ'.repeat(200_000) + '</p>',
  ]) {
    assert.doesNotThrow(() => htmlToDoc(html), html.slice(0, 40));
  }
});

test('entities and non-breaking spaces come through as text', () => {
  const doc = convert('<p>&lt;tag&gt;&nbsp;&amp;&nbsp;字</p>');
  assert.match(toPlainText(doc), /<tag> & 字/);
});

test('blockquote holds blocks', () => {
  const doc = convert('<blockquote><p>引用</p></blockquote>');
  const quote = first(doc, 'blockquote');
  assert.equal(quote.content![0].type, 'paragraph');
});

test('details keeps its summary and body', () => {
  const doc = convert('<details open><summary>ここを開く</summary><p>中身</p></details>');
  const d = first(doc, 'details');
  assert.equal(d.attrs?.open, true);
  assert.equal(d.content![0].type, 'detailsSummary');
  assert.equal(d.content![1].type, 'detailsContent');
  assert.match(toPlainText(doc), /ここを開く/);
  assert.match(toPlainText(doc), /中身/);
});
