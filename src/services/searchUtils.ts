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
