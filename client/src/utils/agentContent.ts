import type { UiMessage } from '../types';

const toolNamePattern =
  'find_tasks|get_task|get_workload|summarize_project|list_projects|create_task|update_task|create_project|assign_task|share_project|share_task|add_task_link';

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

function isToolJsonObject(obj: Record<string, unknown>): boolean {
  const name =
    (typeof obj.name === 'string' && obj.name) ||
    (typeof obj.function === 'object' &&
      obj.function !== null &&
      typeof (obj.function as Record<string, unknown>).name === 'string' &&
      ((obj.function as Record<string, unknown>).name as string)) ||
    null;
  return name !== null && new RegExp(`^(${toolNamePattern})$`).test(name);
}

function findToolJsonRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

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
          const slice = content.slice(i, j + 1);
          const obj = tryParseJsonObject(slice);
          if (obj && isToolJsonObject(obj)) {
            ranges.push({ start: i, end: j + 1 });
          }
          break;
        }
      }
    }
  }

  return ranges;
}

function stripMarkdownTaskBlocks(content: string): string {
  if (!/(?:^|\n)\s*\*{0,2}Task:\*{0,2}/im.test(content)) return content;

  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (/^\s*\*{0,2}Task:\*{0,2}/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s*$/.test(line)) {
        skipping = false;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line) || /\*{0,2}Status:\*{0,2}/i.test(line)) {
        continue;
      }
      skipping = false;
    }
    result.push(line);
  }

  return result.join('\n');
}

export function stripToolArtifactsFromContent(content: string): string {
  let result = content;
  const ranges = findToolJsonRanges(content);

  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    result = result.slice(0, range.start) + result.slice(range.end);
  }

  result = stripMarkdownTaskBlocks(result);
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

export function displayMessageContent(message: UiMessage): string {
  let content = message.content;
  if ((message.proposals?.length ?? 0) > 0) {
    content = stripToolArtifactsFromContent(content);
  }
  return content.trim();
}

export function proposalDisplayLabel(name: string): string {
  return name.replace(/_/g, ' ');
}
