/**
 * Evernote .enex exports.
 *
 * An .enex is one XML document holding every note, and a real export can be
 * several gigabytes — a library that returns a parsed tree would need all of
 * it in memory at once. So this drives htmlparser2's streaming parser and
 * hands each note to a callback as soon as its closing tag arrives, which
 * keeps memory flat at roughly one note plus its attachments.
 *
 * The body is ENML, a subset of XHTML, and goes to lib/import/html.ts like
 * everything else. Attachments are referenced from the body by the MD5 of
 * their bytes rather than by name, so they are indexed by hash here.
 */
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Parser } from 'htmlparser2';

import type { ImportedNote, ImportedResource } from './types';

/** Evernote writes timestamps as 20240131T093000Z. */
export function parseEnexDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

function decodeBase64(text: string): Uint8Array {
  // Evernote wraps the base64 at column 80; whitespace is not part of it.
  return new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'base64'));
}

/** Everything accumulated for the note currently being read. */
type Partial = {
  title: string;
  content: string;
  tags: string[];
  created?: string;
  updated?: string;
  resources: ImportedResource[];
};

const emptyNote = (): Partial => ({ title: '', content: '', tags: [], resources: [] });

type PartialResource = { data: string; mime: string; filename: string };
const emptyResource = (): PartialResource => ({ data: '', mime: '', filename: '' });

/**
 * Read an .enex, calling `onNote` for each note in document order.
 *
 * Returns the number of notes seen. Errors inside `onNote` propagate, so one
 * unwritable note stops the import rather than being silently skipped.
 */
export async function parseEnex(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  onNote: (note: ImportedNote) => void | Promise<void>,
): Promise<number> {
  let note: Partial | null = null;
  let resource: PartialResource | null = null;
  let count = 0;

  // Where character data currently belongs. Evernote nests <file-name> inside
  // <resource-attributes>, so the innermost open tag decides.
  let field: string | null = null;
  const pending: ImportedNote[] = [];

  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (tag === 'note') { note = emptyNote(); return; }
        if (tag === 'resource') { resource = emptyResource(); return; }
        // Each <tag> opens a new value. Appending to whatever was last instead
        // would run consecutive tags together into one.
        if (tag === 'tag' && note) note.tags.push('');
        field = tag;
      },

      ontext(text) {
        if (!note || !field) return;
        if (resource) {
          if (field === 'data') resource.data += text;
          else if (field === 'mime') resource.mime += text;
          else if (field === 'file-name') resource.filename += text;
          return;
        }
        if (field === 'title') note.title += text;
        else if (field === 'content') note.content += text;
        else if (field === 'tag') {
          // Text can arrive in pieces when a tag straddles a chunk boundary.
          if (note.tags.length === 0) note.tags.push('');
          note.tags[note.tags.length - 1] += text;
        } else if (field === 'created') note.created = (note.created ?? '') + text;
        else if (field === 'updated') note.updated = (note.updated ?? '') + text;
      },

      // CDATA is how the ENML body is carried; htmlparser2 reports it apart
      // from ordinary text, and without this the body would come out empty.
      oncdatastart() { /* content continues to arrive through ontext */ },

      onclosetag(name) {
        const tag = name.toLowerCase();

        if (tag === 'tag' && note) {
          const value = note.tags.pop()?.trim();
          if (value) note.tags.push(value);   // an empty <tag/> is dropped
          field = null;
          return;
        }

        if (tag === 'resource' && note && resource) {
          const bytes = decodeBase64(resource.data);
          if (bytes.byteLength > 0) {
            note.resources.push({
              filename: resource.filename.trim() || 'attachment',
              mime: resource.mime.trim() || 'application/octet-stream',
              data: bytes,
              hash: createHash('md5').update(bytes).digest('hex'),
            });
          }
          resource = null;
          field = null;
          return;
        }

        if (tag === 'note' && note) {
          pending.push({
            title: note.title.trim() || '無題',
            html: note.content,
            tags: note.tags,
            createdAt: parseEnexDate(note.created),
            updatedAt: parseEnexDate(note.updated),
            resources: note.resources,
          });
          note = null;
          field = null;
          return;
        }

        field = null;
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true },
  );

  // Notes are drained between chunks rather than from inside the callback,
  // because the parser is synchronous and onNote may await the database.
  const drain = async () => {
    while (pending.length) {
      await onNote(pending.shift()!);
      count++;
    }
  };

  // Decoding each chunk on its own would corrupt any character whose bytes
  // straddle a boundary — which in Japanese is almost every character, since
  // they are three bytes each. StringDecoder holds the incomplete tail back
  // until the rest of it arrives.
  const decoder = new StringDecoder('utf8');

  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    parser.write(decoder.write(Buffer.from(chunk)));
    await drain();
  }
  const tail = decoder.end();
  if (tail) parser.write(tail);
  parser.end();
  await drain();

  return count;
}

/** True when these first bytes look like an Evernote export. */
export function looksLikeEnex(head: Buffer): boolean {
  const text = head.subarray(0, 2048).toString('utf8').toLowerCase();
  return text.includes('<en-export') || text.includes('<!doctype en-export');
}
