import {
  AGENT_INSTRUCTIONS,
  type AgentInstruction,
} from '../../../src/agent/agentInstructions.ts';

export type AgentCommandPaletteItem = {
  id: string;
  goal: string;
  example: string;
  searchText: string;
};

export const AGENT_INPUT_IDLE_PLACEHOLDER =
  'Describe your action, or type / for commands…';

export const COMMAND_PALETTE_HINT = 'Type to filter · ↑↓ navigate · Enter to insert';

function normalizeSearchText(parts: string[]): string {
  return parts.join(' ').toLowerCase();
}

export function buildAgentCommandPaletteItems(
  instructions: AgentInstruction[] = AGENT_INSTRUCTIONS
): AgentCommandPaletteItem[] {
  return instructions.map((instruction) => ({
    id: instruction.id,
    goal: instruction.goal,
    example: instruction.example,
    searchText: normalizeSearchText([
      instruction.id,
      instruction.goal,
      instruction.example,
      ...(instruction.alsoAccepts ?? []),
    ]),
  }));
}

export function parseSlashCommand(input: string): { query: string } | null {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith('/')) return null;
  return { query: trimmedStart.slice(1).trimStart().toLowerCase() };
}

export function isCommandPaletteOpen(input: string): boolean {
  return parseSlashCommand(input) !== null;
}

export function filterAgentCommandPaletteItems(
  items: AgentCommandPaletteItem[],
  query: string
): AgentCommandPaletteItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => item.searchText.includes(normalized));
}

export function applyInstructionSelection(item: AgentCommandPaletteItem): string {
  return item.example;
}

export function clampPaletteHighlightIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  if (index < 0) return itemCount - 1;
  if (index >= itemCount) return 0;
  return index;
}

export type CommandPaletteKeyAction =
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'accept' }
  | { type: 'close' }
  | { type: 'pass' };

export function resolveCommandPaletteKeyDown(
  key: string,
  options: {
    paletteOpen: boolean;
    hasItems: boolean;
    hasHighlight: boolean;
  }
): CommandPaletteKeyAction {
  if (!options.paletteOpen) return { type: 'pass' };

  if (key === 'ArrowDown') return { type: 'move', delta: 1 };
  if (key === 'ArrowUp') return { type: 'move', delta: -1 };
  if (key === 'Escape') return { type: 'close' };
  if ((key === 'Enter' || key === 'Tab') && options.hasItems && options.hasHighlight) {
    return { type: 'accept' };
  }

  return { type: 'pass' };
}
