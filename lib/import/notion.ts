/**
 * Notion "Markdown & CSV" ZIP exports.
 *
 * The export is a folder tree: one `.md` per page, a folder beside it holding
 * that page's children, and attachments sitting next to the page that uses
 * them. A database is a `.csv` plus a folder of one `.md` per row — the rows
 * are pages in Notion, so they are pages here too, and the CSV is redundant
 * once the folder is read.
 *
 * Every name carries Notion's 32-hex id: `Meeting notes a1b2….md`. The id is
 * stripped from the title and kept as the key that links resolve through.
 */
import { unzipSync } from 'fflate';
import { marked } from 'marked';

import type { ImportedNote, ImportedResource } from './types';

/** Notion appends a 32-character hex id to every exported file and folder. */
const NOTION_ID = /\s+([0-9a-f]{32})(?=\.|$)/i;

export function looksLikeZip(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b; // "PK"
}

/** `Meeting notes a1b2c3….md` → `{ title: 'Meeting notes', id: 'a1b2c3…' }` */
export function parseNotionName(name: string): { title: string; id: string | null } {
  const base = name.replace(/\.[^.]+$/, '');
  const match = base.match(NOTION_ID);
  if (!match) return { title: base.trim(), id: null };
  return { title: base.slice(0, match.index).trim() || base.trim(), id: match[1].toLowerCase() };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', json: 'application/json',
  zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/** Resolve `../sibling/file.md` against the folder a page lives in. */
function resolvePath(from: string, href: string): string {
  const target = decodeURIComponent(href.split('#')[0].split('?')[0]);
  if (!target) return '';
  const segments = (dirOf(from) + target).split('/');
  const stack: string[] = [];
  for (const part of segments) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Read a Notion export.
 *
 * Notes come back in the order their files appear, with `path` and
 * `parentPath` describing the tree so the caller can create pages before
 * bodies are converted — which is what lets a link between two notes resolve
 * to a real page id in either direction.
 */
export function readNotionZip(zip: Uint8Array): {
  notes: ImportedNote[];
  /** Files that are not pages: images, PDFs, and the CSV twin of a database. */
  assets: Map<string, ImportedResource>;
  /** Each page's markdown, keyed by its path. Returned here so the caller
   *  never has to unzip the archive a second time to read the bodies. */
  bodies: Map<string, string>;
  skipped: string[];
} {
  const entries = unzipSync(zip);

  const assets = new Map<string, ImportedResource>();
  const markdown: string[] = [];
  const skipped: string[] = [];

  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/') || bytes.byteLength === 0) continue;
    const name = path.split('/').pop()!;
    if (name.startsWith('.') || name === '__MACOSX') continue;

    if (name.toLowerCase().endsWith('.md')) {
      markdown.push(path);
      continue;
    }
    // A database exports as both a .csv and a folder of per-row .md files.
    // The rows carry everything the CSV does plus their page bodies, so the
    // CSV would only duplicate them as an unreadable blob.
    if (name.toLowerCase().endsWith('.csv') && hasRowFolder(path, entries)) {
      skipped.push(path);
      continue;
    }
    assets.set(path, { filename: name, mime: mimeFor(name), data: bytes });
  }

  // Longest paths last, so a parent is always created before its children.
  markdown.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const byPath = new Set(markdown);
  const bodies = new Map<string, string>();
  const decoder = new TextDecoder();

  const notes = markdown.map((path) => {
    const { title } = parseNotionName(path.split('/').pop()!);
    const body = decoder.decode(entries[path]);
    bodies.set(path, body);
    return {
      title: titleOf(body) || title || '無題',
      html: '',                    // filled in by the caller, after ids exist
      tags: [],
      resources: [],
      path,
      parentPath: parentOf(path, byPath),
    } satisfies ImportedNote;
  });

  return { notes, assets, bodies, skipped };
}

/** The .csv of a database sits beside a folder of the same name holding its rows. */
function hasRowFolder(csvPath: string, entries: Record<string, Uint8Array>): boolean {
  const folder = `${csvPath.replace(/\.csv$/i, '')}/`;
  return Object.keys(entries).some((p) => p.startsWith(folder) && p.toLowerCase().endsWith('.md'));
}

/**
 * The page whose folder this file sits in.
 *
 * Notion names a page's folder exactly like its file minus the extension, so
 * `A 111/B 222.md` belongs under `A 111.md`.
 */
function parentOf(path: string, all: Set<string>): string | null {
  const dir = dirOf(path).replace(/\/$/, '');
  if (!dir) return null;
  const candidate = `${dir}.md`;
  return all.has(candidate) ? candidate : null;
}

/** Notion opens each export with the page title as an H1. */
function titleOf(markdownBody: string): string {
  const line = markdownBody.split('\n').find((l) => l.trim().startsWith('# '));
  return line ? line.replace(/^\s*#\s+/, '').trim() : '';
}

/**
 * Convert one page's markdown to HTML, ready for the shared converter.
 *
 * The leading H1 is dropped because it becomes the page title, and repeating
 * it as the first line of the body is noise in every single note.
 */
export function notionMarkdownToHtml(body: string): string {
  const lines = body.split('\n');
  const h1 = lines.findIndex((l) => l.trim().startsWith('# '));
  if (h1 !== -1) lines.splice(h1, 1);

  return marked.parse(lines.join('\n'), { async: false, gfm: true, breaks: false });
}

/**
 * Build the link resolver for one page.
 *
 * `pageIdByPath` maps an entry in the zip to the page created for it, so a
 * relative markdown link becomes a real page link rather than dead text.
 */
export function linkResolverFor(
  fromPath: string,
  pageIdByPath: Map<string, string>,
  titleByPath: Map<string, string>,
) {
  return (href: string): { pageId: string; title: string } | null => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null;
    const target = resolvePath(fromPath, href);
    const pageId = pageIdByPath.get(target);
    return pageId ? { pageId, title: titleByPath.get(target) ?? '' } : null;
  };
}

/** Build the media resolver for one page, over the assets found in the zip. */
export function assetResolverFor(
  fromPath: string,
  assets: Map<string, ImportedResource>,
): (src: string) => { path: string; resource: ImportedResource } | null {
  return (src: string) => {
    if (/^[a-z]+:/i.test(src)) return null;   // already a URL; leave it alone
    const path = resolvePath(fromPath, src);
    const resource = assets.get(path);
    return resource ? { path, resource } : null;
  };
}

export { resolvePath };
