import { normalizeFold } from './normalize';

/**
 * Hiragana, katakana, CJK ideographs (incl. Extension A and compatibility),
 * the iteration marks 々〆 and the long-vowel mark ー.
 */
const CJK =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆ー]/;

const LATIN = /[0-9a-z_]/;

/**
 * Turn text into index tokens:
 *   - runs of CJK become overlapping 2-grams   東京都 -> 東京 京都
 *     (a lone CJK character is emitted as-is)
 *   - runs of latin/digits stay whole words    tokyo  -> tokyo
 *   - everything else is a separator
 *
 * Overlapping bigrams plus FTS5 phrase matching give substring semantics, so a
 * 2-character query — the case trigram cannot serve at all — hits the index
 * directly instead of falling back to a table scan.
 *
 * Iterate by codepoint (for..of) so surrogate pairs, and therefore rare kanji,
 * are never split in half.
 */
export function ngram(input: string): string[] {
  const text = normalizeFold(input);
  const tokens: string[] = [];
  let cjk = '';
  let latin = '';

  const flushCjk = () => {
    if (!cjk) return;
    const chars = [...cjk];
    if (chars.length === 1) tokens.push(chars[0]);
    else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    cjk = '';
  };
  const flushLatin = () => {
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
  };

  for (const ch of text) {
    if (CJK.test(ch)) {
      flushLatin();
      cjk += ch;
    } else if (LATIN.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return tokens;
}

/** Index-ready form: the token stream as a space-separated string. */
export function ngramText(input: string): string {
  return ngram(input).join(' ');
}

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}
