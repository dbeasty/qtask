import { estimateRequestedCreateCount } from '../agent/multiCreateHeuristic.js';
import { isCurrentProjectQuery } from './currentProjectQuery.js';
import { isListProjectsQuery } from './listProjectsQuery.js';

const CREATE_TASK_PREFIX =
  /^(?:add|create|make|new)\s+(?:a\s+)?(?:new\s+)?tasks?\s*(?:to\s+|called\s+|named\s+|:\s*|for\s+)?/i;

const QUOTED_TITLE = /^(?:add|create|make|new)\s+(?:a\s+)?tasks?\s+"([^"]+)"/i;

const HOW_TO_PATTERN =
  /^(?:how|what|where|when|why|can\s+i|help\s+me|explain|tell\s+me)\b/i;

/** Multi-create commands only — do not treat "and" inside a task title as multi-create. */
const MULTI_CREATE_COMMAND =
  /^(?:add|create|make|new)\s+(?:the\s+)?(?:following\s+)?tasks\s*[:]/i;

export function isMultiCreateTaskQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (MULTI_CREATE_COMMAND.test(text)) return true;
  if (estimateRequestedCreateCount(text) > 1 && /\btasks\b/i.test(text) && !/\btask\s+(?:to|called|named|for)\b/i.test(text)) {
    return true;
  }
  const listItems = text.split('\n').filter((line) => /^\s*(\d+[.)]|[-*])\s+/.test(line));
  return listItems.length > 1;
}

export function extractCreateTaskTitle(message: string): string | null {
  const text = message.trim();
  if (!text) return null;

  const quoted = text.match(QUOTED_TITLE);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }

  const withoutPrefix = text.replace(CREATE_TASK_PREFIX, '').trim();
  if (!withoutPrefix || withoutPrefix === text) {
    return null;
  }

  return withoutPrefix.replace(/^["']|["']$/g, '').trim() || null;
}

export function isCreateTaskQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (HOW_TO_PATTERN.test(text)) return false;
  if (isListProjectsQuery(text) || isCurrentProjectQuery(text)) return false;
  if (isMultiCreateTaskQuery(text)) return false;

  const title = extractCreateTaskTitle(text);
  if (!title) return false;

  return CREATE_TASK_PREFIX.test(text) || QUOTED_TITLE.test(text);
}
