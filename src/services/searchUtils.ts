export function mergeHybridSearchScores<T extends { _id: unknown }>(
  textMatches: T[],
  semanticMatches: Array<{ item: T; score: number }>,
  getId: (item: T) => string
): Array<{ item: T; score: number }> {
  const merged = new Map<string, { item: T; score: number }>();

  for (const [index, item] of textMatches.entries()) {
    merged.set(getId(item), { item, score: 1 - index * 0.01 });
  }

  for (const { item, score } of semanticMatches) {
    const id = getId(item);
    const existing = merged.get(id);
    merged.set(id, {
      item,
      score: existing ? existing.score + score : score,
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lexical relevance, replacing MongoDB's `$text` index.
 *
 * `$text` has no equivalent on KDB, and a backend-specific lexical arm would mean the
 * two backends rank the same query differently — which no conformance test could
 * assert away. So scoring moves here, where both use it.
 *
 * This is deliberately simpler than Mongo's: it lowercases and splits on
 * non-alphanumerics, and does no stemming, so "deploying" no longer matches "deploy".
 * That is a real quality loss on the Mongo path, taken knowingly in exchange for the
 * two backends agreeing. Scoring is term frequency across weighted fields, normalized
 * by field length so a long description cannot outrank a title.
 */
export function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
}

export interface TextField {
  path: string;
  weight: number;
}

/** Score one document against the query terms, or 0 when it matches none of them. */
export function lexicalScore(
  values: Array<{ text: string; weight: number }>,
  terms: string[]
): number {
  if (terms.length === 0) return 0;
  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    let termScore = 0;
    for (const { text, weight } of values) {
      const tokens = tokenizeForSearch(text);
      if (tokens.length === 0) continue;
      const hits = tokens.filter((token) => token === term || token.startsWith(term)).length;
      if (hits > 0) termScore += (weight * hits) / Math.sqrt(tokens.length);
    }
    if (termScore > 0) {
      matchedTerms++;
      score += termScore;
    }
  }

  // A document matching every term beats one matching a single term often — the
  // property `$text`'s per-term OR with coordination gave for free.
  return matchedTerms === 0 ? 0 : score * (matchedTerms / terms.length);
}
