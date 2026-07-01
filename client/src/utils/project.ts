import type { Project, Task } from '../types';
import type { UiMessage } from '../types';

export const DEFAULT_PROJECT_NAME = 'Project One';

const PROJECT_PATTERNS = [
  /project\s+(?:called|named)\s+["']?([^"'.!?,]+)["']?/i,
  /for\s+(?:the\s+)?["']?([^"'.]+?)["']?\s+project/i,
  /in\s+(?:the\s+)?["']?([^"'.]+?)["']?\s+project/i,
];

export function extractProjectNameFromText(text: string): string | undefined {
  const trimmed = text.trim();
  for (const pattern of PROJECT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function suggestProjectFromMessages(
  messages: UiMessage[],
  projects: Project[]
): string | undefined {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) return undefined;

  const extracted = extractProjectNameFromText(firstUser.content);
  if (!extracted) return undefined;

  const matched = projects.find((project) => project.name.toLowerCase() === extracted.toLowerCase());
  return matched?.name ?? extracted;
}

export async function resolveProjectId(
  projectName: string,
  projects: Project[],
  createProjectFn: (body: { name: string }) => Promise<{ project: Project }>
): Promise<string | undefined> {
  const trimmed = projectName.trim();
  if (!trimmed) return undefined;

  const existing = projects.find((project) => project.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing._id;

  const { project } = await createProjectFn({ name: trimmed });
  return project._id;
}

export function projectIdToName(projectId: string, projects: Project[]): string {
  if (!projectId) return '';
  return projects.find((project) => project._id === projectId)?.name ?? '';
}

export function getDefaultProject(projects: Project[]): Project | undefined {
  return (
    projects.find((project) => project.name === DEFAULT_PROJECT_NAME) ??
    projects[projects.length - 1]
  );
}

export interface ProjectTaskGroup {
  projectId: string;
  projectName: string;
  tasks: Task[];
}

export function groupTasksByProject(tasks: Task[], projects: Project[]): ProjectTaskGroup[] {
  const defaultProject = getDefaultProject(projects);
  const defaultProjectId = defaultProject?._id ?? '';

  const groups: ProjectTaskGroup[] = projects.map((project) => ({
    projectId: project._id,
    projectName: project.name,
    tasks: [],
  }));

  const groupById = new Map(groups.map((group) => [group.projectId, group]));

  for (const task of tasks) {
    const projectId = task.projectId || defaultProjectId;
    const group = groupById.get(projectId) ?? groupById.get(defaultProjectId);
    group?.tasks.push(task);
  }

  return groups;
}
