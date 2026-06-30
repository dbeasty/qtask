import { KNOWN_TOOL_NAMES } from './toolPolicy.js';
import { normalizeToolArgs } from './tools.js';

export interface ParsedTextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const toolNamePattern = KNOWN_TOOL_NAMES.join('|');

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not valid JSON
  }
  return null;
}

/** Extract JSON objects from free text using balanced-brace scanning (handles nested subtasks). */
function extractJsonObjects(content: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < content.length; j++) {
      const char = content[j]!;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          const obj = tryParseJsonObject(content.slice(i, j + 1));
          if (obj) results.push(obj);
          break;
        }
      }
    }
  }

  return results;
}

function extractToolFromObject(obj: Record<string, unknown>): ParsedTextToolCall | null {
  const name =
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.function === 'object' &&
      obj.function !== null &&
      typeof (obj.function as Record<string, unknown>).name === 'string' &&
      ((obj.function as Record<string, unknown>).name as string)) ||
    null;

  if (!name || !KNOWN_TOOL_NAMES.includes(name as (typeof KNOWN_TOOL_NAMES)[number])) {
    return null;
  }

  let args: Record<string, unknown> = {};

  if (obj.parameters && typeof obj.parameters === 'object' && !Array.isArray(obj.parameters)) {
    args = { ...(obj.parameters as Record<string, unknown>) };
  } else if (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)) {
    args = { ...(obj.arguments as Record<string, unknown>) };
  } else if (
    obj.function &&
    typeof obj.function === 'object' &&
    (obj.function as Record<string, unknown>).arguments &&
    typeof (obj.function as Record<string, unknown>).arguments === 'object'
  ) {
    args = { ...((obj.function as Record<string, unknown>).arguments as Record<string, unknown>) };
  }

  return {
    name,
    arguments: normalizeToolArgs(name, args),
  };
}

const VALID_TASK_STATUSES = new Set(['todo', 'in_progress', 'done', 'cancelled']);

const STATUS_ALIASES: Record<string, string> = {
  todo: 'todo',
  to_do: 'todo',
  in_progress: 'in_progress',
  'in progress': 'in_progress',
  done: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function normalizeMarkdownStatus(raw: string): string | undefined {
  const normalized = STATUS_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase().replace(/\s+/g, '_');
  return VALID_TASK_STATUSES.has(normalized) ? normalized : undefined;
}

/** Detect markdown task blocks like **Task:** title with optional **Status:** and bullet subtasks. */
export function parseMarkdownTaskProposals(content: string): ParsedTextToolCall[] {
  const taskMatch = content.match(/\*{0,2}Task:\*{0,2}\s*(.+)/im);
  if (!taskMatch?.[1]?.trim()) return [];

  const title = taskMatch[1].trim();
  const args: Record<string, unknown> = { title };

  const statusMatch = content.match(/\*{0,2}Status:\*{0,2}\s*(.+?)(?:\n|$)/im);
  if (statusMatch?.[1]) {
    const status = normalizeMarkdownStatus(statusMatch[1]);
    if (status) args.status = status;
  }

  const subtasks: { title: string }[] = [];
  let afterTask = false;
  for (const line of content.split('\n')) {
    if (/\*{0,2}Task:\*{0,2}/i.test(line)) {
      afterTask = true;
      continue;
    }
    if (!afterTask) continue;
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch?.[1]) {
      subtasks.push({ title: bulletMatch[1].trim() });
    }
  }

  if (subtasks.length > 0) {
    args.subtasks = subtasks;
  }

  return [
    {
      name: 'create_task',
      arguments: normalizeToolArgs('create_task', args),
    },
  ];
}

function dedupeProposals(proposals: ParsedTextToolCall[]): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  const seen = new Set<string>();

  for (const parsed of proposals) {
    const key = `${parsed.name}:${JSON.stringify(parsed.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(parsed);
  }

  return results;
}

export function parseTextToolCalls(content: string): ParsedTextToolCall[] {
  const jsonResults: ParsedTextToolCall[] = [];

  for (const obj of extractJsonObjects(content)) {
    const parsed = extractToolFromObject(obj);
    if (parsed) jsonResults.push(parsed);
  }

  return dedupeProposals([...jsonResults, ...parseMarkdownTaskProposals(content)]);
}

export function contentRequestsApproval(content: string): boolean {
  return /review and approve|before I proceed|please approve|waiting for (?:your )?approval/i.test(
    content
  );
}

export function contentMentionsToolCall(content: string): boolean {
  const mentionRegex = new RegExp(
    `(?:calling|call|invoke|using)\\s+(?:the\\s+)?[\`'"]?(?:${toolNamePattern})[\`'"]?`,
    'i'
  );
  if (mentionRegex.test(content)) return true;
  return new RegExp(`"name"\\s*:\\s*"(${toolNamePattern})"`).test(content);
}
