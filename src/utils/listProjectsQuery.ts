import { isCurrentProjectQuery } from './currentProjectQuery.js';

export function isListProjectsQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (isCurrentProjectQuery(text)) return false;

  if (/\bhow many projects?\b/i.test(text)) return true;
  if (/\b(list|all|every)\b[\s\S]*\bprojects?\b/i.test(text)) return true;
  if (/\bprojects?\b[\s\S]*\b(list|all|every)\b/i.test(text)) return true;
  if (/\bwhat(?: are|'re)?(?: the| my)? projects?\b/i.test(text)) return true;
  if (/\bshow(?: me)?(?: all)?(?: my)? projects?\b/i.test(text)) return true;
  if (/\bwhich projects?\b/i.test(text)) return true;
  if (/\bprojects?\b[\s\S]*\bdo i have\b/i.test(text)) return true;

  return false;
}
