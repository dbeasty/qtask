import { isCurrentProjectQuery } from './currentProjectQuery.js';
import { isListProjectsQuery } from './listProjectsQuery.js';

const CREATE_PROJECT_PREFIX =
  /^(?:add|create|make|new)\s+(?:a\s+)?(?:new\s+)?(?:sub-?\s*project|project)\s*(?:to\s+|called\s+|named\s+|:\s*|for\s+|under\s+(?:this\s+)?(?:project\s+)?)?/i;

const SUB_PROJECT_PREFIX =
  /^(?:add|create|make|new)\s+(?:a\s+)?(?:new\s+)?sub-?\s*projects?\b/i;

const QUOTED_NAME = /^(?:add|create|make|new)\s+(?:a\s+)?(?:sub-?\s*project|project)\s+"([^"]+)"/i;

const HOW_TO_PATTERN =
  /^(?:how|what|where|when|why|can\s+i|help\s+me|explain|tell\s+me)\b/i;

/** One message requesting project + sub-project or project + tasks → LLM, not preflight. */
const COMPOUND_CREATE_PATTERN = /\band\s+(?:sub-?\s*project|add\s+tasks?)\b/i;

export type ProjectCreateScope = {
  parentId: string | null;
  isSubProject: boolean;
};

export function extractCreateProjectName(message: string): string | null {
  const text = message.trim();
  if (!text) return null;

  const quoted = text.match(QUOTED_NAME);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }

  const withoutPrefix = text.replace(CREATE_PROJECT_PREFIX, '').trim();
  if (!withoutPrefix || withoutPrefix === text) {
    return null;
  }

  return withoutPrefix.replace(/^["']|["']$/g, '').trim() || null;
}

export function resolveProjectCreateScope(
  message: string,
  activeProjectId?: string
): ProjectCreateScope {
  const text = message.trim();
  const isSubProject =
    SUB_PROJECT_PREFIX.test(text) ||
    /\bunder\s+(?:this\s+)?(?:project|current\s+project)\b/i.test(text);

  if (isSubProject && activeProjectId) {
    return { parentId: activeProjectId, isSubProject: true };
  }

  return { parentId: null, isSubProject: false };
}

export function isCreateProjectQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (HOW_TO_PATTERN.test(text)) return false;
  if (COMPOUND_CREATE_PATTERN.test(text)) return false;
  if (isListProjectsQuery(text) || isCurrentProjectQuery(text)) return false;

  const name = extractCreateProjectName(text);
  if (!name) return false;

  return CREATE_PROJECT_PREFIX.test(text) || QUOTED_NAME.test(text);
}
