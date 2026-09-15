/**
 * HTML → Tiptap document.
 *
 * The one converter both importers go through. Evernote's ENML is a subset of
 * XHTML already; Notion's markdown becomes HTML on the way in. Writing this
 * twice would mean two sets of edge cases drifting apart, and the edge cases
 * are the whole job — `<div>` soup from Evernote, GFM task lists from Notion.
 *
 * The output has to be valid against the editor's schema, not merely
 * plausible: Tiptap silently drops content that does not fit (a block inside a
 * paragraph, a bare cell outside a row), and silently losing notes during an
 * import is the worst way for this to fail. So blocks and inlines are built by
 * separate passes that cannot nest the wrong way round.
 */
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';

import type { JSONContent } from '../editor/doc';

export type MediaRef = { hash?: string; src?: string; alt?: string; mime?: string };

export type HtmlToDocOptions = {
  /** Turn an <img> or Evernote <en-media> into a node, or null to drop it. */
  resolveMedia?: (ref: MediaRef) => JSONContent | null;
  /** Turn an href into an internal page link, when it names an imported note. */
  resolveLink?: (href: string) => { pageId: string; title: string } | null;
};

/** Marks the editor understands. `<u>` has no equivalent, so it only passes text through. */
const MARK_BY_TAG: Record<string, string> = {
  b: 'bold', strong: 'bold',
  i: 'italic', em: 'italic',
  s: 'strike', strike: 'strike', del: 'strike',
  code: 'code',
};

const isElement = (node: ChildNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';
const tagOf = (node: ChildNode): string => (isElement(node) ? node.name.toLowerCase() : '');
const attr = (el: Element, name: string): string | undefined => el.attribs?.[name];

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'blockquote', 'hr', 'details',
  'summary', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
  'en-note', 'center',
]);

const paragraph = (content: JSONContent[]): JSONContent =>
  content.length ? { type: 'paragraph', content } : { type: 'paragraph' };

/**
 * Nodes that read as inline in the source but are block-level in the schema.
 *
 * An image sits mid-sentence in ENML, but this editor's image is a block, so a
 * paragraph containing one is invalid and Tiptap drops it — image and all.
 * They are lifted out and the paragraph is split around them instead.
 */
const LIFTED = new Set(['image']);

/** Turn a run of inline nodes into paragraphs, split around any lifted node. */
function paragraphsFrom(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let run: JSONContent[] = [];

  const flush = () => {
    if (run.some((n) => n.type !== 'text' || (n.text ?? '').trim())) out.push(paragraph(run));
    run = [];
  };

  for (const node of nodes) {
    if (LIFTED.has(node.type ?? '')) {
      flush();
      out.push(node);
    } else {
      run.push(node);
    }
  }
  flush();

  // GFM writes `- [x] text`, so removing the checkbox leaves the space that
  // followed it at the head of the line. Harmless on screen, but it survives
  // into the stored document and comes back doubled on the way out.
  for (const block of out) {
    const first = block.content?.[0];
    if (first?.type === 'text' && first.text) first.text = first.text.replace(/^ +/, '');
  }
  return out.filter((b) => b.type !== 'paragraph' || (b.content?.length ?? 0) > 0
    || !b.content);
}

/** Inline nodes only, for containers that cannot hold blocks at all. */
function inlineOnly(nodes: JSONContent[]): { content: JSONContent[]; lifted: JSONContent[] } {
  return {
    content: nodes.filter((n) => !LIFTED.has(n.type ?? '')),
    lifted: nodes.filter((n) => LIFTED.has(n.type ?? '')),
  };
}

/** Collapse the whitespace HTML treats as insignificant, keeping &nbsp; as a space. */
function normaliseText(text: string): string {
  return text.replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ');
}

