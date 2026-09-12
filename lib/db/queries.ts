import { nanoid } from 'nanoid';
import { getDb } from './client';
import {
  EMPTY_DOC, extractInlineTags, extractWikiLinks, firstLine, toPlainText,
  type JSONContent,
} from '../editor/doc';
import { indexSearchDoc, removeSearchDoc } from '../search/index';

export type PageRow = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  doc_json: string;
  plain_text: string;
  sort_order: number;
  is_favorite: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PageTreeNode = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  isFavorite: boolean;
  updatedAt: string;
  children: PageTreeNode[];
};

export function listPageTree(): PageTreeNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, icon, is_favorite, updated_at
         FROM pages WHERE archived_at IS NULL
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .all() as Pick<PageRow, 'id' | 'parent_id' | 'title' | 'icon' | 'is_favorite' | 'updated_at'>[];

  const byId = new Map<string, PageTreeNode>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      parentId: r.parent_id,
      title: r.title,
      icon: r.icon,
      isFavorite: !!r.is_favorite,
      updatedAt: r.updated_at,
      children: [],
    });
  }
  const roots: PageTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function getPage(id: string): PageRow | undefined {
  return getDb().prepare('SELECT * FROM pages WHERE id = ?').get(id) as PageRow | undefined;
}

export function findPageByTitle(title: string): PageRow | undefined {
  return getDb()
    .prepare('SELECT * FROM pages WHERE title = ? AND archived_at IS NULL LIMIT 1')
    .get(title) as PageRow | undefined;
}

export function createPage(opts: {
  title?: string;
  parentId?: string | null;
  icon?: string | null;
  doc?: JSONContent;
} = {}): PageRow {
  const db = getDb();
  const id = nanoid(12);
  const doc = opts.doc ?? EMPTY_DOC;
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM pages WHERE parent_id IS ?')
    .get(opts.parentId ?? null) as { n: number };

  db.prepare(
    `INSERT INTO pages (id, parent_id, title, icon, doc_json, plain_text, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.parentId ?? null,
    opts.title ?? '',
    opts.icon ?? null,
    JSON.stringify(doc),
    toPlainText(doc),
    next.n,
  );

  indexSearchDoc(db, {
    kind: 'page',
    pageId: id,
    title: opts.title ?? '',
    body: toPlainText(doc),
  });

  // A page that other notes already linked to by this title now resolves.
  if (opts.title) {
    db.prepare('UPDATE links SET target_page_id = ? WHERE target_title = ? AND target_page_id IS NULL')
      .run(id, opts.title);
  }
  return getPage(id)!;
}

/** Replace this page's outgoing wikilink edges, resolving targets where possible. */
function syncLinks(pageId: string, doc: JSONContent) {
  const db = getDb();
  db.prepare('DELETE FROM links WHERE source_page_id = ?').run(pageId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO links (source_page_id, target_title, target_page_id)
     VALUES (?, ?, (SELECT id FROM pages WHERE title = ? AND archived_at IS NULL LIMIT 1))`,
  );
  for (const title of extractWikiLinks(doc)) insert.run(pageId, title, title);
}

/** Replace the AI/manual tag set derived from inline #tags, keeping manual tags intact. */
function syncInlineTags(pageId: string, doc: JSONContent) {
  const db = getDb();
  const names = extractInlineTags(doc);
  db.prepare(`DELETE FROM page_tags WHERE page_id = ? AND source = 'inline'`).run(pageId);
  for (const name of names) {
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number };
    db.prepare(`INSERT OR IGNORE INTO page_tags (page_id, tag_id, source) VALUES (?, ?, 'inline')`)
      .run(pageId, tag.id);
  }
}

export function updatePage(
  id: string,
  patch: { title?: string; icon?: string | null; doc?: JSONContent; parentId?: string | null; isFavorite?: boolean },
): PageRow | undefined {
  const db = getDb();
  const current = getPage(id);
  if (!current) return undefined;

  const doc = patch.doc ?? (JSON.parse(current.doc_json) as JSONContent);
  // An untitled page takes its name from its first line, the way Notion does.
  const explicitTitle = patch.title !== undefined ? patch.title : current.title;
  const title = explicitTitle.trim() ? explicitTitle : firstLine(doc);
  const plain = toPlainText(doc);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pages
          SET title = ?, icon = ?, doc_json = ?, plain_text = ?, parent_id = ?,
              is_favorite = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      title,
      patch.icon !== undefined ? patch.icon : current.icon,
      JSON.stringify(doc),
      plain,
      patch.parentId !== undefined ? patch.parentId : current.parent_id,
      patch.isFavorite !== undefined ? (patch.isFavorite ? 1 : 0) : current.is_favorite,
      id,
    );

    if (title !== current.title) {
      // Links pointing at the old title go dangling; links to the new title resolve.
      db.prepare('UPDATE links SET target_page_id = NULL WHERE target_page_id = ? AND target_title = ?')
        .run(id, current.title);
      db.prepare('UPDATE links SET target_page_id = ? WHERE target_title = ? AND target_page_id IS NULL')
        .run(id, title);
    }
    syncLinks(id, doc);
    syncInlineTags(id, doc);
    indexSearchDoc(db, { kind: 'page', pageId: id, title, body: plain });
  });
  tx();
  return getPage(id);
}

export function deletePage(id: string) {
  const db = getDb();
  const tx = db.transaction(() => {
    // search_docs has ON DELETE CASCADE, but fts_docs is contentless and has no
    // foreign keys, so its rows must be removed explicitly first.
    removeSearchDoc(db, { kind: 'page', pageId: id });
    db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  });
  tx();
}

export type Backlink = { id: string; title: string; icon: string | null; snippet: string };

export function getBacklinks(pageId: string): Backlink[] {
  const db = getDb();
  const page = getPage(pageId);
  if (!page) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.icon, p.plain_text
         FROM links l JOIN pages p ON p.id = l.source_page_id
        WHERE l.target_page_id = ? AND p.archived_at IS NULL
        ORDER BY p.updated_at DESC`,
    )
    .all(pageId) as { id: string; title: string; icon: string | null; plain_text: string }[];

  return rows.map((r) => {
    const needle = `[[${page.title}]]`;
    const at = r.plain_text.indexOf(page.title);
    const start = Math.max(0, at - 60);
    return {
      id: r.id,
      title: r.title,
      icon: r.icon,
      snippet: at >= 0
        ? `${start > 0 ? '…' : ''}${r.plain_text.slice(start, at + needle.length + 60)}…`
        : r.plain_text.slice(0, 120),
    };
  });
}

/** Links written in this page that point at a title no page has yet. */
export function getUnresolvedLinks(pageId: string): string[] {
  return (
    getDb()
      .prepare('SELECT target_title FROM links WHERE source_page_id = ? AND target_page_id IS NULL')
      .all(pageId) as { target_title: string }[]
  ).map((r) => r.target_title);
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
