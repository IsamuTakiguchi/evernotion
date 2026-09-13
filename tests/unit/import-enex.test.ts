import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { parseEnex, parseEnexDate, looksLikeEnex } from '@/lib/import/enex';
import type { ImportedNote } from '@/lib/import/types';

/** A one-byte PNG stand-in; only its bytes and their hash matter here. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_HASH = createHash('md5').update(PNG).digest('hex');

function enex(notes: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260101T000000Z" application="Evernote">${notes}</en-export>`;
}

/** Feed the document in small chunks, the way a file stream would. */
async function* chunks(text: string, size = 64): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collect(xml: string, size?: number): Promise<ImportedNote[]> {
  const out: ImportedNote[] = [];
  const count = await parseEnex(chunks(xml, size), (n) => { out.push(n); });
  assert.equal(count, out.length, 'the reported count matches the notes handed over');
  return out;
}

// ----------------------------------------------------------------- dates ---

test('Evernote timestamps become ISO', () => {
  assert.equal(parseEnexDate('20240131T093000Z'), '2024-01-31T09:30:00.000Z');
  assert.equal(parseEnexDate('2024-01-31T09:30:00Z'), '2024-01-31T09:30:00.000Z');
  assert.equal(parseEnexDate(undefined), undefined);
  assert.equal(parseEnexDate('nonsense'), undefined);
});

test('an export is recognised by its header', () => {
  assert.equal(looksLikeEnex(Buffer.from(enex(''))), true);
  assert.equal(looksLikeEnex(Buffer.from('PK zip')), false);
});

// ----------------------------------------------------------------- notes ---

test('a note keeps its title, body, tags and dates', async () => {
  const notes = await collect(enex(`
    <note>
      <title>会議メモ</title>
      <content><![CDATA[<en-note><div>予算の話</div></en-note>]]></content>
      <created>20240131T093000Z</created>
      <updated>20240201T101500Z</updated>
      <tag>仕事</tag>
      <tag>重要</tag>
    </note>`));

  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, '会議メモ');
  assert.match(notes[0].html, /予算の話/);
  assert.deepEqual(notes[0].tags, ['仕事', '重要']);
  assert.equal(notes[0].createdAt, '2024-01-31T09:30:00.000Z');
  assert.equal(notes[0].updatedAt, '2024-02-01T10:15:00.000Z');
});

test('several notes come out in order', async () => {
  const notes = await collect(enex(`
    <note><title>一つ目</title><content><![CDATA[<en-note>A</en-note>]]></content></note>
    <note><title>二つ目</title><content><![CDATA[<en-note>B</en-note>]]></content></note>
    <note><title>三つ目</title><content><![CDATA[<en-note>C</en-note>]]></content></note>`));

  assert.deepEqual(notes.map((n) => n.title), ['一つ目', '二つ目', '三つ目']);
});

test('an untitled note still gets a name', async () => {
  const notes = await collect(enex(
    '<note><title></title><content><![CDATA[<en-note>本文</en-note>]]></content></note>',
  ));
  assert.equal(notes[0].title, '無題');
});

test('a note split across chunk boundaries is not corrupted', async () => {
  // The parser is fed in pieces, so a tag or a multi-byte character can land
  // across a boundary. Reading one byte at a time is the harshest version.
  const xml = enex(
    '<note><title>日本語のタイトル</title>'
    + '<content><![CDATA[<en-note><div>本文も日本語</div></en-note>]]></content>'
    + '<tag>タグ</tag></note>',
  );
  for (const size of [1, 3, 7, 64, 100_000]) {
    const notes = await collect(xml, size);
    assert.equal(notes.length, 1, `chunk size ${size}`);
    assert.equal(notes[0].title, '日本語のタイトル', `chunk size ${size}`);
    assert.match(notes[0].html, /本文も日本語/, `chunk size ${size}`);
    assert.deepEqual(notes[0].tags, ['タグ'], `chunk size ${size}`);
  }
});

