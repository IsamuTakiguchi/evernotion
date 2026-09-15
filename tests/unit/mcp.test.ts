/**
 * The MCP endpoint, end to end.
 *
 * Two things have to hold here and nowhere else can check them. The protocol
 * has to be the one a real client speaks — so every request below is a real
 * POST through the route handler, with the headers and the `_meta` envelope
 * revision 2026-07-28 requires, and the answers are read off the wire. And a
 * token has to be worth exactly one account — so the isolation tests are
 * written from the attacker's side: Bob holds a valid token of his own and
 * already knows the ids of Alice's notes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before anything opens the database or reads the deployment's own URL.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evernotion-mcp-'));
process.env.EVERNOTION_DATA_DIR = DATA_DIR;
delete process.env.EVERNOTION_SECRET;
process.env.EVERNOTION_RESOLVED_SECRET = 'mcp-test-secret';
process.env.EVERNOTION_BASE_URL = 'https://notes.example.test';

const ORIGIN = 'https://notes.example.test';

const { getDb } = await import('@/lib/db/client');
const q = await import('@/lib/db/queries');
const { search } = await import('@/lib/search/search');
const { upsertUser } = await import('@/lib/auth/users');
const tokens = await import('@/lib/mcp/tokens');
const route = await import('@/app/api/mcp/route');

const db = getDb();

const alice = upsertUser({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' });
const bob = upsertUser({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });

const aliceToken = tokens.createToken(alice.id, 'Alice の Claude');
const bobToken = tokens.createToken(bob.id, 'Bob の Claude');

// Alice's note. Bob will spend the rest of this file trying to read it.
const aliceNote = q.createPage(alice.id, { title: '来期予算の検討' });
q.updatePage(alice.id, aliceNote.id, {
  title: '来期予算の検討',
  doc: {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: '役員報酬と機械学習チームの配分について。' }],
    }],
  },
});
q.setPageTags(alice.id, aliceNote.id, { add: ['アリスのタグ'] });

// ---- talking to the endpoint -------------------------------------------

const REVISION = '2026-07-28';

/** The per-request `_meta` envelope this revision requires on every message. */
const envelope = {
  'io.modelcontextprotocol/protocolVersion': REVISION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

type Wire = { status: number; body: any };

let nextId = 1;

async function post(
  body: unknown,
  { token, headers = {} }: { token?: string; headers?: Record<string, string> } = {},
): Promise<Wire> {
  const res = await route.POST(new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-protocol-version': REVISION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Call one tool as the holder of `token`, and return its parsed JSON result. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const wire = await post(
    {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args, _meta: envelope },
    },
    { token, headers: { 'mcp-method': 'tools/call', 'mcp-name': name } },
  );
  assert.equal(wire.status, 200, JSON.stringify(wire.body));

  const result = wire.body.result;
  assert.ok(result, `no result for ${name}: ${JSON.stringify(wire.body)}`);
  const text = result.content?.[0]?.text ?? '';
  return {
    isError: result.isError === true,
    text: text as string,
    json: result.isError ? null : JSON.parse(text),
  };
}

// ---- the token ----------------------------------------------------------

test('the plaintext token is nowhere in the database', () => {
  const row = db
    .prepare('SELECT * FROM api_tokens WHERE id = ?')
    .get(aliceToken.token.id) as Record<string, unknown>;

  for (const [column, value] of Object.entries(row)) {
    assert.ok(
      typeof value !== 'string' || !value.includes(aliceToken.secret),
      `column ${column} carries the plaintext token`,
    );
  }

  // And not in some other table either — a log line or a settings row would
  // defeat the hashing just as completely.
  const dump = fs.readFileSync(path.join(DATA_DIR, 'evernotion.db'));
  assert.equal(dump.includes(Buffer.from(aliceToken.secret)), false);
});

test('only the first few characters are kept, to recognise it by', () => {
  assert.ok(aliceToken.secret.startsWith('evn_'));
  assert.ok(aliceToken.secret.startsWith(aliceToken.token.prefix));
  assert.ok(aliceToken.token.prefix.length < aliceToken.secret.length / 2);
});

