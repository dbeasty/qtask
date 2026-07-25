/** True when two names are similar enough to show as a duplicate-avoidance hint (not exact match). */
export function isSimilarName(candidate: string, reference: string): boolean {
  const a = candidate.trim().toLowerCase();
  const b = reference.trim().toLowerCase();
  if (!a || !b || a === b) return false;

  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;

  const tokenize = (value: string) =>
    value.split(/[\s\-_/]+/).filter((word) => word.length >= 3);
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  return wordsA.some((word) => wordsB.includes(word));
}
