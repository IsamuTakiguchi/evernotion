import { foldCase, normalize } from './normalize';

export type SnippetRun = { text: string; mark: boolean };

/**
 * Build an excerpt in JavaScript rather than with FTS5's snippet().
 *
 * snippet() would return the *n-gram* text ("機械 械学 学習"), which is
 * unreadable. search_docs.body holds the normalised original, so offsets found
 * against a length-preserving case fold of it can be applied directly.
 */
export function makeSnippet(body: string, terms: string[], radius = 70): SnippetRun[] {
  const text = body;
  if (!text) return [];
  if (terms.length === 0) return [{ text: text.slice(0, radius * 2), mark: false }];

  const folded = foldCase(text);
  const needles = terms.map((t) => foldCase(normalize(t))).filter(Boolean);

  // Anchor on the earliest match so the excerpt starts where the hit is.
  let anchor = -1;
  for (const needle of needles) {
    const at = folded.indexOf(needle);
    if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at;
  }
  if (anchor < 0) return [{ text: text.slice(0, radius * 2), mark: false }];

  const start = Math.max(0, anchor - radius);
  const end = Math.min(text.length, anchor + radius * 2);
  const window = text.slice(start, end);
  const windowFolded = folded.slice(start, end);

  // Collect every term hit inside the window, then merge overlaps.
  const spans: [number, number][] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = windowFolded.indexOf(needle, from);
      if (at < 0) break;
      spans.push([at, at + needle.length]);
      from = at + Math.max(1, needle.length);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span] as [number, number]);
  }

  const runs: SnippetRun[] = [];
  if (start > 0) runs.push({ text: '…', mark: false });
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) runs.push({ text: window.slice(cursor, from), mark: false });
    runs.push({ text: window.slice(from, to), mark: true });
    cursor = to;
  }
  if (cursor < window.length) runs.push({ text: window.slice(cursor), mark: false });
  if (end < text.length) runs.push({ text: '…', mark: false });

  return runs.filter((r) => r.text.length > 0);
}
