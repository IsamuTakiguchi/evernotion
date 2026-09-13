export type JSONContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

export const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** Nodes whose text should be followed by a line break when flattening. */
const BLOCK_NODES = new Set([
  'paragraph', 'heading', 'listItem', 'taskItem', 'blockquote',
  'codeBlock', 'tableRow', 'callout', 'toggle', 'horizontalRule',
]);

/**
 * Flatten a Tiptap document to plain text for full-text search and embedding.
 * Attachment blocks contribute their filename; wikilinks contribute their title.
 */
export function toPlainText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const out: string[] = [];

  const walk = (node: JSONContent) => {
    if (node.text) out.push(node.text);
    if (node.type === 'wikiLink') out.push(String(node.attrs?.title ?? ''));
    if (node.type === 'pdfAttachment') out.push(String(node.attrs?.filename ?? ''));
    if (node.type === 'image' && node.attrs?.alt) out.push(String(node.attrs.alt));
    if (node.content) for (const child of node.content) walk(child);
    if (node.type && BLOCK_NODES.has(node.type)) out.push('\n');
  };

  walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** First non-empty line of the document, used to auto-title untitled pages. */
export function firstLine(doc: JSONContent | null | undefined): string {
  const text = toPlainText(doc);
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return (line ?? '').trim().slice(0, 120);
}

/**
 * Text that is marked as code, or sits inside a code block, is quoted rather
 * than written — `[[foo]]` in a snippet is an example of the syntax, not a use
 * of it, and turning it into a link would invent a page the user never asked
 * for. The same reasoning applies to `#include` and inline tags.
 */
function isLiteral(node: JSONContent): boolean {
  return node.type === 'codeBlock' || !!node.marks?.some((m) => m.type === 'code');
}

export type WikiLinkRef = {
  title: string;
  /** Set when the link was chosen from autocomplete, which names an exact page. */
  pageId: string | null;
};

/**
 * Collect every [[wikilink]] in a document.
 *
 * Keeps the target's page id when the node carries one. Resolving purely by
 * title would send a link to whichever page happens to hold that title first,
 * which is the wrong page as soon as two notes share a name.
 */
export function extractWikiLinks(doc: JSONContent | null | undefined): WikiLinkRef[] {
  if (!doc) return [];
  const byTitle = new Map<string, WikiLinkRef>();

  const add = (title: string, pageId: string | null) => {
    const key = title.trim();
    if (!key) return;
    const existing = byTitle.get(key);
    // An explicit id is better information than the same title without one.
    if (!existing) byTitle.set(key, { title: key, pageId });
    else if (!existing.pageId && pageId) existing.pageId = pageId;
  };

  const walk = (node: JSONContent) => {
    if (isLiteral(node)) return;

    if (node.type === 'wikiLink') {
      const pageId = node.attrs?.pageId;
      add(String(node.attrs?.title ?? ''), typeof pageId === 'string' ? pageId : null);
    }
    // Also honour links typed as raw text, so pasted markdown still links up.
    if (node.text) {
      for (const m of node.text.matchAll(/\[\[([^\[\]|]{1,200})\]\]/g)) {
        add(m[1], null);
      }
    }
    if (node.content) for (const child of node.content) walk(child);
  };

  walk(doc);
  return [...byTitle.values()];
}

/** Collect #tags written inline in the document body. */
export function extractInlineTags(doc: JSONContent | null | undefined): string[] {
  if (!doc) return [];
  const tags = new Set<string>();
  const walk = (node: JSONContent) => {
    if (isLiteral(node)) return;
    if (node.text) {
      for (const m of node.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]{1,50})/gu)) {
        tags.add(m[1]);
      }
    }
    if (node.content) for (const child of node.content) walk(child);
  };
  walk(doc);
  return [...tags];
}
