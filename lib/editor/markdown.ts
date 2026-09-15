/**
 * Tiptap document → Markdown.
 *
 * The reverse of the import converter, and it exists for the same reason that
 * one does: something outside the editor needs the notes in a form it
 * understands. `toPlainText` already flattens a document for the search index,
 * but flattening is exactly wrong here — handing Claude a note with its
 * headings, tables and checkboxes collapsed into prose throws away the
 * structure that makes it worth reading.
 *
 * The output is GFM, so it round-trips: Markdown written back through
 * lib/import/html.ts returns to the same nodes.
 */
import { extractWikiLinks } from './doc';
import type { JSONContent, WikiLinkRef } from './doc';

export type MarkdownOptions = {
  /** Absolute origin for attachment links, when the reader is not the app. */
  baseUrl?: string;
};

export function docToMarkdown(
  doc: JSONContent | null | undefined,
  opts: MarkdownOptions = {},
): string {
  if (!doc?.content?.length) return '';
  return blocks(doc.content, opts, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every wikilink in a document, so a reader can follow them by id.
 *
 * The app's own extractor, not a second one: it finds links stored as nodes
 * and links written as plain text alike, and ignores the ones quoted inside
 * code. What Claude is told links to what is then the same set the backlinks
 * and the graph are built from.
 */
export function docLinks(doc: JSONContent | null | undefined): WikiLinkRef[] {
  return extractWikiLinks(doc);
}

function blocks(nodes: JSONContent[], opts: MarkdownOptions, indent: string): string {
  return nodes.map((node) => block(node, opts, indent)).filter(Boolean).join('\n\n');
}

function block(node: JSONContent, opts: MarkdownOptions, indent: string): string {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${'#'.repeat(level)} ${inline(node.content ?? [], opts)}`;
    }

    case 'paragraph': {
      const text = inline(node.content ?? [], opts);
      // A line opening with markdown punctuation would change meaning when
      // read back, so the marker is escaped rather than the whole line.
      return text.replace(/^(\s*)([#>\-+*]|\d+\.)(\s)/, '$1\\$2$3');
    }

    case 'bulletList':
      return list(node, opts, indent, () => '- ');

    case 'orderedList':
      return list(node, opts, indent, (i) => `${i + 1}. `);

    case 'taskList':
      return list(node, opts, indent, (_, item) =>
        `- [${item.attrs?.checked ? 'x' : ' '}] `);

    case 'blockquote':
      return blocks(node.content ?? [], opts, indent)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');

    case 'codeBlock': {
      const language = node.attrs?.language;
      const body = (node.content ?? []).map((c) => c.text ?? '').join('');
      // A fence has to be longer than the longest run of backticks inside it,
      // or the block ends early and the rest of the note becomes prose.
      const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}${typeof language === 'string' ? language : ''}\n${body}\n${fence}`;
    }

    case 'horizontalRule':
      return '---';

    case 'table':
      return table(node, opts);

    case 'image': {
      const src = url(String(node.attrs?.src ?? ''), opts);
      return src ? `![${String(node.attrs?.alt ?? '')}](${src})` : '';
    }

    // The editor's PDF block. Rendered as a link so a reader knows the file is
    // attached and where it is, rather than seeing a gap.
    case 'pdfAttachment': {
      const id = String(node.attrs?.attachmentId ?? '');
      const name = String(node.attrs?.filename ?? 'PDF');
      return id ? `[${name}](${url(`/api/attachments/${id}/file`, opts)})` : `[${name}]`;
    }

    case 'details': {
      const summary = node.content?.find((c) => c.type === 'detailsSummary');
      const body = node.content?.find((c) => c.type === 'detailsContent');
      // Markdown has no collapsible section; the HTML form is valid Markdown
      // and converts back into a details node on the way in.
      return [
        '<details>',
        `<summary>${inline(summary?.content ?? [], opts)}</summary>`,
        '',
        blocks(body?.content ?? [], opts, indent),
        '',
        '</details>',
      ].join('\n');
    }

    // A node type added later should not silently vanish; its text survives.
    default:
      if (node.content) return blocks(node.content, opts, indent);
      return node.text ? escapeText(node.text) : '';
  }
}

