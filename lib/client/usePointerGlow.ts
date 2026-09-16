'use client';

import { useCallback, useRef } from 'react';

/**
 * A highlight on a glass surface that follows the pointer.
 *
 * Returns props to spread onto the element. It writes two custom properties —
 * `--mx` and `--my` — which `.ev-glass-glow` reads; the element needs that
 * class for anything to show, and without this hook the class falls back to a
 * position off the top edge, where it is invisible.
 *
 * The write is deferred to the next frame. Pointer moves arrive far faster
 * than frames, and setting a property that triggers a repaint on every one of
 * them is how a decoration starts costing more than the thing it decorates.
 */
export function usePointerGlow() {
  const frame = useRef<number | null>(null);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const { clientX, clientY } = e;
    if (frame.current !== null) return;

    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const box = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${clientX - box.left}px`);
      el.style.setProperty('--my', `${clientY - box.top}px`);
    });
  }, []);

  const onPointerEnter = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.dataset.glow = 'on';
  }, []);

  const onPointerLeave = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    delete el.dataset.glow;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  return { onPointerMove, onPointerEnter, onPointerLeave };
}
