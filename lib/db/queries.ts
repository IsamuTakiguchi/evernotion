import { nanoid } from 'nanoid';
import { getDb } from './client';
import {
  EMPTY_DOC, extractInlineTags, extractWikiLinks, firstLine, toPlainText,
  type JSONContent,
} from '../editor/doc';
import { indexSearchDoc, removeSearchDoc } from '../search/index';

/**
 * Every function here takes the owner as its first argument, and no function
 * reads or writes a page, attachment or search row without one.
 *
 * That is the whole isolation model. Notes are private per account, and there
 * is no database-level row security to fall back on, so a single missing WHERE
 * clause is the difference between an app and a data breach. Making the owner
 * the first parameter of every call means a caller has to have answered "whose
 * data is this?" before it can ask anything at all — a forgotten filter becomes
 * a type error rather than somebody else's notes on your screen.
 *
 * tests/unit/isolation.test.ts scans this file and fails on any statement
 * against an owned table that is not scoped.
 */

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

export function listPageTree(ownerId: string): PageTreeNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, icon, is_favorite, updated_at
         FROM pages WHERE owner_id = ? AND archived_at IS NULL
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(ownerId) as Pick<PageRow, 'id' | 'parent_id' | 'title' | 'icon' | 'is_favorite' | 'updated_at'>[];

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

/**
 * A page, but only if it belongs to this owner.
 *
 * Returning undefined for somebody else's page rather than throwing is
 * deliberate: a 404 and "not yours" are the same answer to the caller, and
 * distinguishing them would confirm that the id exists.
 */
export function getPage(ownerId: string, id: string): PageRow | undefined {
  return getDb()
    .prepare('SELECT * FROM pages WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as PageRow | undefined;
}

export function findPageByTitle(ownerId: string, title: string): PageRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM pages WHERE owner_id = ? AND title = ? AND archived_at IS NULL LIMIT 1',
    )
    .get(ownerId, title) as PageRow | undefined;
}

export function createPage(ownerId: string, opts: {
  title?: string;
  parentId?: string | null;
  icon?: string | null;
  doc?: JSONContent;
} = {}): PageRow {
  const db = getDb();
  const id = nanoid(12);
  const doc = opts.doc ?? EMPTY_DOC;

  // A parent belonging to somebody else would graft this page into their tree.
  const parentId = opts.parentId && getPage(ownerId, opts.parentId) ? opts.parentId : null;

  const next = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n
         FROM pages WHERE owner_id = ? AND parent_id IS ?`,
    )
    .get(ownerId, parentId) as { n: number };

  db.prepare(
    `INSERT INTO pages (id, owner_id, parent_id, title, icon, doc_json, plain_text, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerId,
    parentId,
    opts.title ?? '',
    opts.icon ?? null,
    JSON.stringify(doc),
    toPlainText(doc),
    next.n,
  );

  indexSearchDoc(db, {
    ownerId,
    kind: 'page',
    pageId: id,
    title: opts.title ?? '',
    body: toPlainText(doc),
  });

  // A page that this owner's other notes already linked to by this title now
  // resolves. Scoped to their pages: without that, naming a note `会議` would
  // silently connect every other account's dangling `[[会議]]` to it.
  if (opts.title) resolveLinksToTitle(ownerId, id, opts.title);

  return getPage(ownerId, id)!;
}

/** Point this owner's dangling links at a page that now carries their title. */
function resolveLinksToTitle(ownerId: string, pageId: string, title: string) {
  getDb()
    .prepare(
      `UPDATE links SET target_page_id = ?
        WHERE target_title = ?
          AND target_page_id IS NULL
          AND source_page_id IN (SELECT id FROM pages WHERE owner_id = ?)`,
    )
    .run(pageId, title, ownerId);
}