test('a token resolves to its own owner and nobody else', () => {
  assert.equal(tokens.ownerForToken(aliceToken.secret), alice.id);
  assert.equal(tokens.ownerForToken(bobToken.secret), bob.id);
});

test('a token that was never issued resolves to nobody', () => {
  assert.equal(tokens.ownerForToken(undefined), null);
  assert.equal(tokens.ownerForToken(''), null);
  assert.equal(tokens.ownerForToken('evn_' + 'f'.repeat(64)), null);
  assert.equal(tokens.ownerForToken(aliceToken.secret.slice(0, -1)), null);
  assert.equal(tokens.ownerForToken(aliceToken.secret + 'f'), null);
  // The hash of the plaintext is not itself a usable credential.
  const stored = db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
    .get(aliceToken.token.id) as { token_hash: string };
  assert.equal(tokens.ownerForToken(stored.token_hash), null);
});

test('a revoked token stops working, but its record stays', () => {
  const doomed = tokens.createToken(alice.id, '失効させる');
  assert.equal(tokens.ownerForToken(doomed.secret), alice.id);

  assert.equal(tokens.revokeToken(alice.id, doomed.token.id), true);
  assert.equal(tokens.ownerForToken(doomed.secret), null);

  // Revoked, not deleted: when it was issued and last used is still readable.
  const after = tokens.getToken(alice.id, doomed.token.id);
  assert.ok(after?.revokedAt);
  assert.ok(after.lastUsedAt);

  // And revoking twice is not a second success.
  assert.equal(tokens.revokeToken(alice.id, doomed.token.id), false);
});

test('B cannot revoke or even see A’s token', () => {
  assert.equal(tokens.revokeToken(bob.id, aliceToken.token.id), false);
  assert.equal(tokens.getToken(bob.id, aliceToken.token.id), null);
  assert.equal(tokens.ownerForToken(aliceToken.secret), alice.id);

  const mine = tokens.listTokens(bob.id).map((t) => t.id);
  assert.deepEqual(mine, [bobToken.token.id]);
});

test('using a token records that it was used', () => {
  const fresh = tokens.createToken(alice.id, '未使用');
  assert.equal(tokens.getToken(alice.id, fresh.token.id)?.lastUsedAt, null);

  tokens.ownerForToken(fresh.secret);
  assert.ok(tokens.getToken(alice.id, fresh.token.id)?.lastUsedAt);
});

test('the bearer header is read the way clients write it', () => {
  const read = (value: string) =>
    tokens.bearerToken(new Request('https://x.test/', { headers: { authorization: value } }));

  assert.equal(read('Bearer abc'), 'abc');
  assert.equal(read('bearer abc'), 'abc');
  assert.equal(read('Bearer   abc  '), 'abc');
  assert.equal(read('Basic abc'), undefined);
  assert.equal(tokens.bearerToken(new Request('https://x.test/')), undefined);
});

// ---- the endpoint's front door ------------------------------------------

test('without a token the endpoint says what it wants', async () => {
  const wire = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } },
    { headers: { 'mcp-method': 'tools/list' } });
  assert.equal(wire.status, 401);
});

test('a wrong or revoked token gets no further than no token at all', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } };
  const headers = { 'mcp-method': 'tools/list' };

  assert.equal((await post(body, { token: 'evn_nonsense', headers })).status, 401);

  const doomed = tokens.createToken(bob.id, 'すぐ失効');
  tokens.revokeToken(bob.id, doomed.token.id);
  assert.equal((await post(body, { token: doomed.secret, headers })).status, 401);
});

test('GET and DELETE are refused — this revision is POST-only', () => {
  for (const res of [route.GET(), route.DELETE()]) {
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'POST');
  }
});

