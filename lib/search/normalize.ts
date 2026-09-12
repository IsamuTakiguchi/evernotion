/**
 * Text normalisation shared by the index and the query path. Both sides MUST
 * call the same function: SQLite's unicode61 tokenizer case-folds ASCII but
 * does NOT apply NFKC, so without this ＴＯＫＹＯ and TOKYO are different tokens
 * and half-width ｶﾀｶﾅ never matches カタカナ.
 */

const ZERO_WIDTH = /[​-‍﻿­]/g;

export function normalize(input: string): string {
  return input
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lowercase without changing the string's length.
 *
 * String.toLowerCase() is not length-preserving for a few codepoints
 * (ß→ss, İ→i̇). Snippet offsets are computed against the folded text and
 * applied to the original, so a length change there would silently
 * mis-slice every excerpt after it.
 */
export function foldCase(input: string): string {
  let out = '';
  for (const ch of input) {
    const lower = ch.toLowerCase();
    out += [...lower].length === [...ch].length ? lower : ch;
  }
  return out;
}

export function normalizeFold(input: string): string {
  return foldCase(normalize(input));
}
