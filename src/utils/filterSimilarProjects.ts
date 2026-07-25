import type { ProjectCreateScope } from './createProjectQuery.js';
import { isSimilarName } from './nameSimilarity.js';

export function filterSimilarProjects(
  projects: Array<Record<string, unknown>>,
  name: string,
  scope: ProjectCreateScope
): Record<string, unknown>[] {
  const normalized = name.trim().toLowerCase();
  return projects.filter((project) => {
    const projectName = String(project.name ?? '').trim();
    if (!projectName || projectName.trim().toLowerCase() === normalized) return false;
    if (!isSimilarName(projectName, name)) return false;
    const parentId = project.parentId ?? null;
    return scope.parentId === null ? parentId === null : parentId === scope.parentId;
  });
}
