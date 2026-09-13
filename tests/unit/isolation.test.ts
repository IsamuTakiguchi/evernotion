/**
 * Cross-account isolation.
 *
 * Notes are private per account and there is no row-level security underneath
 * to catch a mistake, so this file exists to make a missing WHERE clause fail
 * loudly here rather than quietly in production. Every test is written from the
 * attacker's side: user B already knows user A's page id, attachment id, note
 * title and tag name, and tries to use them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The database location is read when the connection is first opened, so it has
// to be set before anything imports the client.
process.env.EVERNOTION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evernotion-iso-'));
delete process.env.EVERNOTION_SECRET;
process.env.EVERNOTION_RESOLVED_SECRET = 'isolation-test-secret';

const { getDb } = await import('@/lib/db/client');
const q = await import('@/lib/db/queries');
type PageTreeNode = Awaited<ReturnType<typeof q.listPageTree>>[number];
const { search, searchPageTitles } = await import('@/lib/search/search');
const { rebuildIndex } = await import('@/lib/search/index');
const { upsertUser, claimUnownedRows, countUsers } = await import('@/lib/auth/users');
const { relatedPages } = await import('@/lib/ai/rag');

const db = getDb();

const alice = upsertUser({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' });
const bob = upsertUser({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });

// ---- Alice's world ------------------------------------------------------
const aliceSecret = q.createPage(alice.id, {
  title: '給与改定の件',
  doc: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '来期の予算と機械学習の投資について。' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '#極秘' }] },
    ],
  },
});
q.updatePage(alice.id, aliceSecret.id, {});
q.setPageTags(alice.id, aliceSecret.id, { add: ['アリスのタグ'] });

const aliceChild = q.createPage(alice.id, { title: 'アリスの子', parentId: aliceSecret.id });

// A dangling link of Alice's, to a title Bob is about to use.
const aliceDangling = q.createPage(alice.id, {
  title: 'アリスのハブ',
  doc: {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: '[[共通の名前]] を参照' }],
    }],
  },
});
q.updatePage(alice.id, aliceDangling.id, {
  doc: {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: '[[共通の名前]] を参照' }],
    }],
  },
});

// An uploaded PDF of Alice's, with searchable text.
db.prepare(
  `INSERT INTO attachments (id, owner_id, page_id, filename, mime, size, storage_path, status)
   VALUES ('att_alice', ?, ?, '給与テーブル.pdf', 'application/pdf', 10, '/tmp/x.pdf', 'ready')`,
).run(alice.id, aliceSecret.id);
db.prepare(
  `INSERT INTO pdf_pages (attachment_id, page_no, text) VALUES ('att_alice', 1, ?)`,
).run('役員報酬の改定案。機械学習チームの予算も含む。');
rebuildIndex(alice.id);

// ---- Bob's world --------------------------------------------------------
const bobPage = q.createPage(bob.id, {
  title: 'ボブのノート',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '機械学習の話' }] }] },
});
q.updatePage(bob.id, bobPage.id, {});
rebuildIndex(bob.id);

// =========================================================================

test('B cannot read A’s page by id', () => {
  assert.equal(q.getPage(bob.id, aliceSecret.id), undefined);
  assert.ok(q.getPage(alice.id, aliceSecret.id));
});

test('B’s sidebar contains none of A’s notes', () => {
  const ids = new Set<string>();
  const walk = (nodes: PageTreeNode[]) => {
    for (const n of nodes) { ids.add(n.id); walk(n.children); }
  };
  walk(q.listPageTree(bob.id));
  assert.equal(ids.has(aliceSecret.id), false);
  assert.equal(ids.has(aliceChild.id), false);
  assert.equal(ids.has(bobPage.id), true);
});

test('B cannot find A’s note by title', () => {
  assert.equal(q.findPageByTitle(bob.id, '給与改定の件'), undefined);
});

test('B cannot edit A’s page', () => {
  assert.equal(q.updatePage(bob.id, aliceSecret.id, { title: '乗っ取り' }), undefined);
  assert.equal(q.getPage(alice.id, aliceSecret.id)!.title, '給与改定の件');
});

test('B cannot trash, restore or delete A’s page', () => {
  assert.equal(q.archivePage(bob.id, aliceSecret.id), 0);
  assert.equal(q.getPage(alice.id, aliceSecret.id)!.archived_at, null);

  q.deletePage(bob.id, aliceSecret.id);
  assert.ok(q.getPage(alice.id, aliceSecret.id), 'A’s page survived B’s delete');

  assert.equal(q.restorePage(bob.id, aliceSecret.id), 0);
});

test('B’s trash does not show A’s trashed notes', () => {
  const throwaway = q.createPage(alice.id, { title: 'アリスのゴミ' });
  q.archivePage(alice.id, throwaway.id);
  assert.equal(q.listArchived(bob.id).some((p) => p.id === throwaway.id), false);
  assert.equal(q.listArchived(alice.id).some((p) => p.id === throwaway.id), true);
});

test('B cannot tag A’s page, and cannot read its tags', () => {
  assert.deepEqual(q.setPageTags(bob.id, aliceSecret.id, { add: ['ボブ'] }), []);
  assert.deepEqual(q.getPageTags(bob.id, aliceSecret.id), []);
  assert.ok(q.getPageTags(alice.id, aliceSecret.id).some((t) => t.name === 'アリスのタグ'));
});

test('B’s tag list does not leak A’s tag names', () => {
  const names = q.listTags(bob.id).map((t) => t.name);
  assert.equal(names.includes('アリスのタグ'), false);
  assert.equal(names.includes('極秘'), false);
});

test('B cannot nest a new page under A’s page', () => {
  const page = q.createPage(bob.id, { title: '潜り込み', parentId: aliceSecret.id });
  assert.equal(page.parent_id, null, 'must fall back to the top level, not A’s tree');
  const child = q.listPageTree(alice.id).flatMap(function flat(n): PageTreeNode[] {
    return [n, ...n.children.flatMap(flat)];
  });
  assert.equal(child.some((n) => n.id === page.id), false);
});

test('B cannot reparent their page under A’s page', () => {
  const moved = q.updatePage(bob.id, bobPage.id, { parentId: aliceSecret.id });
  assert.equal(moved!.parent_id, null);
});

// ---- search -------------------------------------------------------------

test('B’s search does not return A’s notes', () => {
  const hits = search(bob.id, '給与');
  assert.deepEqual(hits, []);
  assert.ok(search(alice.id, '給与').length > 0, 'A can still find their own');
});

test('a term both accounts use returns only your own notes', () => {
  const hits = search(bob.id, '機械学習');
  assert.ok(hits.length > 0, 'B finds their own note');
  assert.equal(hits.every((h) => h.pageId === bobPage.id), true);
});

test('B’s search does not reach inside A’s PDF', () => {
  assert.deepEqual(search(bob.id, '役員報酬'), []);
  assert.ok(search(alice.id, '役員報酬').length > 0);
});

test('B’s wikilink autocomplete does not offer A’s titles', () => {
  assert.equal(searchPageTitles(bob.id, '給与').length, 0);
  // Nor the no-query "recent notes" listing.
  assert.equal(searchPageTitles(bob.id, '').some((p) => p.id === aliceSecret.id), false);
});

// ---- links --------------------------------------------------------------

test('naming a page the same as A’s dangling link does not connect them', () => {
  const bobCommon = q.createPage(bob.id, { title: '共通の名前' });

  // Alice's link must still be unresolved, and must not point at Bob's page.
  const link = db
    .prepare('SELECT target_page_id FROM links WHERE source_page_id = ? AND target_title = ?')
    .get(aliceDangling.id, '共通の名前') as { target_page_id: string | null };
  assert.equal(link.target_page_id, null, 'A’s link was silently attached to B’s page');

  assert.deepEqual(q.getBacklinks(bob.id, bobCommon.id), []);
  assert.deepEqual(q.getUnresolvedLinks(bob.id, aliceDangling.id), []);
});

test('a wikilink resolves within your own account', () => {
  const target = q.createPage(alice.id, { title: 'アリス限定' });
  const source = q.createPage(bob.id, { title: 'ボブのリンク元' });
  q.updatePage(bob.id, source.id, {
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '[[アリス限定]]' }] }],
    },
  });

  const link = db
    .prepare('SELECT target_page_id FROM links WHERE source_page_id = ?')
    .get(source.id) as { target_page_id: string | null };
  assert.equal(link.target_page_id, null, 'B’s wikilink resolved to A’s page');
  assert.deepEqual(q.getBacklinks(alice.id, target.id), []);
});

// ---- embeddings ---------------------------------------------------------

test('related notes are drawn only from your own account', () => {
  // Identical vectors, so similarity cannot be the reason one is excluded.
  const vector = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  const insert = db.prepare(
    `INSERT INTO chunks (kind, owner_id, page_id, ord, text, hash, embedding)
     VALUES ('page', ?, ?, 0, ?, ?, ?)`,
  );
  insert.run(alice.id, aliceSecret.id, '給与の話', 'h1', vector);
  insert.run(alice.id, aliceChild.id, 'アリスの子の話', 'h2', vector);
  insert.run(bob.id, bobPage.id, 'ボブの話', 'h3', vector);

  return relatedPages(bob.id, bobPage.id, 10).then((related) => {
    assert.equal(related.some((r) => r.id === aliceSecret.id), false);
    assert.equal(related.some((r) => r.id === aliceChild.id), false);
  });
});

// ---- accounts -----------------------------------------------------------

test('a returning user is matched on their Google subject, not their address', () => {
  // Alice changes her address at Google; she must keep her own notes.
  const again = upsertUser({ sub: 'sub-alice', email: 'alice.new@example.com', name: 'Alice' });
  assert.equal(again.id, alice.id);
  assert.equal(again.email, 'alice.new@example.com');
  assert.ok(q.getPage(alice.id, aliceSecret.id));
});

test('somebody inheriting an old address does not inherit the notes', () => {
  const stranger = upsertUser({ sub: 'sub-stranger', email: 'alice@example.com' });
  assert.notEqual(stranger.id, alice.id);
  assert.equal(q.getPage(stranger.id, aliceSecret.id), undefined);
});

test('pre-accounts rows are claimed once, by the first user only', () => {
  db.prepare(
    `INSERT INTO pages (id, owner_id, title, plain_text) VALUES ('legacy1', NULL, '古いノート', '本文')`,
  ).run();

  // There are already users, so a later claim is the caller's explicit choice;
  // what must never happen is a *second* account claiming them automatically.
  assert.ok(countUsers() > 1);
  const late = upsertUser({ sub: 'sub-late', email: 'late@example.com' });
  const legacy = db.prepare('SELECT owner_id FROM pages WHERE id = ?').get('legacy1') as {
    owner_id: string | null;
  };
  assert.equal(legacy.owner_id, null, 'a later account must not adopt unowned rows');
  assert.equal(q.getPage(late.id, 'legacy1'), undefined);

  // And an unowned row is invisible to everyone until it is claimed.
  assert.equal(q.getPage(alice.id, 'legacy1'), undefined);
  assert.equal(claimUnownedRows(alice.id), 1);
  assert.ok(q.getPage(alice.id, 'legacy1'));
});

// ---- the statements themselves -----------------------------------------

/**
 * A source scan over every SQL statement in the app.
 *
 * The tests above prove the paths they exercise. This one covers the paths
 * nobody thought to test: it fails when a *new* statement reads or writes an
 * owned table without saying whose row it wants. It is how the two tag pages
 * — which listed every account's tag names, note titles and excerpts — were
 * found, long after the code above was already passing.
 *
 * Every exception below is a statement that is scoped by its caller instead,
 * and each one has to say why. Adding an entry should feel like a decision.
 */
