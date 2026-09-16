'use client';

import { useEffect, useImperativeHandle, useState, forwardRef } from 'react';

export type PopupItem = {
  key: string;
  title: string;
  hint?: string;
  leading?: React.ReactNode;
};

export type PopupHandle = {
  /** Returns true when the key was consumed, so the editor does not also act. */
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type Props = {
  items: PopupItem[];
  onSelect: (index: number) => void;
  empty?: string;
};

/**
 * Keyboard-navigable list shared by the "/" menu and the "[[" menu.
 *
 * Enter is deliberately ignored while an IME composition is active: at that
 * moment Enter belongs to the candidate window, and consuming it would commit
 * the wrong thing and swallow the user's conversion.
 */
export const SuggestionPopup = forwardRef<PopupHandle, Props>(function SuggestionPopup(
  { items, onSelect, empty = '該当なし' },
  ref,
) {
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.key === 'ArrowDown') {
        setActive((i) => (items.length ? (i + 1) % items.length : 0));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!items.length) return false;
        onSelect(active);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div
        className="ev-glass-raised ev-glass-edge ev-anim-pop w-64 rounded-xl border px-3 py-2.5 text-[13px]"
        style={{ color: 'var(--text-faint)' }}
      >
        {empty}
      </div>
    );
  }

  // No ev-glass-edge on this one: it scrolls, and a ring positioned against
  // the padding box of a scroll container scrolls away with the content.
  return (
    <div className="ev-glass-raised ev-anim-pop max-h-72 w-72 overflow-y-auto rounded-xl border py-1">
      {items.map((item, i) => (
        <button
          key={item.key}
          onMouseEnter={() => setActive(i)}
          onClick={() => onSelect(i)}
          className={`ev-row flex w-full items-center gap-2.5 px-3 py-1.5 text-left${
            i === active ? ' ev-selected' : ''
          }`}
        >
          {item.leading}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px]">{item.title}</span>
            {item.hint && (
              <span className="block truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                {item.hint}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
});
