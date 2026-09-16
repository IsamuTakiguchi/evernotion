import { ViewTransition } from 'react';

/**
 * The crossfade between routes.
 *
 * Route changes are React transitions, so wrapping a page's content in this is
 * all it takes: the old page blurs out quickly and the new one arrives a beat
 * later, from slightly below. The animation itself is `.ev-page` in
 * globals.css, and `prefers-reduced-motion` switches it off there.
 *
 * It has to go in each page.tsx rather than in the layout. A layout survives
 * navigation — it is never mounted or unmounted — so enter and exit would
 * never fire from there.
 *
 * `default="none"` keeps it out of transitions it has nothing to do with: a
 * Suspense reveal or a router.refresh() should not slide the whole page.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="ev-page" exit="ev-page" default="none">
      {children}
    </ViewTransition>
  );
}