test('a request carrying a browser’s Origin is refused', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } };
  const headers = { 'mcp-method': 'tools/list' };

  // A page on some other site, driving this endpoint through the browser.
  const foreign = await post(body, { token: aliceToken.secret, headers: { ...headers, origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);

  // Our own origin is fine, and so is no Origin at all — which is what Claude
  // Code sends, since it is not a browser.
  assert.equal((await post(body, { token: aliceToken.secret, headers: { ...headers, origin: ORIGIN } })).status, 200);
  assert.equal((await post(body, { token: aliceToken.secret, headers })).status, 200);
});

test('headers that disagree with the body are rejected with -32020', async () => {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'list_tags', arguments: {}, _meta: envelope },
  };

  // The header names a different method than the body does.
  const mismatched = await post(body, {
    token: aliceToken.secret,
    headers: { 'mcp-method': 'tools/list', 'mcp-name': 'list_tags' },
  });
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.body.error.code, -32020);

  // The header names a different tool than the body does.
  const wrongName = await post(body, {
    token: aliceToken.secret,
    headers: { 'mcp-method': 'tools/call', 'mcp-name': 'get_note' },
  });
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.body.error.code, -32020);
});

test('the tools on offer are the ones Claude is meant to have', async () => {
  const wire = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } },
    { token: aliceToken.secret, headers: { 'mcp-method': 'tools/list' } },
  );
  assert.equal(wire.status, 200);

  const names = (wire.body.result.tools as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(names, [
    'append_to_note', 'create_note', 'get_note',
    'list_recent_notes', 'list_tags', 'search_notes', 'semantic_search',
  ]);

  // No tool that replaces or removes a note. Adding one is a decision, not a
  // detail, and this is where that decision would have to be made again.
  assert.equal(names.some((n) => /delete|remove|replace|overwrite|update/.test(n)), false);
});

// ---- one account, one token ---------------------------------------------

test('B’s token does not find A’s notes', async () => {
  const hits = await callTool(bobToken.secret, 'search_notes', { query: '予算' });
  assert.deepEqual(hits.json.hits, []);

  const mine = await callTool(aliceToken.secret, 'search_notes', { query: '予算' });
  assert.equal(mine.json.hits.length, 1);
  assert.equal(mine.json.hits[0].noteId, aliceNote.id);
});

test('B’s token cannot read A’s note by its id', async () => {
  const stolen = await callTool(bobToken.secret, 'get_note', { noteId: aliceNote.id });
  assert.equal(stolen.isError, true);
  assert.equal(stolen.text.includes('役員報酬'), false);

  const owner = await callTool(aliceToken.secret, 'get_note', { noteId: aliceNote.id });
  assert.equal(owner.json.title, '来期予算の検討');
  assert.ok(owner.json.markdown.includes('役員報酬'));
  assert.deepEqual(owner.json.tags, ['アリスのタグ']);
});

test('B’s token cannot append to A’s note, or nest anything under it', async () => {
  const appended = await callTool(bobToken.secret, 'append_to_note', {
    noteId: aliceNote.id, markdown: '**Bob was here**',
  });
  assert.equal(appended.isError, true);

  const nested = await callTool(bobToken.secret, 'create_note', {
    title: '侵入', markdown: '', parentNoteId: aliceNote.id,
  });
  assert.equal(nested.isError, true);

  // Alice's note is untouched, and has no new child.
  const after = q.getPage(alice.id, aliceNote.id)!;
  assert.equal(after.doc_json.includes('Bob was here'), false);
  assert.deepEqual(
    q.listPageTree(alice.id).find((n) => n.id === aliceNote.id)?.children ?? [],
    [],
  );
});

test('B’s token sees neither A’s tags nor A’s recent notes', async () => {
  const tags = await callTool(bobToken.secret, 'list_tags');
  assert.deepEqual(tags.json.tags, []);

  const recent = await callTool(bobToken.secret, 'list_recent_notes');
  assert.equal(recent.json.notes.some((n: { id: string }) => n.id === aliceNote.id), false);
});

