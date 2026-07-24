const MAX_ESTIMATED_CREATES = 5;

function countTaskItems(fragment: string): number {
  const parts = fragment
    .split(/\s*,\s*|\s*;\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return 0;
  return Math.min(parts.length, MAX_ESTIMATED_CREATES);
}

/** Estimate how many distinct tasks the user asked to create (0 = unknown / single). */
export function estimateRequestedCreateCount(userMessage: string): number {
  const text = userMessage.trim();
  if (!text) return 0;

  const multiTaskPrefix = text.match(
    /(?:add|create|make|new)\s+(?:the\s+)?(?:following\s+)?tasks?[:\s]+(.+)/i
  );
  if (multiTaskPrefix?.[1]) {
    const count = countTaskItems(multiTaskPrefix[1]);
    if (count > 0) return count;
  }

  if (/\btasks?\b/i.test(text)) {
    const afterTasks = text.match(/\btasks?\s+(.+)/i)?.[1];
    if (afterTasks) {
      const count = countTaskItems(afterTasks);
      if (count > 1) return count;
    }
  }

  const listItems = text
    .split('\n')
    .filter((line) => /^\s*(\d+[.)]|[-*])\s+/.test(line));
  if (listItems.length > 1) {
    return Math.min(listItems.length, MAX_ESTIMATED_CREATES);
  }

  return 0;
}

export function hasProposedAllRequestedCreates(
  userMessage: string,
  pending: Array<{ name: string; status: string }>
): boolean {
  const expected = estimateRequestedCreateCount(userMessage);
  if (expected <= 0) return false;
  const pendingCreates = pending.filter(
    (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
  );
  return pendingCreates.length >= expected;
}