const OWNED_TABLES = ['pages', 'attachments', 'chunks', 'search_docs', 'pdf_pages'];

const SCOPED_BY_THEIR_CALLER = new Map<string, string>([
  // queries.ts — every id here comes from subtreeIds(), which is owner-scoped,
  // so the owner has already been checked one frame up.
  ["UPDATE pages SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id IN (${placeholders}) AND archived_at IS NULL",
    'ids come from the owner-scoped subtreeIds()'],
  ["UPDATE pages SET archived_at = NULL, updated_at = datetime('now') WHERE id IN (${placeholders})",
    'ids come from the owner-scoped subtreeIds()'],
  ['UPDATE pages SET parent_id = NULL WHERE id = ? AND parent_id IS NOT NULL AND parent_id IN (SELECT id FROM pages WHERE archived_at IS NOT NULL)',
    'id comes from the owner-scoped subtreeIds()'],
  ['SELECT title FROM pages WHERE id = ?',
    'id comes from the owner-scoped subtreeIds()'],

  // search/index.ts — resolves the index row for a page or attachment whose
  // owner the caller established; the writes are then by rowid.
  ["SELECT rowid FROM search_docs WHERE kind = 'page' AND page_id = ?",
    'page ownership is checked by the caller; indexSearchDoc writes owner_id'],
  ["SELECT rowid FROM search_docs WHERE kind = 'pdf' AND attachment_id = ? AND pdf_page_no = ?",
    'attachment ownership is checked by the caller'],
  ["SELECT rowid FROM search_docs WHERE kind = 'pdf' AND attachment_id = ?",
    'attachment ownership is checked by the caller'],
  ['DELETE FROM search_docs WHERE rowid = ?', 'rowid came from the lookups above'],

  // ai/indexer.ts — keyed on a page or attachment the caller resolved, and the
  // owner is read from that row before any chunk is written.
  ['SELECT id, hash FROM chunks WHERE ${scope.sql}', 'scoped to one page or attachment'],
  ["DELETE FROM chunks WHERE id IN (${stale.map(() => '?').join(',')})",
    'ids came from the statement above'],
  ['SELECT page_no, text FROM pdf_pages WHERE attachment_id = ? ORDER BY page_no',
    'attachment ownership is checked by indexAttachment'],

  // pdf/ingest.ts and pdf/queue.ts — a background queue with no session. It
  // works on whatever is pending, and takes each row's owner from the row.
  ["INSERT INTO pdf_pages (attachment_id, page_no, text, source) VALUES (?, ?, ?, ?) ON CONFLICT(attachment_id, page_no) DO UPDATE SET text = excluded.text, source = excluded.source",
    'background ingest; the search row it feeds carries the attachment’s owner'],
  ['UPDATE attachments SET ${keys.map((k) =>', 'background ingest progress, keyed by attachment id'],
  ["SELECT id, storage_path, filename FROM attachments WHERE status IN ('pending', 'extracting', 'ocr')",
    'resumes every interrupted ingest at startup, for all accounts by design'],

  // health — counts only, and only returned at all when the instance is open,
  // which means a single local user.
  ['SELECT COUNT(*) AS n FROM pages', 'health counts, returned only in open (single-user) mode'],
  ['SELECT COUNT(*) AS n FROM search_docs', 'health counts, returned only in open (single-user) mode'],
]);

