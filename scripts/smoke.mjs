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
 *   EVERNOTION_SESSION=… node scripts/smoke.mjs https://your-app.up.railway.app
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
  //
  // Sign-in is Google's, so this script cannot complete a login on its own.
  // What it can do — and what actually matters on a public URL — is prove the
  // gate is shut. To check the rest against a real deployment, sign in with a
  // browser, copy the ev_session cookie out of devtools and pass it as
  // EVERNOTION_SESSION.
  console.log('\naccess control');

  if (health.authMode === 'google' || health.authMode === 'locked') {
    check('a gated instance does not report its contents',
      health.pages === undefined && health.searchDocs === undefined);

    const gated = health.authMode === 'google' ? 401 : 503;
    check('notes are not readable without a session', (await rawStatus('/api/pages')) === gated);
    check('uploaded files are not readable without a session',
      (await rawStatus('/api/attachments/probe/file')) === gated);
    check('a forged session cookie is rejected',
      (await fetch(`${BASE}/api/pages`, { headers: { Cookie: 'ev_session=u_x:9999999999999.bad' } }))
        .status === gated);
    check('the login page itself is reachable', (await rawStatus('/login')) === 200);

    if (health.authMode === 'google') {
      check('the app redirects to the login page', (await rawStatus('/')) === 307);

      // The sign-in button must actually reach Google, with PKCE and the
      // account chooser. A misconfigured redirect_uri fails here rather than
      // as an error page a user has to interpret.
      const start = await fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' });
      const target = start.headers.get('location') ?? '';
      check('sign-in sends the browser to Google', start.status === 307 || start.status === 302);
      check('…at Google\'s authorization endpoint',
        target.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
      const params = target.includes('?') ? new URLSearchParams(target.split('?')[1]) : new URLSearchParams();
      check('…with PKCE', params.get('code_challenge_method') === 'S256' && !!params.get('code_challenge'));
      check('…asking for the account chooser', params.get('prompt') === 'select_account');
      check('…over https', (params.get('redirect_uri') ?? '').startsWith('https://')
        || BASE.startsWith('http://127.0.0.1') || BASE.startsWith('http://localhost'));
      check('the round-trip state is carried in an HttpOnly cookie',
        /httponly/i.test(start.headers.get('set-cookie') ?? ''));

      // A callback with no state cookie is a forged or stale one.
      const forged = await fetch(`${BASE}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' });
      const back = forged.headers.get('location') ?? '';
      check('a callback without the state cookie is refused', back.includes('error=state'));

      // …and it has to send the browser to the public URL, not to whatever
      // address the request happened to arrive on.
      //
      // Behind a proxy — every hosted deployment — the request the handler
      // sees is addressed to the container's bind address, so a redirect built
      // from the request origin becomes https://0.0.0.0:8080/… and loads for
      // nobody. Comparing against BASE would be wrong here (this script may
      // legitimately dial an internal address), so the invariant is that the
      // callback and the redirect_uri agree: both are the configured public
      // URL, and they diverge exactly when this bug is present.
      const publicOrigin = new URL(params.get('redirect_uri') ?? BASE).origin;
      check('…and sends the browser back to the public URL',
        back.startsWith('/') || new URL(back, publicOrigin).origin === publicOrigin,
        `${back} (expected origin ${publicOrigin})`);

      // The state cookie has to survive the trip out and back *as the browser
      // sends it* — percent-encoded, exactly as Set-Cookie wrote it.
      //
      // This is the check that was missing while sign-in was impossible: the
      // value is signed before encoding and was verified after, so it never
      // matched, and the only cookie test here used no cookie at all. Replaying
      // the real header is the one thing that catches it.
      //
      // The code is deliberately bogus, so reaching the token exchange at all
      // is the pass condition: it means the state and signature were accepted.
      const stateCookie = (start.headers.get('set-cookie') ?? '')
        .split(/,(?=\s*ev_oauth=)/)
        .find((c) => c.trim().startsWith('ev_oauth='))
        ?.split(';')[0]
        ?.trim();

      if (!stateCookie) {
        check('the state cookie comes back on the callback', false, 'no ev_oauth in Set-Cookie');
      } else {
        const replayed = await fetch(
          `${BASE}/api/auth/google/callback?code=FAKE&state=${params.get('state')}`,
          { headers: { Cookie: stateCookie }, redirect: 'manual' },
        );
        const reason = new URL(replayed.headers.get('location') ?? '', publicOrigin)
          .searchParams.get('error');
        check('the state cookie survives Set-Cookie and is accepted back',
          reason !== 'state',
          reason === 'state'
            ? 'the cookie was rejected — signed and verified over different strings?'
            : String(reason));
      }
    } else {
      check('an unconfigured public instance refuses rather than opens',
        (await rawStatus('/api/pages')) === 503);
    }

    const supplied = process.env.EVERNOTION_SESSION?.trim();
    if (!supplied) {
      console.log('\n  この環境はGoogleログインで保護されています。');
      console.log('  ブラウザでログインし、ev_session クッキーの値を');
      console.log('  EVERNOTION_SESSION=… に渡して再実行すると残りも検証します。');
      console.log(`\n${passed} passed, ${failures.length} failed`);
      process.exit(failures.length ? 1 : 0);
    }

    cookie = supplied.startsWith('ev_session=') ? supplied : `ev_session=${supplied}`;
    check('the supplied session unlocks the app', (await rawStatusWithCookie('/api/pages')) === 200);
  } else {
    check('a local instance says it is open', health.authMode === 'open');
    check('notes are readable without a session', (await rawStatus('/api/pages')) === 200);
  }

  // --- first run ----------------------------------------------------------
  console.log('\nfirst-run setup');
  const setup = await get('/api/setup/status');
  check('startup reports its state', ['starting', 'downloading', 'ready', 'error'].includes(setup.phase),
    setup.phase);

  const tree = (await get('/api/pages')).tree;
  const welcome = tree.find((n) => n.title === 'はじめに');

  // Only asserted for an account this run is watching from its very first
  // moment. Against a deployment reached with a supplied session, the account
  // may be months old and have deleted the welcome notes on day one — failing
  // on that would be the test being wrong, not the app.
  if (process.env.EVERNOTION_SESSION?.trim()) {
    console.log('  --   welcome notes (既存アカウントのため確認しません)');
  } else {
    check('an empty database is seeded with welcome notes',
      tree.some((n) => n.title === 'はじめに'),
      tree.map((n) => n.title).join(', '));
    check('the welcome note has child notes', (welcome?.children.length ?? 0) >= 2);
  }

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

  // A marker unique to this run. The check below is the only one that asserts
  // a search finds *nothing*, and the section ends by restoring the page — so
  // a fixed word would still be live from the previous run and the assertion
  // would fail the second time this script is pointed at the same instance.
  // Katakana, so it exercises the same bigram path as the rest of the suite.
  const KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ';
  const marker = Array.from({ length: 8 }, () => KANA[Math.floor(Math.random() * KANA.length)]).join('');

  const { body: parent } = await post('/api/pages', { title: 'ゴミ箱テスト親' });
  const { body: child } = await post('/api/pages', {
    title: 'ゴミ箱テスト子', parentId: parent.page.id,
  });
  await patch(`/api/pages/${child.page.id}`, {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `合言葉${marker}` }] }] },
  });

  check('a note is searchable before deletion', (await searchHits(marker)).length > 0);
  await post(`/api/pages/${parent.page.id}/archive`);
  check('deleting a page hides its descendants too', (await searchHits(marker)).length === 0);
  check('a deleted page leaves the sidebar tree',
    !(await get('/api/pages')).tree.some((n) => n.id === parent.page.id));

  const archived = (await get('/api/pages/archived')).pages;
  check('the deleted page is in the trash', archived.some((p) => p.id === parent.page.id));
  check('the trash lists subtree roots, not every child',
    !archived.some((p) => p.id === child.page.id));

  await fetch(`${BASE}/api/pages/${parent.page.id}/archive`, {
    method: 'DELETE', headers: authHeaders(),
  });
  check('restoring brings the content back', (await searchHits(marker)).length > 0);
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
