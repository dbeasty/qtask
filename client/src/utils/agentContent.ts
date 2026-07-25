import type { ToolEntityLink, UiMessage } from '../types';

const toolNamePattern =
  'find_tasks|get_task|get_workload|summarize_project|get_project|list_projects|create_task|update_task|create_project|assign_task|share_project|share_task|add_task_link';

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

const BOILERPLATE_PATTERNS = [
  /^here is the corrected task:?\s*$/i,
  /^here are the corrected tasks:?\s*$/i,
  /^corrected task:?\s*$/i,
];

export function isBoilerplateAssistantContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function messageEntityLinks(message: UiMessage): ToolEntityLink[] {
  const links: ToolEntityLink[] = [];
  for (const call of message.toolCalls ?? []) {
    if (call.entityLinks?.length) {
      links.push(...call.entityLinks);
    }
  }
  return links;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripReadToolDetailBlocks(content: string, entityLinks: ToolEntityLink[]): string {
  if (entityLinks.length === 0) return content;

  let result = content;
  const projectLinkCount = entityLinks.filter((link) => link.kind === 'project').length;

  for (const link of entityLinks) {
    const label = escapeRegExp(link.label);
    const kind = link.kind === 'project' ? 'Project' : 'Task';

    result = result.replace(
      new RegExp(
        `(?:^|\\n)\\s*\\*{0,2}${kind}:\\*{0,2}\\s*${label}[^\\n]*(?:\\n(?:\\s*[-*][^\\n]*|\\s*\\*{0,2}[^:\\n]+:\\*{0,2}[^\\n]*)*)*`,
        'gim'
      ),
      '\n'
    );

    result = result.replace(
      new RegExp(`(?:^|\\n)\\s*\\*{0,2}${label}\\*{0,2}\\s*\\(ID:\\s*\`[^\`]+\`\\)`, 'gim'),
      '\n'
    );

    result = result.replace(
      new RegExp(
        `(?:^|\\n)\\s*\\*{0,2}\\d+\\.\\s*\\*{0,2}[^*\\n]*${label}[^\\n]*`,
        'gim'
      ),
      '\n'
    );
  }

  const detailFieldPattern =
    /(?:\*\*)?(?:Status|Percent Complete|Description|Owner Email|Project|Task)(?:\*\*)?:/i;

  function isNumberedEntityLine(trimmed: string): boolean {
    return /\d+\.\s/.test(trimmed) && entityLinks.some((link) => trimmed.includes(link.label));
  }

  const lines = result.split('\n');
  const filtered: string[] = [];
  let skippingSubBullets = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isNumberedEntityLine(trimmed)) {
      skippingSubBullets = true;
      continue;
    }

    if (skippingSubBullets) {
      if (!trimmed) {
        skippingSubBullets = false;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        continue;
      }
      skippingSubBullets = false;
    }

    if (!trimmed) {
      filtered.push(line);
      continue;
    }

    if (
      /^[-*]\s+/.test(trimmed) &&
      (detailFieldPattern.test(trimmed) ||
        /(\*\*Status:\*\*|\*\*Percent Complete:\*\*|\*\*Description:\*\*|\*\*Owner Email:\*\*|\*\*Project:\*\*|\*\*Task:\*\*)/i.test(
          trimmed
        ))
    ) {
      continue;
    }
    if (/^\*\*Status:\*\*/i.test(trimmed)) continue;
    if (/^\*\*Percent Complete:\*\*/i.test(trimmed)) continue;
    if (/^\*\*Description:\*\*/i.test(trimmed)) continue;
    if (/^\*\*Owner Email:\*\*/i.test(trimmed)) continue;
    if (/^\*\*Project:\*\*/i.test(trimmed) && entityLinks.some((link) => trimmed.includes(link.label))) {
      continue;
    }
    if (
      projectLinkCount > 1 &&
      (/^all .+ projects? are\b/i.test(trimmed) || /^all projects? are owned\b/i.test(trimmed))
    ) {
      continue;
    }

    filtered.push(line);
  }

  result = filtered.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

export function displayMessageContent(message: UiMessage): string {
  let content = message.content;
  const entityLinks = messageEntityLinks(message);

  if ((message.proposals?.length ?? 0) > 0) {
    content = stripToolArtifactsFromContent(content);
    if (isBoilerplateAssistantContent(content)) {
      return '';
    }
  }

  if (entityLinks.length > 0) {
    content = stripReadToolDetailBlocks(content, entityLinks);
    content = stripToolArtifactsFromContent(content);
  }

  return content.trim();
}

export function proposalDisplayLabel(name: string): string {
  return name.replace(/_/g, ' ');
}