function list(
  node: JSONContent,
  opts: MarkdownOptions,
  indent: string,
  marker: (index: number, item: JSONContent) => string,
): string {
  return (node.content ?? [])
    .map((item, i) => {
      const bullet = marker(i, item);
      const inner = blocks(item.content ?? [], opts, `${indent}${' '.repeat(bullet.length)}`);
      const [first, ...rest] = inner.split('\n');
      // Continuation lines line up under the text, not under the marker, or
      // they read as a new paragraph outside the item.
      return [
        `${indent}${bullet}${first ?? ''}`,
        ...rest.map((line) => (line ? `${indent}${' '.repeat(bullet.length)}${line}` : '')),
      ].join('\n');
    })
    .join('\n');
}

function table(node: JSONContent, opts: MarkdownOptions): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';

  const cellText = (cell: JSONContent) =>
    // A pipe inside a cell would end the column early.
    blocks(cell.content ?? [], opts, '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();

  const grid = rows.map((row) => (row.content ?? []).map(cellText));
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (cells: string[]) =>
    `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;

  // GFM requires a header row. When the note's table has none, an empty one is
  // added — without it the whole table renders as literal text.
  const headerIsReal = (rows[0].content ?? []).some((c) => c.type === 'tableHeader');
  const header = headerIsReal ? grid[0] : Array(width).fill('');
  const body = headerIsReal ? grid.slice(1) : grid;

  return [
    pad(header),
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map(pad),
  ].join('\n');
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function inline(nodes: JSONContent[], opts: MarkdownOptions): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '  \n';

    if (node.type === 'wikiLink') {
      // The editor's own syntax, which is also how it is typed back in.
      return `[[${String(node.attrs?.title ?? '')}]]`;
    }

    if (node.type === 'image') {
      const src = url(String(node.attrs?.src ?? ''), opts);
      return src ? `![${String(node.attrs?.alt ?? '')}](${src})` : '';
    }

    if (node.text === undefined) {
      return node.content ? inline(node.content, opts) : '';
    }

    let text = escapeText(node.text);
    // Code first: its delimiters are literal, so wrapping emphasis outside it
    // is right and emphasis inside it would be shown rather than applied.
    const marks = (node.marks ?? []) as Mark[];
    const has = (type: string) => marks.some((m) => m.type === type);

    if (has('code')) text = `\`${node.text.replace(/`/g, '\\`')}\``;
    if (has('bold')) text = `**${text}**`;
    if (has('italic')) text = `*${text}*`;
    if (has('strike')) text = `~~${text}~~`;

    const link = marks.find((m) => m.type === 'link');
    if (link?.attrs?.href) text = `[${text}](${url(String(link.attrs.href), opts)})`;

    return text;
  }).join('');
}

/** Make an app-relative path absolute, when the reader is outside the app. */
function url(href: string, opts: MarkdownOptions): string {
  if (!opts.baseUrl || !href.startsWith('/')) return href;
  return `${opts.baseUrl.replace(/\/+$/, '')}${href}`;
}

/** A [[wikilink]] written as plain text, which is how a pasted or imported one arrives. */
const RAW_WIKILINK = /\[\[[^[\]|]{1,200}\]\]/g;

/**
 * Escape only what would otherwise be read as markup.
 *
 * A raw-text wikilink is the exception. The editor stores one as a `wikiLink`
 * node when it was typed here, but as ordinary text when it came from an
 * import or from Claude — and both are real links, because the app reads
 * `[[…]]` out of text too. Escaping the brackets would hand back something
 * that is neither what the note says nor what would link if written again.
 */
function escapeText(text: string): string {
  const out: string[] = [];
  let at = 0;
  for (const match of text.matchAll(RAW_WIKILINK)) {
    out.push(escapeRun(text.slice(at, match.index)), match[0]);
    at = match.index + match[0].length;
  }
  out.push(escapeRun(text.slice(at)));
  return out.join('');
}

const escapeRun = (run: string) => run.replace(/([\\`*_[\]])/g, '\\$1');
