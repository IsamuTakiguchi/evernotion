import { ngram, isCjk } from './ngram';
import { normalizeFold } from './normalize';

export type ParsedQuery = {
  /** FTS5 MATCH expression, or null when the query has nothing indexable. */
  match: string | null;
  /** Positive terms, for snippet highlighting. */
  terms: string[];
  tag: string | null;
  kind: 'page' | 'pdf' | null;
  /** Raw remainder, used by the LIKE path when match is null. */
  rest: string;
};

/**
 * FTS5 string literals use DOUBLE quotes; a single-quoted literal is a syntax
 * error. An embedded quote is escaped by doubling it.
 */
function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build the MATCH expression for one search term.
 *   単一          -> "単"*            (1 CJK char: prefix over bigrams)
 *   東京          -> "東京"           (single bigram)
 *   機械学習      -> "機械 械学 学習" (phrase: adjacency == substring)
 *   tokyo         -> "tokyo"          (whole latin word)
 */
function termToMatch(term: string, { prefix = false } = {}): string | null {
  const tokens = ngram(term);
  if (tokens.length === 0) return null;

  if (tokens.length === 1) {
    const single = tokens[0];
    // A lone CJK character has no bigram to match, so match it as a prefix.
    if ([...single].length === 1 && isCjk(single)) return `${quote(single)}*`;
    if (prefix) return `${quote(single)}*`;
    return quote(single);
  }
  return quote(tokens.join(' '));
}

/** Split on whitespace while keeping "quoted phrases" together. */
function splitTerms(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const term = (m[1] ?? m[2] ?? '').trim();
    if (term) out.push(term);
  }
  return out;
}

export type ParseOptions = {
  /** Let the final latin term match as a prefix, for as-you-type search. */
  live?: boolean;
};

export function parseQuery(raw: string, opts: ParseOptions = {}): ParsedQuery {
  let rest = raw.trim();
  let tag: string | null = null;
  let kind: 'page' | 'pdf' | null = null;

  // Operators are pulled out before anything reaches the tokenizer.
  rest = rest.replace(/(?:^|\s)tag:(\S+)/gi, (_, t: string) => {
    tag = normalizeFold(t);
    return ' ';
  });
  rest = rest.replace(/(?:^|\s)(?:kind|type):(page|pdf|note)\b/gi, (_, k: string) => {
    kind = k.toLowerCase() === 'pdf' ? 'pdf' : 'page';
    return ' ';
  });
  rest = rest.trim();

  const rawTerms = splitTerms(rest);
  const positives: string[] = [];
  const negatives: string[] = [];
  const terms: string[] = [];

  rawTerms.forEach((term, i) => {
    const negated = term.startsWith('-') && term.length > 1;
    const body = negated ? term.slice(1) : term;
    const isLast = i === rawTerms.length - 1;
    const match = termToMatch(body, { prefix: !!opts.live && isLast });
    if (!match) return;
    if (negated) negatives.push(match);
    else {
      positives.push(match);
      terms.push(body);
    }
  });

  if (positives.length === 0) {
    return { match: null, terms: [], tag, kind, rest };
  }

  let match = positives.join(' AND ');
  if (negatives.length) match += ` NOT ${negatives.join(' NOT ')}`;
  return { match, terms, tag, kind, rest };
}
