import { updateProject } from '../api/client';
import type { Project } from '../types';

export async function toggleProjectDone(projectId: string, done: boolean): Promise<Project> {
  const { project } = await updateProject(projectId, { done });
  return project;
}
