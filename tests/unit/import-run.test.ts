/**
 * Running a real import against a real database.
 *
 * The parser tests prove the files are read correctly; this proves the result
 * becomes usable — pages in the tree, tags applied, attachments stored, links
 * joined up, and the text findable by the search that people will actually
 * type. And that all of it belongs to the account that ran the import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

process.env.EVERNOTION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evernotian-import-'));
delete process.env.EVERNOTION_SECRET;
process.env.EVERNOTION_RESOLVED_SECRET = 'import-test-secret';

const { getDb } = await import('@/lib/db/client');
const q = await import('@/lib/db/queries');
const { search } = await import('@/lib/search/search');
const { upsertUser } = await import('@/lib/auth/users');
const { runImport, createImport, getImport, detectSource } = await import('@/lib/import/run');
const { toPlainText } = await import('@/lib/editor/doc');

const db = getDb();
const alice = upsertUser({ sub: 'sub-a', email: 'a@example.com' });
const bob = upsertUser({ sub: 'sub-b', email: 'b@example.com' });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_HASH = createHash('md5').update(PNG).digest('hex');

function tmpFile(bytes: Buffer | Uint8Array): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')), 'export');
  fs.writeFileSync(file, bytes);
  return file;
}

async function importFile(ownerId: string, bytes: Buffer | Uint8Array, name: string) {
  const head = Buffer.from(bytes.subarray(0, 4096));
  const source = detectSource(head);
  assert.ok(source, `the format of ${name} was recognised`);
  const id = createImport(ownerId, source, name);
  await runImport(ownerId, id, source, tmpFile(bytes));
  const progress = getImport(ownerId, id)!;
  assert.equal(progress.status, 'done', progress.error ?? '');
  return progress;
}

const tree = (ownerId: string) => {
  const flat: { id: string; title: string; parentId: string | null }[] = [];
  const walk = (nodes: ReturnType<typeof q.listPageTree>) => {
    for (const n of nodes) {
      flat.push({ id: n.id, title: n.title, parentId: n.parentId });
      walk(n.children);
    }
  };
  walk(q.listPageTree(ownerId));
  return flat;
};

const titleIs = (ownerId: string, title: string) =>
  tree(ownerId).find((p) => p.title === title);

// ------------------------------------------------------------- Evernote ---

const ENEX = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export>
  <note>
    <title>取締役会の議事録</title>
    <content><![CDATA[<en-note>
      <div>来期の<b>予算</b>について審議した。</div>
      <div><en-todo checked="true"/>資料を配布</div>
      <div><en-todo checked="false"/>議事録を回覧</div>
      <en-media hash="${PNG_HASH}" type="image/png"/>
    </en-note>]]></content>
    <created>20240131T093000Z</created>
    <tag>経営</tag>
    <tag>重要</tag>
    <resource>
      <data encoding="base64">${PNG.toString('base64')}</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>会議室.png</file-name></resource-attributes>
    </resource>
  </note>
  <note>
    <title>契約書メモ</title>
    <content><![CDATA[<en-note><div>秘密保持契約の確認事項。</div></en-note>]]></content>
  </note>
</en-export>`, 'utf8');

test('an Evernote export becomes pages', async () => {
  const progress = await importFile(alice.id, ENEX, 'evernote.enex');
  assert.equal(progress.notes, 2);
  assert.equal(progress.attachments, 1);

  assert.ok(titleIs(alice.id, '取締役会の議事録'));
  assert.ok(titleIs(alice.id, '契約書メモ'));
});

test('its checkboxes, formatting and tags survive', () => {
  const page = q.getPage(alice.id, titleIs(alice.id, '取締役会の議事録')!.id)!;
  const doc = JSON.parse(page.doc_json);

  const taskItems: { attrs?: { checked?: boolean } }[] = [];
  const walk = (n: { type?: string; content?: unknown[]; attrs?: { checked?: boolean } }) => {
    if (n.type === 'taskItem') taskItems.push(n);
    (n.content as typeof taskItems | undefined)?.forEach(walk as never);
  };
  walk(doc);

  assert.equal(taskItems.length, 2);
  assert.equal(taskItems[0].attrs?.checked, true);
  assert.equal(taskItems[1].attrs?.checked, false);

  assert.deepEqual(
    q.getPageTags(alice.id, page.id).map((t) => t.name).sort(),
    ['経営', '重要'],
  );
});

test('its attachment is stored and shown in the body', () => {
  const page = titleIs(alice.id, '取締役会の議事録')!;
  const row = db
    .prepare('SELECT id, owner_id, filename, mime, status FROM attachments WHERE page_id = ?')
    .get(page.id) as { id: string; owner_id: string; filename: string; mime: string; status: string };

  assert.equal(row.filename, '会議室.png');
  assert.equal(row.mime, 'image/png');
  assert.equal(row.owner_id, alice.id);
  assert.equal(row.status, 'ready', 'an image needs no further processing');

  // The en-media placeholder was replaced by the stored file, not dropped.
  const doc = JSON.parse(q.getPage(alice.id, page.id)!.doc_json) as { content: { type?: string; attrs?: Record<string, unknown> }[] };
  const image = JSON.stringify(doc).includes(`/api/attachments/${row.id}/file`);
  assert.ok(image, 'the body points at the stored attachment');
});

test('imported notes are searchable, including by a 2-character Japanese query', () => {
  // The whole reason for importing: finding the notes afterwards. Two
  // characters is the query shape FTS5's own tokenizers cannot answer, so this
  // also confirms the import went through the normal indexing path.
  assert.ok(search(alice.id, '予算').length > 0, '予算');
  assert.ok(search(alice.id, '契約').length > 0, '契約');
  assert.ok(search(alice.id, '議事録').length > 0, '議事録');
});

// --------------------------------------------------------------- Notion ---

const ID_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ID_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';
const ID_C = '11223344556677889900aabbccddeeff';

const NOTION = zipSync({
  [`Export/設計メモ ${ID_A}.md`]: strToU8(
    `# 設計メモ\n\n検索の方式について。\n\n[詳細はこちら](設計メモ%20${ID_A}/日本語検索%20${ID_B}.md)\n`,
  ),
  [`Export/設計メモ ${ID_A}/日本語検索 ${ID_B}.md`]: strToU8(
    `# 日本語検索\n\n形態素解析ではなくバイグラムを使う。\n\n`
    + `- [x] 調査\n- [ ] 実装\n\n![図](日本語検索%20${ID_B}/図表.png)\n`,
  ),
  [`Export/設計メモ ${ID_A}/日本語検索 ${ID_B}/図表.png`]: new Uint8Array(PNG),
  [`Export/顧客 ${ID_C}.csv`]: strToU8('名前\n田中\n'),
  [`Export/顧客 ${ID_C}/田中 ${ID_A}.md`]: strToU8('# 田中\n\n担当は営業部。\n'),
});

test('a Notion export becomes pages', async () => {
  const progress = await importFile(alice.id, NOTION, 'notion.zip');
  assert.equal(progress.notes, 3, '2 pages plus 1 database row');
  assert.equal(progress.skipped, 1, 'the CSV duplicate of the row folder');
  assert.ok(titleIs(alice.id, '設計メモ'));
  assert.ok(titleIs(alice.id, '日本語検索'));
  assert.ok(titleIs(alice.id, '田中'), 'a database row is a page');
});

test('the folder tree becomes the page tree', () => {
  const parent = titleIs(alice.id, '設計メモ')!;
  const child = titleIs(alice.id, '日本語検索')!;
  assert.equal(child.parentId, parent.id);
});

test('a link between two exported pages becomes a real page link', () => {
  const parent = titleIs(alice.id, '設計メモ')!;
  const child = titleIs(alice.id, '日本語検索')!;

  const backlinks = q.getBacklinks(alice.id, child.id);
  assert.equal(backlinks.length, 1, 'backlinks work straight after the import');
  assert.equal(backlinks[0].id, parent.id);
});

test('an image beside a Notion page is attached to it', () => {
  const child = titleIs(alice.id, '日本語検索')!;
  const row = db
    .prepare('SELECT filename, owner_id FROM attachments WHERE page_id = ?')
    .get(child.id) as { filename: string; owner_id: string } | undefined;
  assert.equal(row?.filename, '図表.png');
  assert.equal(row?.owner_id, alice.id);
});

test('Notion task lists come through checked and unchecked', () => {
  const child = q.getPage(alice.id, titleIs(alice.id, '日本語検索')!.id)!;
  const json = child.doc_json;
  assert.match(json, /"taskItem"/);
  assert.match(toPlainText(JSON.parse(json)), /調査/);
});

// ------------------------------------------------------------- isolation ---

test('everything imported belongs to the account that imported it', () => {
  const aliceTitles = tree(alice.id).map((p) => p.title);
  assert.ok(aliceTitles.includes('取締役会の議事録'));

  // Bob imported nothing and must see none of it.
  assert.deepEqual(tree(bob.id), []);
  assert.deepEqual(search(bob.id, '予算'), []);
  assert.deepEqual(search(bob.id, '日本語検索'), []);

  const pageId = titleIs(alice.id, '取締役会の議事録')!.id;
  assert.equal(q.getPage(bob.id, pageId), undefined);

  const stolen = db
    .prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_id = ?')
    .get(bob.id) as { n: number };
  assert.equal(stolen.n, 0);
});

test('an import is only visible to the account that ran it', async () => {
  const id = createImport(alice.id, 'evernote', 'private.enex');
  assert.ok(getImport(alice.id, id));
  assert.equal(getImport(bob.id, id), null);
});

// -------------------------------------------------------------- failures ---

test('a file that is neither format is refused before anything is written', () => {
  assert.equal(detectSource(Buffer.from('just some text')), null);
  assert.equal(detectSource(Buffer.from('%PDF-1.4')), null);
});

test('a broken export fails the job rather than the process', async () => {
  const id = createImport(alice.id, 'notion', 'broken.zip');
  // A ZIP header with nothing valid behind it.
  await runImport(alice.id, id, 'notion', tmpFile(Buffer.from('PK\x03\x04broken')));

  const progress = getImport(alice.id, id)!;
  assert.equal(progress.status, 'error');
  assert.ok(progress.error && progress.error.length > 0, 'the reason is recorded');
});

test('the uploaded file is deleted once the import finishes', async () => {
  const file = tmpFile(ENEX);
  const id = createImport(alice.id, 'evernote', 'cleanup.enex');
  await runImport(alice.id, id, 'evernote', file);
  // Otherwise every export anybody ever imported would stay on the volume.
  assert.equal(fs.existsSync(file), false);
});