export function htmlToDoc(html: string, opts: HtmlToDocOptions = {}): JSONContent {
  const dom = parseDocument(html, { decodeEntities: true, lowerCaseTags: true });

  // Evernote wraps everything in <en-note>; unwrap so its children are the
  // top level rather than one giant block.
  const roots = dom.children.filter((n) => tagOf(n) !== 'en-note');
  const source = roots.length
    ? dom.children.flatMap((n) => (tagOf(n) === 'en-note' ? (n as Element).children : [n]))
    : dom.children;

  const content = blocks(source, opts);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/**
 * Convert a run of siblings into block nodes.
 *
 * Inline children encountered between blocks are gathered into a paragraph,
 * because the schema has nowhere else to put them.
 */
function blocks(nodes: ChildNode[], opts: HtmlToDocOptions): JSONContent[] {
  const out: JSONContent[] = [];
  let pending: JSONContent[] = [];

  const flush = () => {
    out.push(...paragraphsFrom(pending));
    pending = [];
  };

  for (const node of nodes) {
    const tag = tagOf(node);

    // A <div> holding an Evernote checkbox is a to-do line. Consecutive ones
    // are one list, which is how they were written and how they should read.
    if (isTodoLine(node)) {
      flush();
      const item = todoItem(node as Element, opts);
      const last = out.at(-1);
      if (last?.type === 'taskList') last.content!.push(item);
      else out.push({ type: 'taskList', content: [item] });
      continue;
    }

    if (!tag || !BLOCK_TAGS.has(tag)) {
      pending.push(...inline([node], opts, []));
      continue;
    }

    flush();
    out.push(...block(node as Element, tag, opts));
  }

  flush();
  return out;
}

/** `<div><en-todo checked="true"/>…</div>` — Evernote's checkbox line. */
function isTodoLine(node: ChildNode): boolean {
  if (!isElement(node)) return false;
  const tag = node.name.toLowerCase();
  if (tag !== 'div' && tag !== 'p') return false;
  return node.children.some((c) => tagOf(c) === 'en-todo');
}

function todoItem(el: Element, opts: HtmlToDocOptions): JSONContent {
  const todo = el.children.find((c) => tagOf(c) === 'en-todo') as Element | undefined;
  const checked = attr(todo!, 'checked') === 'true';
  const rest = el.children.filter((c) => tagOf(c) !== 'en-todo');
  return {
    type: 'taskItem',
    attrs: { checked },
    content: ensureBlocks(paragraphsFrom(inline(rest, opts, []))),
  };
}

function block(el: Element, tag: string, opts: HtmlToDocOptions): JSONContent[] {
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const { content, lifted } = inlineOnly(inline(el.children, opts, []));
      return [{ type: 'heading', attrs: { level: Number(tag[1]) }, content }, ...lifted];
    }

    case 'hr':
      return [{ type: 'horizontalRule' }];

    case 'pre':
      return [codeBlock(el)];

    case 'blockquote':
      return [{ type: 'blockquote', content: ensureBlocks(blocks(el.children, opts)) }];

    case 'ul': case 'ol':
      return list(el, tag, opts);

    case 'table':
      return [table(el, opts)];

    case 'details':
      return [details(el, opts)];

    case 'p': {
      const parts = paragraphsFrom(inline(el.children, opts, []));
      // An empty <p> is still a blank line the writer put there.
      return parts.length ? parts : [{ type: 'paragraph' }];
    }

    // A <div> is whatever its contents make it. Evernote uses it for plain
    // lines, so a div of inline content is a paragraph — but one holding
    // blocks must not become a paragraph wrapping blocks, which the schema
    // forbids and Tiptap would discard.
    default:
      return blocks(el.children, opts);
  }
}

/** Block containers need at least one child, or the node is invalid. */
function ensureBlocks(content: JSONContent[]): JSONContent[] {
  return content.length ? content : [{ type: 'paragraph' }];
}

function codeBlock(el: Element): JSONContent {
  const code = el.children.find((c) => tagOf(c) === 'code') as Element | undefined;
  const target = code ?? el;
  const language = (attr(target, 'class') ?? '')
    .split(/\s+/)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length);

  // Whitespace is the content here, so it is taken verbatim rather than
  // normalised the way prose is.
  const text = textOf(target).replace(/\n$/, '');
  return {
    type: 'codeBlock',
    attrs: { language: language ?? null },
    content: text ? [{ type: 'text', text }] : undefined,
  };
}

/**
 * A list, or several — markdown does not keep task items in a list of their own.
 *
 * GFM writes `- [x] done` as an ordinary list whose item opens with a
 * checkbox, so one `<ul>` can hold both kinds. Forcing the whole list to be
 * one or the other would either turn plain bullets into checkboxes or throw
 * the checkboxes away, so consecutive runs are split into separate lists.
 */
function list(el: Element, tag: string, opts: HtmlToDocOptions): JSONContent[] {
  const items = el.children.filter((c) => tagOf(c) === 'li') as Element[];
  const listType = tag === 'ol' ? 'orderedList' : 'bulletList';

  if (!items.length) {
    return [{ type: listType, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }];
  }

  const runs: { task: boolean; items: Element[] }[] = [];
  for (const li of items) {
    const task = checkboxOf(li) !== undefined;
    const last = runs.at(-1);
    if (last && last.task === task) last.items.push(li);
    else runs.push({ task, items: [li] });
  }

  return runs.map(({ task, items: group }) => (task
    ? {
      type: 'taskList',
      content: group.map((li) => {
        const box = checkboxOf(li)!;
        const checked = attr(box, 'checked') !== undefined;
        detach(box);
        return {
          type: 'taskItem',
          attrs: { checked },
          content: ensureBlocks(blocks(li.children, opts)),
        };
      }),
    }
    : {
      type: listType,
      content: group.map((li) => ({
        type: 'listItem',
        content: ensureBlocks(blocks(li.children, opts)),
      })),
    }));
}

