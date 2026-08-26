import type { Project } from '../types';

export interface ProjectTreeNode {
  project: Project;
  children: ProjectTreeNode[];
}

export function buildProjectTree(projects: Project[]): ProjectTreeNode[] {
  const byId = new Map(projects.map((project) => [project._id, project]));
  const childrenByParent = new Map<string | null, Project[]>();

  for (const project of projects) {
    const parentId =
      project.parentId && byId.has(project.parentId) ? project.parentId : null;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(project);
    childrenByParent.set(parentId, list);
  }

  const sortSiblings = (items: Project[]) =>
    [...items].sort((a, b) => {
      const orderDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });

  function build(parentId: string | null): ProjectTreeNode[] {
    return sortSiblings(childrenByParent.get(parentId) ?? []).map((project) => ({
      project,
      children: build(project._id),
    }));
  }

  return build(null);
}

export function flattenProjectTree(nodes: ProjectTreeNode[]): Project[] {
  const result: Project[] = [];
  const walk = (list: ProjectTreeNode[]) => {
    for (const node of list) {
      result.push(node.project);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

export function getProjectDescendantIds(projects: Project[], projectId: string): Set<string> {
  const childrenByParent = new Map<string | null, string[]>();
  for (const project of projects) {
    const parentId = project.parentId ?? null;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(project._id);
    childrenByParent.set(parentId, list);
  }

  const result = new Set<string>();
  const stack = [...(childrenByParent.get(projectId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return result;
}

export function getProjectAncestorIds(projects: Project[], projectId: string): string[] {
  const byId = new Map(projects.map((project) => [project._id, project]));
  const ancestors: string[] = [];
  let cursor = byId.get(projectId)?.parentId ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    ancestors.push(cursor);
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return ancestors;
}

export const ACTIVE_PROJECT_STORAGE_KEY = 'qtask_active_project_id';

export function getStoredActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredActiveProjectId(projectId: string | null): void {
  try {
    if (projectId) {
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
    } else {
      localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

/**
 * A tree row is expanded when the user explicitly expanded it, or when a
 * direct child is the current selection (so navigating to a child always
 * reveals it). It must NOT auto-expand just because the row itself is
 * selected — that overrides the user's own collapse and makes the chevron
 * on the selected row look broken (it stays open no matter what you click).
 */
export function isProjectRowExpanded(
  expanded: ReadonlySet<string>,
  projectId: string,
  children: ProjectTreeNode[],
  selectionId: string | null
): boolean {
  return (
    expanded.has(projectId) || children.some((child) => child.project._id === selectionId)
  );
}
