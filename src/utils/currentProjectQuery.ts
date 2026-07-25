export function isCurrentProjectQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  if (/\b(list|all|every)\b[\s\S]*\bprojects?\b/i.test(text)) return false;
  if (/\bprojects?\b[\s\S]*\b(list|all|every)\b/i.test(text)) return false;
  if (/\bhow many projects?\b/i.test(text)) return false;

  if (/\b(current|this|my)\s+project\b/i.test(text)) return true;
  if (/\bwhat project am i on\b/i.test(text)) return true;
  if (/\bshow me the project\b/i.test(text)) return true;
  if (/\bshow(?: me)?(?: the)? current project\b/i.test(text)) return true;

  return false;
}
