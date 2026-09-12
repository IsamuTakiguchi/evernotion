'use client';

import { createRoot, type Root } from 'react-dom/client';
import { createRef, type RefObject } from 'react';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { SuggestionPopup, type PopupHandle, type PopupItem } from './SuggestionPopup';

type RenderArgs<T> = {
  toItems: (props: SuggestionProps<T>) => PopupItem[];
  empty?: string;
};

/**
 * Glue between Tiptap's imperative suggestion API and a React popup.
 *
 * Positions with floating-ui against a virtual element built from the caret
 * rect — no tippy.js, which Tiptap v3 dropped and which is unmaintained.
 */
export function makeSuggestionRender<T>({
  toItems,
  empty,
}: RenderArgs<T>): SuggestionOptions<T>['render'] {
  return () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;
    let handleRef: RefObject<PopupHandle | null> = createRef<PopupHandle>();

    const place = (props: SuggestionProps<T>) => {
      if (!container) return;
      const rect = props.clientRect?.();
      if (!rect) return;
      const virtual = {
        getBoundingClientRect: () => rect,
      };
      computePosition(virtual, container, {
        placement: 'bottom-start',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (!container) return;
        Object.assign(container.style, { left: `${x}px`, top: `${y}px` });
      });
    };

    const draw = (props: SuggestionProps<T>) => {
      if (!root) return;
      const items = toItems(props);
      root.render(
        <SuggestionPopup
          ref={handleRef}
          items={items}
          empty={empty}
          onSelect={(i) => props.command(props.items[i] as T)}
        />,
      );
    };

    return {
      onStart: (props) => {
        container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.zIndex = '60';
        container.style.top = '0';
        container.style.left = '0';
        document.body.appendChild(container);
        root = createRoot(container);
        handleRef = createRef<PopupHandle>();
        draw(props);
        place(props);
      },
      onUpdate: (props) => {
        draw(props);
        place(props);
      },
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') return false;
        return handleRef.current?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        const dyingRoot = root;
        const dyingContainer = container;
        root = null;
        container = null;
        // Unmount out of band: React forbids unmounting during its own render.
        queueMicrotask(() => {
          dyingRoot?.unmount();
          dyingContainer?.remove();
        });
      },
    };
  };
}