test('a note Claude creates belongs to the token’s owner', async () => {
  const created = await callTool(bobToken.secret, 'create_note', {
    title: 'ボブの議事録',
    markdown: '# 決定事項\n\n- [x] 予算案を承認\n- [ ] 次回までに再見積\n',
  });

  const row = db.prepare('SELECT owner_id FROM pages WHERE id = ?')
    .get(created.json.id) as { owner_id: string };
  assert.equal(row.owner_id, bob.id);

  // Alice cannot see it, by either route.
  assert.ok(!q.getPage(alice.id, created.json.id));
  const aliceLooks = await callTool(aliceToken.secret, 'search_notes', { query: '議事録' });
  assert.deepEqual(aliceLooks.json.hits, []);
});

// ---- the round trip -----------------------------------------------------

test('a note created through Claude is a note the app can find and read', async () => {
  const created = await callTool(aliceToken.secret, 'create_note', {
    title: 'クロードが書いたノート',
    markdown: [
      '## 経緯',
      '',
      '**重要**: 契約書の確認が必要。',
      '',
      '- [x] 資料配布',
      '- [ ] 見積取得',
      '',
      '| 項目 | 金額 |',
      '| --- | --- |',
      '| 開発費 | 100万円 |',
      '',
      '関連: [[来期予算の検討]]',
    ].join('\n'),
  });

  // The link it wrote resolves to Alice's existing note, not to a new one.
  assert.deepEqual(
    q.getBacklinks(alice.id, aliceNote.id).map((b) => b.id),
    [created.json.id],
  );

  // The app's own search finds it — including a two-character Japanese query,
  // which is the whole reason the index is built the way it is.
  for (const query of ['契約', '開発費', 'クロード']) {
    const hits = search(alice.id, query, { kind: null, tag: null, limit: 10 });
    assert.ok(
      hits.some((hit) => hit.pageId === created.json.id),
      `the app's search does not find the new note for ${query}`,
    );
  }

  // And reading it back through Claude returns the Markdown that went in.
  const read = await callTool(aliceToken.secret, 'get_note', { noteId: created.json.id });
  const markdown = read.json.markdown as string;
  assert.match(markdown, /^## 経緯$/m);
  assert.match(markdown, /\*\*重要\*\*/);
  assert.match(markdown, /^- \[x\] 資料配布$/m);
  assert.match(markdown, /^- \[ \] 見積取得$/m);
  assert.match(markdown, /^\| 開発費 \| 100万円 \|$/m);
  assert.match(markdown, /\[\[来期予算の検討\]\]/);

  // And the link is reported as a link, so Claude can follow it with get_note
  // rather than parsing the prose for it.
  assert.deepEqual(read.json.linksTo, [{ title: '来期予算の検討', pageId: null }]);
  assert.deepEqual(
    (read.json.linkedFrom as { id: string }[]).map((b) => b.id),
    [],
  );
});

test('the link Claude is handed is the app’s public URL, not the container’s', async () => {
  const created = await callTool(aliceToken.secret, 'create_note', {
    title: 'URLの確認', markdown: '本文',
  });
  assert.equal(created.json.url, `${ORIGIN}/p/${created.json.id}`);

  const appended = await callTool(aliceToken.secret, 'append_to_note', {
    noteId: created.json.id, markdown: '追記',
  });
  assert.equal(appended.json.url, `${ORIGIN}/p/${created.json.id}`);
  assert.equal(appended.json.url.includes('localhost'), false);
});

test('appending adds to a note without disturbing what was there', async () => {
  const before = q.getPage(alice.id, aliceNote.id)!.doc_json;

  await callTool(aliceToken.secret, 'append_to_note', {
    noteId: aliceNote.id, markdown: '### 追記\n\n合意済み。',
  });

  const after = q.getPage(alice.id, aliceNote.id)!;
  assert.ok(after.doc_json.includes('役員報酬'), 'the original text survived');
  assert.ok(after.doc_json.includes('合意済み'), 'the addition landed');

  const doc = JSON.parse(after.doc_json) as { content: unknown[] };
  const original = JSON.parse(before) as { content: unknown[] };
  assert.deepEqual(doc.content.slice(0, original.content.length), original.content);
});
