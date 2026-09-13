import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { normalize, foldCase, normalizeFold } from '../../lib/search/normalize';
import { ngram, ngramText, isCjk } from '../../lib/search/ngram';
import { parseQuery } from '../../lib/search/query';
import { makeSnippet } from '../../lib/search/snippet';

/*
 * The Japanese search path is the least obvious code in the project and the
 * easiest to break without noticing: index and query must be tokenised by
 * exactly the same rules, or search silently returns nothing.
 */

test('normalize folds full-width and half-width to one form', () => {
  assert.equal(normalize('ＴＯＫＹＯ'), 'TOKYO');
  assert.equal(normalize('ｶﾀｶﾅ'), 'カタカナ');
  // Ideographic space, or the two halves of a sentence never meet.
  assert.equal(normalize('予算　承認'), '予算 承認');
  assert.equal(normalize('  a\n\nb  '), 'a b');
  assert.equal(normalize('ゼロ​幅'), 'ゼロ幅');
});

test('foldCase never changes the length of the string', () => {
  // Snippet offsets are found on the folded text and applied to the original,
  // so a codepoint whose lowercase is longer would mis-slice everything after.
  for (const input of ['ABC', 'ÄÖÜ', 'ß', 'İstanbul', '日本語', 'Åß本İ']) {
    assert.equal(
      [...foldCase(input)].length,
      [...input].length,
      `length changed for ${input}`,
    );
  }
  assert.equal(foldCase('ABC'), 'abc');
  assert.equal(foldCase('ß'), 'ß'); // left alone rather than expanded to "ss"
});

test('ngram splits CJK into overlapping bigrams and keeps latin words whole', () => {
  assert.deepEqual(ngram('東京都'), ['東京', '京都']);
  assert.deepEqual(ngram('機械学習'), ['機械', '械学', '学習']);
  assert.deepEqual(ngram('東'), ['東']);
  assert.deepEqual(ngram('tokyo'), ['tokyo']);
  assert.deepEqual(ngram('ＴＯＫＹＯ'), ['tokyo']);
  assert.deepEqual(ngram('snake_case'), ['snake_case']);
  assert.deepEqual(ngram(''), []);
  assert.deepEqual(ngram('!!! ??? 。'), []);
});

test('ngram keeps latin and CJK runs separate', () => {
  assert.deepEqual(ngram('AI技術'), ['ai', '技術']);
  assert.deepEqual(ngram('第2条'), ['第', '2', '条']);
});

test('ngram never splits a surrogate pair', () => {
  // A rare kanji outside the BMP must survive as one character.
  const rare = '\u{20BB7}\u{20BB7}';
  assert.deepEqual(ngram(rare), [rare]);
});

test('index and query tokenise identically', () => {
  // The whole scheme rests on this: different rules on either side means a
  // document is indexed under tokens no query can ever produce.
  for (const text of ['東京都', '機械学習', 'ＴＯＫＹＯ', 'AI技術', '予算']) {
    assert.equal(ngramText(text), ngram(text).join(' '), text);
  }
});

test('two-character Japanese queries produce a matchable phrase', () => {
  // The case FTS5's trigram tokenizer cannot answer at all, and the reason
  // this bigram scheme exists.
  for (const term of ['予算', '契約', '会議', '東京']) {
    const parsed = parseQuery(term);
    assert.equal(parsed.match, `"${term}"`, term);
  }
});

test('longer Japanese queries become adjacency phrases', () => {
  assert.equal(parseQuery('機械学習').match, '"機械 械学 学習"');
  assert.equal(parseQuery('新規事業').match, '"新規 規事 事業"');
});

test('a single CJK character falls back to a prefix match', () => {
  // One character yields no bigram, so it has to match as a prefix instead.
  assert.equal(parseQuery('東').match, '"東"*');
});