/** Replace this page's outgoing wikilink edges, resolving targets where possible. */
function syncLinks(ownerId: string, pageId: string, doc: JSONContent) {
  const db = getDb();
  db.prepare('DELETE FROM links WHERE source_page_id = ?').run(pageId);

  // An id recorded on the link wins over the title, so two notes sharing a
  // name still link to the one the writer actually picked. The title lookup
  // remains the fallback for links typed by hand.
  //
  // Both lookups are restricted to this owner's pages. Titles are not unique
  // across accounts — `会議` is a name half the instance will use — so without
  // the restriction a wikilink would resolve to whichever account happened to
  // write that note first.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO links (source_page_id, target_title, target_page_id)
     VALUES (
       ?, ?,
       COALESCE(
         (SELECT id FROM pages WHERE id = ? AND owner_id = ? AND archived_at IS NULL),
         (SELECT id FROM pages WHERE title = ? AND owner_id = ? AND archived_at IS NULL LIMIT 1)
       )
     )`,
  );
  for (const ref of extractWikiLinks(doc)) {
    insert.run(pageId, ref.title, ref.pageId, ownerId, ref.title, ownerId);
  }
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
  ownerId: string,
  id: string,
  patch: { title?: string; icon?: string | null; doc?: JSONContent; parentId?: string | null; isFavorite?: boolean },
): PageRow | undefined {
  const db = getDb();
  const current = getPage(ownerId, id);
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
        WHERE id = ? AND owner_id = ?`,
    ).run(
      title,
      patch.icon !== undefined ? patch.icon : current.icon,
      JSON.stringify(doc),
      plain,
      // Reparenting under another account's page would move this note out of
      // its own tree, so an unknown parent falls back to the top level.
      patch.parentId !== undefined
        ? (patch.parentId && getPage(ownerId, patch.parentId) ? patch.parentId : null)
        : current.parent_id,
      patch.isFavorite !== undefined ? (patch.isFavorite ? 1 : 0) : current.is_favorite,
      id,
      ownerId,
    );

    if (title !== current.title) {
      // Links pointing at the old title go dangling; links to the new title resolve.
      db.prepare('UPDATE links SET target_page_id = NULL WHERE target_page_id = ? AND target_title = ?')
        .run(id, current.title);
      resolveLinksToTitle(ownerId, id, title);
    }
    syncLinks(ownerId, id, doc);
    syncInlineTags(id, doc);
    indexSearchDoc(db, { ownerId, kind: 'page', pageId: id, title, body: plain });
  });
  tx();
  return getPage(ownerId, id);
}

/** A page and every descendant, deepest last. */
function subtreeIds(ownerId: string, id: string): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM pages WHERE id = ? AND owner_id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN tree t ON p.parent_id = t.id
          WHERE p.owner_id = ?
       )
       SELECT id FROM tree`,
    )
    .all(id, ownerId, ownerId) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Move a page and its descendants to the trash.
 *
 * This is what the sidebar's delete button does. Notes are the thing this app
 * exists to keep, and a subtree can disappear with one misclick, so removal is
 * reversible by default and permanent only from the trash screen.
 *
 * Nothing is unindexed: every query that reads notes, search hits, backlinks
 * and the graph already filters on archived_at IS NULL, so restoring is just
 * clearing the column.
 */
export function archivePage(ownerId: string, id: string): number {
  const db = getDb();
  const ids = subtreeIds(ownerId, id);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE pages SET archived_at = datetime('now'), updated_at = datetime('now')
      WHERE id IN (${placeholders}) AND archived_at IS NULL`,
  ).run(...ids);
  return ids.length;
}

export function restorePage(ownerId: string, id: string): number {
  const db = getDb();
  const ids = subtreeIds(ownerId, id);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE pages SET archived_at = NULL, updated_at = datetime('now')
        WHERE id IN (${placeholders})`,
    ).run(...ids);

    // A page restored under an archived parent would be invisible in the tree,
    // so it comes back at the top level instead of vanishing.
    db.prepare(
      `UPDATE pages SET parent_id = NULL
        WHERE id = ?
          AND parent_id IS NOT NULL
          AND parent_id IN (SELECT id FROM pages WHERE archived_at IS NOT NULL)`,
    ).run(id);

    // Links to these titles can resolve again.
    for (const pageId of ids) {
      const page = db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId) as
        | { title: string }
        | undefined;
      if (page?.title) resolveLinksToTitle(ownerId, pageId, page.title);
    }
  });
  tx();
  return ids.length;
}

export type ArchivedPage = {
  id: string;
  title: string;
  icon: string | null;
  archivedAt: string;
  excerpt: string;
  descendants: number;
};

/** Trash contents: only the top of each archived subtree, not every child. */
export function listArchived(ownerId: string): ArchivedPage[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.title, p.icon, p.archived_at, substr(p.plain_text, 1, 140) AS excerpt
         FROM pages p
        WHERE p.owner_id = ?
          AND p.archived_at IS NOT NULL
          AND (p.parent_id IS NULL
               OR p.parent_id NOT IN (SELECT id FROM pages WHERE archived_at IS NOT NULL))
        ORDER BY p.archived_at DESC`,
    )
    .all(ownerId) as {
    id: string; title: string; icon: string | null; archived_at: string; excerpt: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    archivedAt: r.archived_at,
    excerpt: r.excerpt,
    descendants: subtreeIds(ownerId, r.id).length - 1,
  }));
}