/**
 * The checkbox that marks this item as a to-do.
 *
 * A "loose" list — one with blank lines between items — has its content
 * wrapped in a `<p>`, putting the checkbox one level deeper than in a tight
 * one. Looking only at direct children would silently turn every task in such
 * a list back into a plain bullet.
 */
function checkboxOf(li: Element): Element | undefined {
  const isBox = (c: ChildNode) =>
    tagOf(c) === 'input' && attr(c as Element, 'type') === 'checkbox';

  const direct = li.children.find(isBox);
  if (direct) return direct as Element;

  const firstBlock = li.children.find((c) => ['p', 'div'].includes(tagOf(c))) as Element | undefined;
  return firstBlock?.children.find(isBox) as Element | undefined;
}

/** Remove a node from its parent, so it is not converted a second time. */
function detach(node: ChildNode) {
  const parent = node.parent as { children?: ChildNode[] } | null;
  if (parent?.children) parent.children = parent.children.filter((c) => c !== node);
}

function table(el: Element, opts: HtmlToDocOptions): JSONContent {
  // thead/tbody are structure the editor does not model; the rows inside them
  // are what matter, so they are flattened out.
  const rows: Element[] = [];
  const collect = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (tag === 'tr') rows.push(n as Element);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') collect((n as Element).children);
    }
  };
  collect(el.children);

  return {
    type: 'table',
    content: rows.map((tr) => ({
      type: 'tableRow',
      content: (tr.children.filter((c) => ['td', 'th'].includes(tagOf(c))) as Element[]).map((cell) => ({
        type: tagOf(cell) === 'th' ? 'tableHeader' : 'tableCell',
        attrs: {
          colspan: Number(attr(cell, 'colspan') ?? 1) || 1,
          rowspan: Number(attr(cell, 'rowspan') ?? 1) || 1,
          colwidth: null,
        },
        content: ensureBlocks(blocks(cell.children, opts)),
      })),
    })).filter((row) => (row.content?.length ?? 0) > 0),
  };
}

function details(el: Element, opts: HtmlToDocOptions): JSONContent {
  const summary = el.children.find((c) => tagOf(c) === 'summary') as Element | undefined;
  const rest = el.children.filter((c) => c !== summary);
  const head = inlineOnly(summary ? inline(summary.children, opts, []) : []);
  return {
    type: 'details',
    attrs: { open: attr(el, 'open') !== undefined },
    content: [
      { type: 'detailsSummary', content: head.content },
      { type: 'detailsContent', content: ensureBlocks([...head.lifted, ...blocks(rest, opts)]) },
    ],
  };
}

type Mark = { type: string; attrs?: Record<string, unknown> };

/** Convert a run of siblings into inline nodes, carrying marks down the tree. */
function inline(nodes: ChildNode[], opts: HtmlToDocOptions, marks: Mark[]): JSONContent[] {
  const out: JSONContent[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const text = normaliseText((node as unknown as { data: string }).data);
      if (text) out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.name.toLowerCase();

    if (tag === 'br') {
      out.push({ type: 'hardBreak' });
      continue;
    }

    if (tag === 'img' || tag === 'en-media') {
      const resolved = opts.resolveMedia?.({
        hash: attr(node, 'hash'),
        src: attr(node, 'src'),
        alt: attr(node, 'alt'),
        mime: attr(node, 'type'),
      });
      if (resolved) out.push(resolved);
      continue;
    }

    if (tag === 'a') {
      out.push(...anchor(node, opts, marks));
      continue;
    }

    const mark = MARK_BY_TAG[tag];
    out.push(...inline(node.children, opts, mark ? [...marks, { type: mark }] : marks));
  }

  return out;
}

function anchor(el: Element, opts: HtmlToDocOptions, marks: Mark[]): JSONContent[] {
  const href = attr(el, 'href') ?? '';
  const label = textOf(el).trim();

  // A link to another note in the same export becomes a real page link, so
  // backlinks and the graph work the moment the import finishes rather than
  // only for notes edited afterwards.
  const internal = href ? opts.resolveLink?.(href) : null;
  if (internal) {
    return [{
      type: 'wikiLink',
      attrs: { title: label || internal.title, pageId: internal.pageId },
    }];
  }

  // Evernote's own scheme cannot be resolved outside Evernote; keeping it as a
  // link would offer the reader a dead end, so only the text survives.
  if (/^evernote:/i.test(href)) {
    return inline(el.children, opts, marks);
  }

  if (!href || !/^(https?:|mailto:|#|\/)/i.test(href)) {
    return inline(el.children, opts, marks);
  }

  return inline(el.children, opts, [...marks, { type: 'link', attrs: { href } }]);
}

/** All text under a node, unnormalised. */
function textOf(node: ChildNode | Element): string {
  if (node.type === 'text') return (node as unknown as { data: string }).data;
  if (!isElement(node)) return '';
  return node.children.map(textOf).join('');
}
