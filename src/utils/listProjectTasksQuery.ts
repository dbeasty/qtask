const CREATE_PREFIX = /^(?:add|create|make|new)\s+/i;

const SUMMARY_WITHOUT_LIST =
  /\b(summarize|summary|digest|status|progress|overview)\b/i;

export function isListProjectTasksQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (CREATE_PREFIX.test(text)) return false;
  if (!/\b(tasks?|to-?dos?)\b/i.test(text)) return false;
  if (SUMMARY_WITHOUT_LIST.test(text) && !/\blist\b/i.test(text)) return false;

  if (/\b(show|list|what|which|current|my|open)\b[\s\S]*\btasks?\b/i.test(text)) return true;
  if (/\btasks?\b[\s\S]*\b(on|in|for|current|this|my|here|project)\b/i.test(text)) return true;
  if (/\b(show|list)(?: me)?(?: the)?(?: current)? tasks?\b/i.test(text)) return true;

  return false;
}