// ------------------------------------------------------------- resources ---

test('an attachment is decoded and hashed so the body can find it', async () => {
  const notes = await collect(enex(`
    <note>
      <title>写真つき</title>
      <content><![CDATA[<en-note><en-media hash="${PNG_HASH}" type="image/png"/></en-note>]]></content>
      <resource>
        <data encoding="base64">${PNG.toString('base64')}</data>
        <mime>image/png</mime>
        <resource-attributes><file-name>photo.png</file-name></resource-attributes>
      </resource>
    </note>`));

  const [resource] = notes[0].resources;
  assert.equal(resource.filename, 'photo.png');
  assert.equal(resource.mime, 'image/png');
  assert.deepEqual(Buffer.from(resource.data), PNG);
  // The body references the attachment by this hash, so it has to match.
  assert.equal(resource.hash, PNG_HASH);
  assert.match(notes[0].html, new RegExp(PNG_HASH));
});

test('base64 wrapped across lines still decodes', async () => {
  const wrapped = PNG.toString('base64').split('').join('\n');
  const notes = await collect(enex(`
    <note><title>t</title><content><![CDATA[<en-note/>]]></content>
      <resource><data encoding="base64">${wrapped}</data><mime>image/png</mime></resource>
    </note>`));
  assert.deepEqual(Buffer.from(notes[0].resources[0].data), PNG);
});

test('a resource with no filename gets a usable one', async () => {
  const notes = await collect(enex(`
    <note><title>t</title><content><![CDATA[<en-note/>]]></content>
      <resource><data encoding="base64">${PNG.toString('base64')}</data>
      <mime>application/pdf</mime></resource>
    </note>`));
  assert.equal(notes[0].resources[0].filename, 'attachment');
  assert.equal(notes[0].resources[0].mime, 'application/pdf');
});

test('an empty resource is dropped rather than written as a zero-byte file', async () => {
  const notes = await collect(enex(`
    <note><title>t</title><content><![CDATA[<en-note/>]]></content>
      <resource><data encoding="base64"></data><mime>image/png</mime></resource>
    </note>`));
  assert.equal(notes[0].resources.length, 0);
});

test('several attachments on one note stay distinct', async () => {
  const other = Buffer.from('second attachment bytes');
  const notes = await collect(enex(`
    <note><title>t</title><content><![CDATA[<en-note/>]]></content>
      <resource><data encoding="base64">${PNG.toString('base64')}</data>
        <mime>image/png</mime>
        <resource-attributes><file-name>a.png</file-name></resource-attributes></resource>
      <resource><data encoding="base64">${other.toString('base64')}</data>
        <mime>application/pdf</mime>
        <resource-attributes><file-name>b.pdf</file-name></resource-attributes></resource>
    </note>`));

  assert.deepEqual(notes[0].resources.map((r) => r.filename), ['a.png', 'b.pdf']);
  assert.notEqual(notes[0].resources[0].hash, notes[0].resources[1].hash);
});

// -------------------------------------------------------------- survival ---

test('an empty export yields no notes', async () => {
  assert.deepEqual(await collect(enex('')), []);
});

test('the note callback may be asynchronous', async () => {
  const seen: string[] = [];
  await parseEnex(chunks(enex(
    '<note><title>A</title><content><![CDATA[<en-note/>]]></content></note>'
    + '<note><title>B</title><content><![CDATA[<en-note/>]]></content></note>',
  )), async (n) => {
    await new Promise((r) => setTimeout(r, 1));
    seen.push(n.title);
  });
  // Order must survive the awaiting, or notes would be written interleaved.
  assert.deepEqual(seen, ['A', 'B']);
});

test('a failure while handling a note stops the import', async () => {
  await assert.rejects(
    parseEnex(chunks(enex(
      '<note><title>A</title><content><![CDATA[<en-note/>]]></content></note>',
    )), () => { throw new Error('disk full'); }),
    /disk full/,
  );
});