/** Permanent removal, reachable only from the trash screen. */
export function deletePage(ownerId: string, id: string) {
  const db = getDb();
  const ids = subtreeIds(ownerId, id);
  if (ids.length === 0) return;
  const tx = db.transaction(() => {
    // search_docs has ON DELETE CASCADE, but fts_docs is contentless and has no
    // foreign keys, so its rows must be removed explicitly first — for every
    // page in the subtree, since the cascade would take them all.
    for (const pageId of ids) removeSearchDoc(db, { kind: 'page', pageId });
    db.prepare('DELETE FROM pages WHERE id = ? AND owner_id = ?').run(id, ownerId);
  });
  tx();
}

export type Backlink = { id: string; title: string; icon: string | null; snippet: string };

export function getBacklinks(ownerId: string, pageId: string): Backlink[] {
  const db = getDb();
  const page = getPage(ownerId, pageId);
  if (!page) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.icon, p.plain_text
         FROM links l JOIN pages p ON p.id = l.source_page_id
        WHERE l.target_page_id = ? AND p.owner_id = ? AND p.archived_at IS NULL
        ORDER BY p.updated_at DESC`,
    )
    .all(pageId, ownerId) as { id: string; title: string; icon: string | null; plain_text: string }[];

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
export function getUnresolvedLinks(ownerId: string, pageId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT l.target_title
           FROM links l JOIN pages p ON p.id = l.source_page_id
          WHERE l.source_page_id = ? AND p.owner_id = ? AND l.target_page_id IS NULL`,
      )
      .all(pageId, ownerId) as { target_title: string }[]
  ).map((r) => r.target_title);
}

export type PageTag = { name: string; source: string };

export function getPageTags(ownerId: string, pageId: string): PageTag[] {
  return getDb()
    .prepare(
      `SELECT t.name, pt.source FROM page_tags pt
         JOIN tags t ON t.id = pt.tag_id
         JOIN pages p ON p.id = pt.page_id
        WHERE pt.page_id = ? AND p.owner_id = ? ORDER BY t.name`,
    )
    .all(pageId, ownerId) as PageTag[];
}

/**
 * Every tag this owner actually uses, with how many live notes carry it.
 *
 * `tags` itself is a shared dictionary of names with no owner, so ownership is
 * "do you have a page carrying it" — which is what the join expresses. Reading
 * `tags` directly would list every other account's tag names.
 */
export function listTags(ownerId: string): { name: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT t.name, COUNT(*) AS count
         FROM page_tags pt
         JOIN tags t  ON t.id = pt.tag_id
         JOIN pages p ON p.id = pt.page_id
        WHERE p.owner_id = ? AND p.archived_at IS NULL
        GROUP BY t.id
        ORDER BY count DESC, t.name`,
    )
    .all(ownerId) as { name: string; count: number }[];
}

/**
 * Add or remove tags on a page.
 *
 * `source` records where a tag came from. Tags written as #hashtags in the body
 * are re-derived from the document on every save, so anything applied here is
 * recorded separately — otherwise accepting an AI suggestion would silently
 * vanish the next time the note was edited.
 */
export function setPageTags(
  ownerId: string,
  pageId: string,
  changes: { add?: string[]; remove?: string[]; source?: string },
): PageTag[] {
  const db = getDb();
  const source = changes.source ?? 'manual';
  if (!getPage(ownerId, pageId)) return [];

  const tx = db.transaction(() => {
    for (const raw of changes.add ?? []) {
      const name = raw.trim().replace(/^#/, '');
      if (!name) continue;
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number };
      db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag_id, source) VALUES (?, ?, ?)')
        .run(pageId, tag.id, source);
    }
    for (const raw of changes.remove ?? []) {
      const name = raw.trim().replace(/^#/, '');
      if (!name) continue;
      db.prepare(
        `DELETE FROM page_tags
          WHERE page_id = ?
            AND tag_id = (SELECT id FROM tags WHERE name = ?)
            -- An inline #tag is owned by the document; removing it here would
            -- just come back on the next save.
            AND source <> 'inline'`,
      ).run(pageId, name);
    }
  });
  tx();
  return getPageTags(ownerId, pageId);
}

/** Live notes of this owner carrying a tag, newest first. */
export function listPagesByTag(
  ownerId: string,
  name: string,
): { id: string; title: string; icon: string | null; excerpt: string }[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.title, p.icon, substr(p.plain_text, 1, 160) AS excerpt
         FROM pages p
         JOIN page_tags pt ON pt.page_id = p.id
         JOIN tags t ON t.id = pt.tag_id
        WHERE t.name = ? AND p.owner_id = ? AND p.archived_at IS NULL
        ORDER BY p.updated_at DESC`,
    )
    .all(name, ownerId) as
    { id: string; title: string; icon: string | null; excerpt: string }[];
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