test('every generated expression is valid FTS5, whatever the user typed', () => {
  // Checked against a real FTS5 table rather than by inspecting the string:
  // the only thing that matters is that SQLite accepts it, and a hand-written
  // pattern check cannot tell the builder's own AND from an injected one.
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='unicode61')");
  db.prepare('INSERT INTO probe VALUES (?)').run(ngramText('東京都で機械学習の予算を承認 tokyo'));

  const inputs = [
    '"', 'AND OR NOT', '*', '予算" OR "', 'a NEAR/2 b', '((', ')', '^foo',
    '-', '- -', 'a:b', '{title}', 'x AND (', '\"\"\"', '予算 OR 契約',
    '予算', '機械学習', '東', 'tokyo', 'ＴＯＫＹＯ',
  ];
  for (const input of inputs) {
    const { match } = parseQuery(input);
    if (match === null) continue;
    assert.doesNotThrow(
      () => db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get(match),
      `FTS5 rejected the expression built from ${JSON.stringify(input)}: ${match}`,
    );
  }
  db.close();
});

test('a hostile query cannot reach past its own terms', () => {
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='unicode61')");
  db.prepare('INSERT INTO probe VALUES (?)').run(ngramText('契約書のみ'));

  const { match } = parseQuery('予算" OR "');
  assert.ok(match);
  const hits = db
    .prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?')
    .get(match) as { n: number };
  // The document holds 契約 but not 予算; a surviving OR would have matched it.
  assert.equal(hits.n, 0, `injected operator matched: ${match}`);
  db.close();
});

test('multiple terms are ANDed, and negation is honoured', () => {
  const parsed = parseQuery('予算 契約');
  assert.equal(parsed.match, '"予算" AND "契約"');
  assert.deepEqual(parsed.terms, ['予算', '契約']);

  assert.equal(parseQuery('予算 -契約').match, '"予算" NOT "契約"');
});

test('a quoted phrase stays one term', () => {
  const parsed = parseQuery('"新規 事業"');
  assert.deepEqual(parsed.terms, ['新規 事業']);
});

test('operators are stripped before tokenising', () => {
  const parsed = parseQuery('tag:経営 kind:pdf 予算');
  assert.equal(parsed.tag, '経営');
  assert.equal(parsed.kind, 'pdf');
  assert.equal(parsed.match, '"予算"');
});

test('a query with nothing indexable reports no match expression', () => {
  // The caller falls back to LIKE rather than issuing an empty MATCH.
  assert.equal(parseQuery('！？。').match, null);
  assert.equal(parseQuery('   ').match, null);
});

test('live mode lets the last latin term match as a prefix', () => {
  assert.equal(parseQuery('toky', { live: true }).match, '"toky"*');
  assert.equal(parseQuery('toky').match, '"toky"');
});

test('snippets mark the query inside the original text', () => {
  const body = '本日の取締役会で新規事業の予算案を承認した。';
  const runs = makeSnippet(body, ['予算']);
  assert.ok(runs.some((r) => r.mark && r.text === '予算'), JSON.stringify(runs));
  // The excerpt must reproduce the source text, not a tokenised form of it.
  assert.ok(runs.map((r) => r.text).join('').replace(/…/g, '').length > 0);
  assert.ok(body.includes(runs.filter((r) => !r.mark).map((r) => r.text).join('').replace(/…/g, '').slice(0, 5)));
});

test('snippets match case-insensitively and across widths', () => {
  const runs = makeSnippet('会場は TOKYO 本社です', ['ＴＯＫＹＯ']);
  assert.ok(runs.some((r) => r.mark && r.text === 'TOKYO'), JSON.stringify(runs));
});

test('snippets survive text with no match', () => {
  const runs = makeSnippet('関係のない本文です', ['予算']);
  assert.ok(runs.length > 0);
  assert.ok(runs.every((r) => !r.mark));
});

test('isCjk recognises the scripts the tokenizer depends on', () => {
  for (const ch of ['予', 'ア', 'あ', '々', 'ー']) assert.ok(isCjk(ch), ch);
  for (const ch of ['a', '1', ' ', '-']) assert.ok(!isCjk(ch), ch);
});

test('normalizeFold is the composition used on both sides', () => {
  assert.equal(normalizeFold('ＴＯＫＹＯ　都'), 'tokyo 都');
});
