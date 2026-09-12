import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';

export const slashPluginKey = new PluginKey('slashCommand');

export type SlashItem = {
  title: string;
  hint: string;
  keywords: string[];
  run: (ctx: { editor: Editor; range: Range }) => void;
};

/** The block palette opened with "/". Labels are Japanese, keywords match both. */
export const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'テキスト',
    hint: '本文の段落',
    keywords: ['text', 'p', 'paragraph', 'honbun', 'ほんぶん'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('paragraph').run(),
  },
  {
    title: '見出し 1',
    hint: '大見出し',
    keywords: ['h1', 'heading', 'midashi', 'みだし'],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: '見出し 2',
    hint: '中見出し',
    keywords: ['h2', 'heading', 'midashi', 'みだし'],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: '見出し 3',
    hint: '小見出し',
    keywords: ['h3', 'heading', 'midashi', 'みだし'],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: '箇条書き',
    hint: '順序なしリスト',
    keywords: ['bullet', 'ul', 'list', 'kajougaki', 'かじょう'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: '番号付きリスト',
    hint: '順序付きリスト',
    keywords: ['ordered', 'ol', 'number', 'bangou', 'ばんごう'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'ToDo リスト',
    hint: 'チェックボックス',
    keywords: ['todo', 'task', 'check', 'ちぇっく', 'たすく'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'トグル',
    hint: '折りたたみブロック',
    keywords: ['toggle', 'details', 'fold', 'とぐる', 'おりたたみ'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).setDetails().run(),
  },
  {
    title: '引用',
    hint: '引用ブロック',
    keywords: ['quote', 'blockquote', 'inyou', 'いんよう'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'コード',
    hint: 'シンタックスハイライト付き',
    keywords: ['code', 'pre', 'こーど'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'テーブル',
    hint: '3x3の表',
    keywords: ['table', 'grid', 'てーぶる', 'ひょう'],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: '区切り線',
    hint: '水平線',
    keywords: ['divider', 'hr', 'rule', 'くぎり'],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'PDFを添付',
    hint: 'アップロードして全文検索対象に',
    keywords: ['pdf', 'file', 'upload', 'attach', 'ぴーでぃーえふ', 'てんぷ'],
    run: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      // Handled by the editor shell, which owns the file input and upload.
      window.dispatchEvent(new CustomEvent('ev:request-pdf-upload'));
    },
  },
  {
    title: 'ノートへのリンク',
    hint: '[[ でも呼び出せます',
    keywords: ['link', 'wiki', 'ref', 'りんく'],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent('[[').run(),
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}

export const SlashCommand = Extension.create<{
  suggestion: Omit<SuggestionOptions, 'editor'>;
}>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        pluginKey: slashPluginKey,
        command: ({ editor, range, props }) => {
          (props as SlashItem).run({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});
