import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = dirname(fileURLToPath(import.meta.url));

export type AgentContextMode = 'web' | 'mcp';

export function loadAgentContext(mode: AgentContextMode = 'web'): string {
  const file = mode === 'mcp' ? 'context-mcp.md' : 'context.md';
  const contextPath = join(agentDir, file);
  return readFileSync(contextPath, 'utf-8').trim();
}

export function loadMcpPromptWithProject(projectName: string, projectId: string): string {
  const base = loadAgentContext('mcp');
  return `${base}\n\nActive project: "${projectName}" (projectId: ${projectId}). When the user asks about the current project, use get_project or summarize_project with this projectId.`;
}
