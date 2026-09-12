import { mergeAttributes, Node } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';

export const wikiLinkPluginKey = new PluginKey('wikiLinkSuggestion');

export type WikiLinkAttrs = {
  title: string;
  pageId: string | null;
};

/**
 * An Obsidian-style [[wikilink]] as an inline atom.
 *
 * Kept as a node rather than a mark so the title stays a single editable unit
 * and the server can find every link with one JSON walk. renderText() emits
 * `[[Title]]` so copied text and the derived search body both round-trip.
 */
export const WikiLink = Node.create<{
  suggestion: Omit<SuggestionOptions, 'editor'>;
  onNavigate?: (attrs: WikiLinkAttrs) => void;
}>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      suggestion: {
        char: '[[',
        startOfLine: false,
        allowSpaces: true,
        pluginKey: wikiLinkPluginKey,
      },
      onNavigate: undefined,
    };
  },

  addAttributes() {
    return {
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-id'),
        renderHTML: (attrs) => (attrs.pageId ? { 'data-page-id': attrs.pageId as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-wikilink]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const pageId = node.attrs.pageId as string | null;
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-wikilink': '',
        // Unresolved links render muted and dashed, the way Obsidian shows them.
        'data-unresolved': pageId ? 'false' : 'true',
        class: 'ev-wikilink',
        href: pageId ? `/p/${pageId}` : '#',
      }),
      `${node.attrs.title as string}`,
    ];
  },

  renderText({ node }) {
    return `[[${node.attrs.title as string}]]`;
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
