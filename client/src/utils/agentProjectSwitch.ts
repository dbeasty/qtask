import type { Project, UiProposal } from '../types';

function unwrapQuotedName(name: string): string {
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))
  ) {
    return name.slice(1, -1).trim();
  }
  return name;
}

const SWITCH_COMMAND_PATTERNS = [
  /^change\s+active\s+project\s+to\s+(.+)$/i,
  /^set\s+active\s+project\s+to\s+(.+)$/i,
  /^switch\s+to\s+project\s+(.+)$/i,
  /^switch\s+project\s+to\s+(.+)$/i,
] as const;

export function parseActiveProjectSwitchCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const withoutTrailingPeriod = trimmed.replace(/\.$/, '');

  for (const pattern of SWITCH_COMMAND_PATTERNS) {
    const match = withoutTrailingPeriod.match(pattern);
    if (match?.[1]) {
      const name = unwrapQuotedName(match[1].trim());
      return name || undefined;
    }
  }

  return undefined;
}

export function findProjectByName(name: string, projects: Project[]): Project | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;

  const exactMatches = projects.filter((project) => project.name.toLowerCase() === normalized);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return undefined;

  const prefixMatches = projects.filter((project) =>
    project.name.toLowerCase().startsWith(normalized)
  );
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) return undefined;

  const containsMatches = projects.filter((project) =>
    project.name.toLowerCase().includes(normalized)
  );
  if (containsMatches.length === 1) return containsMatches[0];

  return undefined;
}

export function shouldOfferSwitchAfterCreateProject(
  proposal: UiProposal,
  activeProjectId: string | null,
  action: 'approve' | 'reject'
): string | undefined {
  if (action !== 'approve') return undefined;
  if (proposal.name !== 'create_project') return undefined;
  const id = proposal.stagedEntity?.kind === 'project' ? proposal.stagedEntity.id : undefined;
  if (!id || id === activeProjectId) return undefined;
  return id;
}

export function projectNameFromProposal(proposal: UiProposal): string | undefined {
  const name = proposal.arguments.name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

export function projectForSwitchPrompt(
  id: string,
  name: string,
  projects: Project[]
): Project {
  const existing = projects.find((project) => project._id === id);
  if (existing) return existing;

  const now = new Date().toISOString();
  return {
    _id: id,
    name,
    createdAt: now,
    updatedAt: now,
  };
}
