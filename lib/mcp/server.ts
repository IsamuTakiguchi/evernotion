/**
 * The notes, as tools Claude can call.
 *
 * Every tool here is a thin wrapper over a function the app already uses, and
 * that is the point: search is the same bigram search the UI runs, so a
 * two-character Japanese query works; a created note goes through createPage,
 * so it is indexed and linked like any other; a PDF found here is one the
 * existing ingest pipeline already read.
 *
 * Isolation comes from the same place too. Each of those functions takes the
 * owner as its first argument, and the owner here is whoever the token
 * belonged to — so a token cannot reach past its own account, for the same
 * reason a signed-in session cannot.
 *
 * Deliberately no overwrite and no delete. Claude can read and it can add;
 * replacing the body of an existing note is how notes get lost, and nothing
 * here is worth that risk.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  createPage, getBacklinks, getPage, getPageTags, listPageTree, listTags, updatePage,
} from '../db/queries';
import { search } from '../search/search';
import { vectorSearch } from '../ai/rag';
import { queuePageIndex } from '../ai/indexer';
import { docLinks, docToMarkdown } from '../editor/markdown';
import { htmlToDoc } from '../import/html';
import { notionMarkdownToHtml } from '../import/notion';
import type { JSONContent } from '../editor/doc';

/** Tool results are text; JSON keeps structure the model can act on. */
const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const notFound = (what: string) => ({
  content: [{ type: 'text' as const, text: `見つかりません: ${what}` }],
  isError: true,
});

/** Markdown in, editor nodes out — the same path the importer takes. */
function markdownToDoc(markdown: string): JSONContent {
  return htmlToDoc(notionMarkdownToHtml(markdown));
}

export function buildMcpServer(ownerId: string, baseUrl?: string): McpServer {
  const server = new McpServer({ name: 'evernotian', version: '1.0.0' });
  const md = (doc: JSONContent) => docToMarkdown(doc, { baseUrl });

  server.registerTool(
    'search_notes',
    {
      description:
        'Search the notes by keyword. Matches inside PDF attachments as well as note '
        + 'bodies, and handles Japanese without spaces — a two-character query such as '
        + '予算 or 契約 works. Use this first when looking for something specific.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for. Japanese needs no spaces.'),
        kind: z.enum(['page', 'pdf']).optional()
          .describe('Restrict to notes, or to text inside PDFs.'),
        tag: z.string().optional().describe('Only notes carrying this tag.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ query, kind, tag, limit }) => json({
      hits: search(ownerId, query, { kind: kind ?? null, tag: tag ?? null, limit: limit ?? 20 })
        .map((hit) => ({
          noteId: hit.pageId,
          title: hit.title,
          kind: hit.kind,
          attachmentId: hit.attachmentId,
          pdfPage: hit.pdfPageNo,
          excerpt: hit.snippet.map((run) => run.text).join(''),
        })),
    }),
  );

  server.registerTool(
    'semantic_search',
    {
      description:
        'Find notes close in meaning to a question, rather than sharing its words. '
        + 'Use when a keyword search comes back empty or the wording is uncertain.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(30).optional(),
      }),
    },
    async ({ query, limit }) => {
      try {
        const results = await vectorSearch(ownerId, query, limit ?? 10);
        return json({
          hits: results.map(({ row, score }) => ({
            noteId: row.page_id,
            title: row.page_title ?? row.filename,
            attachmentId: row.attachment_id,
            pdfPage: row.pdf_page_no,
            score: Number(score.toFixed(4)),
            excerpt: row.text.slice(0, 400),
          })),
        });
      } catch (err) {
        // The embedding model may still be downloading on a fresh install.
        // Saying so beats an error the model cannot interpret.
        return {
          content: [{
            type: 'text' as const,
            text: `意味検索はまだ使えません（${(err as Error).message}）。`
              + 'search_notes を使ってください。',
          }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      description:
        'Read one note in full, as Markdown, with its tags, the notes linking to it, '
        + 'and the notes it links to.',
      inputSchema: z.object({ noteId: z.string().min(1) }),
    },
    async ({ noteId }) => {
      const page = getPage(ownerId, noteId);
      if (!page) return notFound(noteId);

      const doc = JSON.parse(page.doc_json) as JSONContent;
      return json({
        id: page.id,
        title: page.title,
        markdown: md(doc),
        tags: getPageTags(ownerId, page.id).map((t) => t.name),
        // The ids are here rather than in the prose so they can be followed
        // with get_note without parsing the Markdown for them.
        linksTo: docLinks(doc),
        linkedFrom: getBacklinks(ownerId, page.id).map((b) => ({ id: b.id, title: b.title })),
        updatedAt: page.updated_at,
      });
    },
  );

  server.registerTool(
    'list_recent_notes',
    {
      description: 'The most recently edited notes. Use to see what is here before searching.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ limit }) => {
      const flat: { id: string; title: string; updatedAt: string; parentId: string | null }[] = [];
      const walk = (nodes: ReturnType<typeof listPageTree>) => {
        for (const node of nodes) {
          flat.push({
            id: node.id, title: node.title || '無題',
            updatedAt: node.updatedAt, parentId: node.parentId,
          });
          walk(node.children);
        }
      };
      walk(listPageTree(ownerId));
      flat.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json({ notes: flat.slice(0, limit ?? 20), total: flat.length });
    },
  );

  server.registerTool(
    'list_tags',
    {
      description: 'Every tag in use, with how many notes carry it.',
      inputSchema: z.object({}),
    },
    async () => json({ tags: listTags(ownerId) }),
  );

  server.registerTool(
    'create_note',
    {
      description:
        'Create a new note from Markdown. Headings, lists, task lists, tables, code '
        + 'blocks and quotes are all kept. Write [[Another note]] to link to another '
        + 'note by title. Creates a new note every time — it never replaces one.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        markdown: z.string().describe('The body. May be empty.'),
        parentNoteId: z.string().optional().describe('Nest the new note under this one.'),
      }),
    },
    async ({ title, markdown, parentNoteId }) => {
      if (parentNoteId && !getPage(ownerId, parentNoteId)) return notFound(parentNoteId);

      const page = createPage(ownerId, { title, parentId: parentNoteId ?? null });
      updatePage(ownerId, page.id, { title, doc: markdownToDoc(markdown) });
      queuePageIndex(page.id);

      return json({ id: page.id, title, url: `${baseUrl ?? ''}/p/${page.id}` });
    },
  );

  server.registerTool(
    'append_to_note',
    {
      description:
        'Add Markdown to the end of an existing note. Everything already in the note '
        + 'is left untouched — this only ever adds.',
      inputSchema: z.object({
        noteId: z.string().min(1),
        markdown: z.string().min(1),
      }),
    },
    async ({ noteId, markdown }) => {
      const page = getPage(ownerId, noteId);
      if (!page) return notFound(noteId);

      const current = JSON.parse(page.doc_json) as JSONContent;
      const addition = markdownToDoc(markdown);
      const merged: JSONContent = {
        type: 'doc',
        content: [...(current.content ?? []), ...(addition.content ?? [])],
      };

      updatePage(ownerId, page.id, { doc: merged });
      queuePageIndex(page.id);

      return json({ id: page.id, title: page.title, url: `${baseUrl ?? ''}/p/${page.id}` });
    },
  );

  return server;
}
