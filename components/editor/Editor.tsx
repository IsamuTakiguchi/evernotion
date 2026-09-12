'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { createLowlight } from 'lowlight';

import { WikiLink } from './extensions/WikiLink';
import { PdfBlock } from './extensions/PdfBlock';
import { SlashCommand, filterSlashItems, type SlashItem } from './extensions/SlashCommand';
import { makeSuggestionRender } from './suggestionRenderer';
import { api } from '@/lib/client/api';
import type { JSONContent } from '@/lib/editor/doc';
import { IconFile, IconMore, IconPlus } from '@/components/ui/Icons';

// Only the languages worth shipping: the full highlight.js bundle is ~1MB.
import js from 'highlight.js/lib/languages/javascript';
import ts from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';

const lowlight = createLowlight();
lowlight.register({ js, javascript: js, ts, typescript: ts, python, json, bash, sh: bash, sql, markdown, md: markdown });

type PageSummary = { id: string; title: string; icon: string | null };

type Props = {
  pageId: string;
  initialDoc: JSONContent;
  onSaved?: () => void;
};

const AUTOSAVE_MS = 800;

export function Editor({ pageId, initialDoc, onSaved }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<TiptapEditor | null>(null);

  const save = useCallback(
    async (doc: JSONContent) => {
      setSaving(true);
      try {
        await api.patch(`/api/pages/${pageId}`, { doc });
        onSaved?.();
        window.dispatchEvent(new CustomEvent('ev:pages-changed'));
      } finally {
        setSaving(false);
      }
    },
    [pageId, onSaved],
  );

  const scheduleSave = useCallback(
    (editor: TiptapEditor) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // Never post mid-conversion: the document would carry half-converted
        // kana and the search index would churn on every keystroke.
        if (editor.view.composing) return;
        void save(editor.getJSON() as JSONContent);
      }, AUTOSAVE_MS);
    },
    [save],
  );

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: false,
        link: { openOnClick: false, autolink: true },
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? '見出し' : "「/」でコマンド、「[[」でノートにリンク",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Details.configure({ persist: true, HTMLAttributes: { class: 'ev-details' } }),
      DetailsSummary,
      DetailsContent,
      PdfBlock,

      WikiLink.configure({
        suggestion: {
          char: '[[',
          allowSpaces: true,
          items: async ({ query }) => {
            try {
              const r = await api.get<{ pages: PageSummary[] }>(
                `/api/pages/search?q=${encodeURIComponent(query)}`,
              );
              const exact = r.pages.some((p) => p.title === query.trim());
              const list: (PageSummary | { id: '__new__'; title: string; icon: null })[] = [...r.pages];
              // Obsidian's affordance: linking to a page that does not exist yet
              // is a first-class action, not an error.
              if (query.trim() && !exact) {
                list.push({ id: '__new__', title: query.trim(), icon: null });
              }
              return list as PageSummary[];
            } catch {
              return [];
            }
          },
          command: ({ editor, range, props }) => {
            const item = props as PageSummary;
            const isNew = item.id === '__new__';
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent([
                {
                  type: 'wikiLink',
                  attrs: { title: item.title, pageId: isNew ? null : item.id },
                },
                { type: 'text', text: ' ' },
              ])
              .run();

            if (isNew) {
              // Create the target so the link resolves and shows up in the graph.
              void api
                .post<{ page: { id: string } }>('/api/pages', { title: item.title })
                .then(() => window.dispatchEvent(new CustomEvent('ev:pages-changed')));
            }
          },
          render: makeSuggestionRender<PageSummary>({
            empty: 'ノートが見つかりません',
            toItems: (props) =>
              props.items.map((p) => ({
                key: p.id,
                title: p.id === '__new__' ? `「${p.title}」を新規作成` : p.title || '無題',
                hint: p.id === '__new__' ? '新しいノートを作ってリンク' : undefined,
                leading: p.icon ? <span>{p.icon}</span> : <IconFile size={14} />,
              })),
          }),
        },
      }),

      SlashCommand.configure({
        suggestion: {
          char: '/',
          items: ({ query }) => filterSlashItems(query),
          command: ({ editor, range, props }) => (props as SlashItem).run({ editor, range }),
          render: makeSuggestionRender<SlashItem>({
            empty: 'コマンドが見つかりません',
            toItems: (props) =>
              props.items.map((item) => ({
                key: item.title,
                title: item.title,
                hint: item.hint,
              })),
          }),
        },
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: initialDoc,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'ev-prose', spellcheck: 'false' },
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files ?? []);
        const pdf = files.find((f) => f.type === 'application/pdf');
        if (!pdf) return false;
        event.preventDefault();
        void uploadPdf(pdf);
        return true;
      },
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        const pdf = files.find((f) => f.type === 'application/pdf');
        if (!pdf) return false;
        event.preventDefault();
        void uploadPdf(pdf);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => scheduleSave(ed),
  });

  editorRef.current = editor ?? null;

  const uploadPdf = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('pageId', pageId);
      const res = await fetch('/api/attachments', { method: 'POST', body: form });
      if (!res.ok) {
        alert('PDFのアップロードに失敗しました');
        return;
      }
      const { attachment } = (await res.json()) as { attachment: { id: string; filename: string } };
      editorRef.current
        ?.chain()
        .focus()
        .insertContent({
          type: 'pdfAttachment',
          attrs: { attachmentId: attachment.id, filename: attachment.filename },
        })
        .run();
      if (editorRef.current) void save(editorRef.current.getJSON() as JSONContent);
    },
    [pageId, save],
  );

  // The "/PDFを添付" command asks the shell to open the picker.
  useEffect(() => {
    const handler = () => fileInput.current?.click();
    window.addEventListener('ev:request-pdf-upload', handler);
    return () => window.removeEventListener('ev:request-pdf-upload', handler);
  }, []);

  // Clicking a wikilink navigates; an unresolved one creates the page first.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest('a[data-wikilink]');
      if (!anchor) return;
      event.preventDefault();
      const pageIdAttr = anchor.getAttribute('data-page-id');
      const title = anchor.getAttribute('data-title') ?? '';
      if (pageIdAttr) {
        router.push(`/p/${pageIdAttr}`);
        return;
      }
      void api
        .post<{ page: { id: string } }>('/api/pages', { title })
        .then(({ page }) => {
          window.dispatchEvent(new CustomEvent('ev:pages-changed'));
          router.push(`/p/${page.id}`);
        });
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor, router]);

  // Flush pending work on unmount so navigating away never loses a keystroke.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) void save(ed.getJSON() as JSONContent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ev-editor relative">
      {editor && (
        <DragHandle editor={editor}>
          <div className="flex items-center gap-0.5 pr-1">
            <button
              className="rounded p-0.5 hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-faint)' }}
              title="下に段落を追加"
              onClick={() => editor.chain().focus().insertContentAt(editor.state.selection.to, { type: 'paragraph' }).run()}
            >
              <IconPlus size={15} />
            </button>
            <span
              className="cursor-grab rounded p-0.5 active:cursor-grabbing"
              style={{ color: 'var(--text-faint)' }}
              title="ドラッグして移動"
            >
              <IconMore size={15} />
            </span>
          </div>
        </DragHandle>
      )}

      <EditorContent editor={editor} />

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadPdf(file);
          e.target.value = '';
        }}
      />

      <span
        className="pointer-events-none fixed bottom-4 right-5 text-[11.5px] transition-opacity"
        style={{ color: 'var(--text-faint)', opacity: saving ? 1 : 0 }}
      >
        保存中…
      </span>
    </div>
  );
}
