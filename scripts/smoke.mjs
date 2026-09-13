#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Runs against a server the caller already started:
 *   EVERNOTION_DATA_DIR=.tmp/smoke npm run build && npx next start -p 3210
 *   node scripts/smoke.mjs http://127.0.0.1:3210
 *
 * Also works against a deployed instance, which is the quickest way to confirm
 * a Railway deploy is actually sound rather than merely responding:
 *   EVERNOTION_PASSWORD=… node scripts/smoke.mjs https://your-app.up.railway.app
 * Note that it writes notes and uploads PDFs, so point it at a scratch
 * deployment rather than one holding real notes.
 *
 * It exercises the paths that are easy to break and hard to notice:
 * Japanese search (including the 2-character case), PDF text extraction,
 * OCR of a scanned page, wikilinks and backlinks, and the promise that the
 * app still works with no Claude API key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3210';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Session cookie, set once if the target turns out to be password-protected. */
let cookie = null;

const authHeaders = (extra = {}) => (cookie ? { ...extra, Cookie: cookie } : extra);

const get = async (p) => {
  const res = await fetch(BASE + p, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
};
const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const patch = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${p} -> ${res.status}`);
  return res.json();
};

const rawStatus = async (p) => (await fetch(BASE + p, { redirect: 'manual' })).status;
const rawStatusWithCookie = async (p) =>
  (await fetch(BASE + p, { headers: authHeaders(), redirect: 'manual' })).status;

const searchHits = async (q, extra = '') =>
  (await get(`/api/search?q=${encodeURIComponent(q)}${extra}`)).hits;

const flatten = (hit) => hit.snippet.map((r) => r.text).join('');

async function main() {
  console.log(`smoke test against ${BASE}\n`);

  // --- health -------------------------------------------------------------
  console.log('health');
  const health = await get('/api/health');
  check('server is up and migrated', health.ok === true);

  // --- access control -----------------------------------------------------
  // The gate only exists when EVERNOTION_PASSWORD is set, which is how a
  // deployed instance should be configured and a local one need not be.
  if (health.protected) {
    console.log('\naccess control');
    const password = process.env.EVERNOTION_PASSWORD;

    check('protected instances do not report their contents',
      health.pages === undefined && health.searchDocs === undefined);
    check('notes are not readable without a session', (await rawStatus('/api/pages')) === 401);
    check('uploaded files are not readable without a session',
      (await rawStatus('/api/attachments/probe/file')) === 401);
    check('the app redirects to the login page', (await rawStatus('/')) === 307);
    check('the login page itself is reachable', (await rawStatus('/login')) === 200);

    const wrong = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'definitely-not-the-password' }),
    });
    check('a wrong password is rejected', wrong.status === 401);

    if (!password) {
      console.log('\n  この環境はパスワード保護されています。');
      console.log('  EVERNOTION_PASSWORD=… を付けて再実行すると残りも検証します。');
      console.log(`\n${passed} passed, ${failures.length} failed`);
      process.exit(failures.length ? 1 : 0);
    }

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0];
    check('the correct password is accepted', login.status === 200);
    check('a session cookie is issued', cookie.startsWith('ev_session='));
    check('the session cookie is HttpOnly', /httponly/i.test(setCookie));
    check('a tampered session is rejected',
      (await fetch(`${BASE}/api/pages`, { headers: { Cookie: 'ev_session=9999999999999.bad' } })).status === 401);
    check('a valid session unlocks the app', (await rawStatusWithCookie('/api/pages')) === 200);
  } else {
    console.log('\naccess control');
    check('an unprotected instance says so plainly', health.protected === false);
  }

  // --- first run ----------------------------------------------------------
  console.log('\nfirst-run setup');
  const setup = await get('/api/setup/status');
  check('startup reports its state', ['starting', 'downloading', 'ready', 'error'].includes(setup.phase),
    setup.phase);

  const tree = (await get('/api/pages')).tree;
  check('an empty database is seeded with welcome notes',
    tree.some((n) => n.title === 'はじめに'),
    tree.map((n) => n.title).join(', '));
  const welcome = tree.find((n) => n.title === 'はじめに');
  check('the welcome note has child notes', (welcome?.children.length ?? 0) >= 2);

  if (welcome) {
    const detail = await get(`/api/pages/${welcome.id}`);
    // The welcome note shows [[…]] and #… as syntax examples inside code spans.
    // Treating those as real markup would invent a page and a tag on first run.
    check('syntax examples in code spans do not create links',
      !detail.unresolved.includes('ノート名'), detail.unresolved.join(', '));
    check('the welcome note still links to its children',
      detail.page.doc && JSON.stringify(detail.page.doc).includes('wikiLink'));
  }

  const seededTags = (await get('/api/tags')).tags.map((t) => t.name);
  check('syntax examples in code spans do not create tags',
    !seededTags.includes('タグ'), seededTags.join(', '));

  const seededGraph = await get('/api/graph');
  const ghostTitles = seededGraph.nodes.filter((n) => n.ghost).map((n) => n.title);
  // Not "no ghosts at all": a real database legitimately has dangling links,
  // and this suite creates one itself further down. The bug being guarded
  // against is the welcome note's own syntax example becoming a page.
  check('the welcome note does not invent a page from its syntax example',
    !ghostTitles.includes('ノート名'), ghostTitles.join(', '));

  // --- notes, wikilinks, backlinks ---------------------------------------
  console.log('\nnotes and links');
  const { body: created } = await post('/api/pages', { title: '取締役会メモ' });
  const noteId = created.page.id;
  const { body: target } = await post('/api/pages', { title: '新規事業計画' });
  const targetId = target.page.id;

  await patch(`/api/pages/${noteId}`, {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '本日の取締役会で ' },
            { type: 'wikiLink', attrs: { title: '新規事業計画', pageId: targetId } },
            { type: 'text', text: ' の予算案を承認した。ＴＯＫＹＯ本社にて。 #経営' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '詳細は ' },
            { type: 'wikiLink', attrs: { title: '来期予算', pageId: null } },
            { type: 'text', text: ' を参照。契約条件は別途協議する。' },
          ],
        },
      ],
    },
  });

  const targetDetail = await get(`/api/pages/${targetId}`);
  check(
    'a wikilink creates a backlink on its target',
    targetDetail.backlinks.some((b) => b.id === noteId),
    targetDetail.backlinks.map((b) => `${b.title}(${b.id})`).join(', '),
  );

  const noteDetail = await get(`/api/pages/${noteId}`);
  check(
    'a link to a page that does not exist is kept as unresolved',
    noteDetail.unresolved.includes('来期予算'),
  );

  const graph = await get('/api/graph');
  check('the graph includes an unresolved link as a ghost node',
    graph.nodes.some((n) => n.ghost && n.title === '来期予算'));
  check('the graph has edges', graph.links.length >= 2, `links=${graph.links.length}`);

  const tags = await get('/api/tags');
  check('an inline #tag is indexed', tags.tags.some((t) => t.name === '経営'));

  // --- trash --------------------------------------------------------------
  // Deleting is the one destructive action in the app, and it takes a subtree
  // with it, so it has to be reversible.
  console.log('\ntrash');
  const { body: parent } = await post('/api/pages', { title: 'ゴミ箱テスト親' });
  const { body: child } = await post('/api/pages', {
    title: 'ゴミ箱テスト子', parentId: parent.page.id,
  });
  await patch(`/api/pages/${child.page.id}`, {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '合言葉ヲリーブ' }] }] },
  });

  check('a note is searchable before deletion', (await searchHits('ヲリーブ')).length > 0);
  await post(`/api/pages/${parent.page.id}/archive`);
  check('deleting a page hides its descendants too', (await searchHits('ヲリーブ')).length === 0);
  check('a deleted page leaves the sidebar tree',
    !(await get('/api/pages')).tree.some((n) => n.id === parent.page.id));

  const archived = (await get('/api/pages/archived')).pages;
  check('the deleted page is in the trash', archived.some((p) => p.id === parent.page.id));
  check('the trash lists subtree roots, not every child',
    !archived.some((p) => p.id === child.page.id));

  await fetch(`${BASE}/api/pages/${parent.page.id}/archive`, {
    method: 'DELETE', headers: authHeaders(),
  });
  check('restoring brings the content back', (await searchHits('ヲリーブ')).length > 0);
  check('restoring brings the page back to the tree',
    (await get('/api/pages')).tree.some((n) => n.id === parent.page.id));

  // --- tags ---------------------------------------------------------------
  console.log('\ntags');
  await post(`/api/pages/${child.page.id}/tags`, { add: ['重要テスト'], source: 'ai' });
  check('a tag can be applied to a page',
    (await get(`/api/pages/${child.page.id}/tags`)).tags.some((t) => t.name === '重要テスト'));
  await post(`/api/pages/${child.page.id}/tags`, { remove: ['重要テスト'] });
  check('a tag can be removed again',
    !(await get(`/api/pages/${child.page.id}/tags`)).tags.some((t) => t.name === '重要テスト'));

  // --- Japanese search ----------------------------------------------------
  console.log('\nJapanese search');

  // The headline case: FTS5's trigram tokenizer cannot answer a 2-character
  // query at all, which is why the index is built from bigrams instead.
  for (const q of ['予算', '契約', '経営']) {
    const hits = await searchHits(q);
    check(`2-character query "${q}" finds the note`, hits.length > 0);
  }
  for (const q of ['取締役', '新規事業', '承認']) {
    const hits = await searchHits(q);
    check(`longer query "${q}" finds the note`, hits.length > 0);
  }

  const { body: rare } = await post('/api/pages', { title: '取引先メモ' });
  await patch(`/api/pages/${rare.page.id}`, {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\u{20BB7}野家と\u{2123D}屋に連絡' }] }] },
  });
  check('names using supplementary-plane kanji are searchable',
    (await searchHits('\u{20BB7}野家')).length > 0);

  const fullWidth = await searchHits('ＴＯＫＹＯ');
  const ascii = await searchHits('tokyo');
  check('full-width ＴＯＫＹＯ matches the ASCII text', fullWidth.length > 0);
  check('lowercase tokyo matches TOKYO', ascii.length > 0);

  const marked = (await searchHits('予算'))[0];
  check('results carry a highlighted snippet', marked.snippet.some((r) => r.mark));
  check('the highlighted run is the query itself',
    marked.snippet.filter((r) => r.mark).some((r) => r.text.includes('予算')));

  const missing = await searchHits('該当しない語句ZZZ');
  check('a query with no matches returns nothing', missing.length === 0);

  // Query syntax must never reach FTS5 unescaped.
  for (const q of ['"', 'AND OR NOT', '*', '予算" OR "']) {
    let ok = true;
    try {
      await searchHits(q);
    } catch (err) {
      ok = false;
      check(`query "${q}" is handled safely`, false, err.message);
    }
    if (ok) check(`query "${q}" is handled safely`, true);
  }

  const titleHits = await get(`/api/pages/search?q=${encodeURIComponent('新規')}`);
  check('wikilink autocomplete matches a partial Japanese title',
    titleHits.pages.some((p) => p.title === '新規事業計画'));

  // --- PDF ingest and in-PDF search --------------------------------------
  console.log('\nPDF ingest, OCR and in-PDF search');
  const fixtures = ['fixture-text.pdf', 'fixture-scan.pdf'];
  const missingFixture = fixtures.find((f) => !fs.existsSync(path.join(root, 'tests/fixtures', f)));
  if (missingFixture) {
    check('test fixtures exist', false, `run "npm run testpdfs" first (${missingFixture})`);
  } else {
    const ids = {};
    for (const name of fixtures) {
      const form = new FormData();
      const buf = fs.readFileSync(path.join(root, 'tests/fixtures', name));
      form.append('file', new Blob([buf], { type: 'application/pdf' }), name);
      form.append('pageId', noteId);
      const res = await fetch(`${BASE}/api/attachments`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) throw new Error(`upload ${name} -> ${res.status}`);
      const json = await res.json();
      ids[name] = json.attachment.id;
    }

    // OCR is slow; wait, but not forever.
    const deadline = Date.now() + 10 * 60 * 1000;
    const statuses = {};
    for (;;) {
      let settled = true;
      for (const [name, id] of Object.entries(ids)) {
        const { attachment } = await get(`/api/attachments/${id}`);
        statuses[name] = attachment;
        if (attachment.status !== 'ready' && attachment.status !== 'error') settled = false;
      }
      if (settled || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    check('a PDF with a text layer is ingested',
      statuses['fixture-text.pdf']?.status === 'ready',
      statuses['fixture-text.pdf']?.error ?? statuses['fixture-text.pdf']?.status);
    check('a text-layer PDF is not sent to OCR',
      statuses['fixture-text.pdf']?.status === 'ready' &&
        statuses['fixture-text.pdf']?.ocrPages === 0);
    check('a scanned PDF is ingested',
      statuses['fixture-scan.pdf']?.status === 'ready',
      statuses['fixture-scan.pdf']?.error ?? statuses['fixture-scan.pdf']?.status);
    check('a scanned PDF is sent to OCR',
      statuses['fixture-scan.pdf']?.ocrPages > 0);

    const textPages = await get(`/api/attachments/${ids['fixture-text.pdf']}/pages`);
    // The real guard against a missing pdf.js CMap config, which otherwise
    // yields empty text or mojibake with no error at all.
    check('Japanese text is extracted exactly from the text layer',
      textPages.pages[0]?.text.includes('甲と乙との間の新規事業に関する情報開示'),
      textPages.pages[0]?.text.slice(0, 60));
    check('every page of a multi-page PDF is extracted',
      textPages.pages.length === 2 && textPages.pages[1].text.includes('議事録'));
    check('text-layer pages are recorded as such',
      textPages.pages.length > 0 && textPages.pages.every((p) => p.source === 'text'));

    const scanPages = await get(`/api/attachments/${ids['fixture-scan.pdf']}/pages`);
    check('OCR pages are recorded as such',
      scanPages.pages.length > 0 && scanPages.pages[0]?.source === 'ocr');
    // OCR is never character-perfect, so assert on a distinctive substring.
    check('OCR reads Japanese from a scanned page',
      scanPages.pages[0]?.text.includes('秘密保持契約書'),
      scanPages.pages[0]?.text.slice(0, 60));

    const pdfHits = await searchHits('目的外使用', '&kind=pdf');
    check('text inside a PDF is searchable', pdfHits.length > 0);
    // Scope to this run's upload: an earlier run may have left same-named
    // attachments in the database, and they would rank alongside it.
    const ownHit = pdfHits.find((h) => h.attachmentId === ids['fixture-text.pdf']);
    check('a PDF hit points at the page it was found on',
      ownHit?.pdfPageNo >= 1 && !!ownHit?.attachmentId);
    // A pdf search row stores no page of its own, so this has to be resolved
    // through the attachment — otherwise clicking the result goes nowhere.
    check('a PDF hit carries the note it was uploaded into',
      ownHit?.pageId === noteId, `got ${ownHit?.pageId}`);

    const scanHits = (await searchHits('秘密保持', '&kind=pdf')).filter(
      (h) => h.attachmentId === ids['fixture-scan.pdf'],
    );
    check('OCR text from a scanned PDF is searchable', scanHits.length > 0);

    const page2Hits = (await searchHits('上方修正', '&kind=pdf'))
      .filter((h) => h.attachmentId === ids['fixture-text.pdf']);
    check('a match on page 2 reports page 2', page2Hits[0]?.pdfPageNo === 2,
      `got page ${page2Hits[0]?.pdfPageNo}`);
    check('PDF snippets are highlighted', page2Hits[0]?.snippet.some((r) => r.mark));

    const fileRes = await fetch(`${BASE}/api/attachments/${ids['fixture-text.pdf']}/file`, {
      headers: authHeaders({ Range: 'bytes=0-99' }),
    });
    check('the PDF file is served with range support', fileRes.status === 206);
  }

  // --- semantic search ----------------------------------------------------
  console.log('\nsemantic search');
  const semantic = await get(`/api/search/semantic?q=${encodeURIComponent('予算はいつ承認された')}`);
  check('semantic search answers without an API key', Array.isArray(semantic.hits));
  if (!semantic.unavailable && semantic.hits.length > 0) {
    check('semantic hits carry somewhere to navigate to',
      semantic.hits.every((h) => h.pageId || h.attachmentId));
    check('semantic hits are ranked', semantic.hits[0].score >= (semantic.hits.at(-1)?.score ?? 0));
  } else {
    console.log('  (embedding model not ready yet; ranking not asserted)');
  }

  // --- AI, with and without a key ----------------------------------------
  console.log('\nAI layer');
  const status = await get('/api/ai/status');
  check('AI status reports whether a key is configured', typeof status.aiEnabled === 'boolean');

  if (!status.aiEnabled) {
    const chat = await post('/api/ai/chat', { message: 'テスト' });
    check('chat reports a missing key instead of failing', chat.status === 503);
    check('the missing-key error is identifiable', chat.body.code === 'NO_API_KEY');
    const tag = await post('/api/ai/tags', { pageId: noteId });
    check('auto-tagging reports a missing key', tag.status === 503);
    check('search still works with no API key', (await searchHits('予算')).length > 0);
    check('the graph still works with no API key', (await get('/api/graph')).nodes.length > 0);
  } else {
    console.log('  (a key is configured; skipping the no-key contract)');
  }

  // Embeddings run locally, so related-notes works with no key — but the model
  // may still be downloading, so only assert that the route stays healthy.
  const related = await get(`/api/ai/related?pageId=${noteId}`);
  check('related-notes responds without an API key', Array.isArray(related.related));

  // --- report -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nすべて成功しました。');
}

await main();