function sqlStatements(): { file: string; line: number; sql: string }[] {
  const found: { file: string; line: number; sql: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/\.prepare\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
          found.push({
            file: full,
            line: src.slice(0, m.index).split('\n').length,
            sql: m[1].slice(1, -1).replace(/\s+/g, ' ').trim(),
          });
        }
      }
    }
  };
  walk('lib');
  walk('app');
  return found;
}

test('every SQL statement against an owned table is scoped to an owner', () => {
  const touchesOwned = new RegExp(
    `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:${OWNED_TABLES.join('|')})\\b`,
    'i',
  );

  const statements = sqlStatements();
  assert.ok(statements.length > 40, `expected to find the app's SQL, found ${statements.length}`);

  const unscoped = statements
    .filter((s) => touchesOwned.test(s.sql))
    .filter((s) => !/owner_id/.test(s.sql))
    .filter((s) => !SCOPED_BY_THEIR_CALLER.has(s.sql))
    .map((s) => `${s.file}:${s.line}\n      ${s.sql.slice(0, 160)}`);

  assert.deepEqual(
    unscoped,
    [],
    `these statements read or write an owned table without an owner.\n` +
      `Add the owner, or justify the statement in SCOPED_BY_THEIR_CALLER:\n\n    ` +
      unscoped.join('\n\n    '),
  );
});

test('the list of justified exceptions has not gone stale', () => {
  // An entry left behind after its statement was rewritten stops protecting
  // anything, and quietly makes the next statement that happens to match it
  // exempt. Both halves have to be kept honest.
  const present = new Set(sqlStatements().map((s) => s.sql));
  const stale = [...SCOPED_BY_THEIR_CALLER.keys()].filter((sql) => !present.has(sql));
  assert.deepEqual(stale, [], `no statement matches these exceptions any more: ${stale.join(' | ')}`);
});
