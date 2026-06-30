import { ProjectModel } from '../models/index.js';
import { config } from '../config/index.js';
import { taskService } from './taskService.js';

export class ProjectService {
  async createProject(userId: string, name: string, description?: string) {
    const project = await ProjectModel.create({ userId, name, description });
    return {
      _id: String(project._id),
      userId: project.userId,
      name: project.name,
      description: project.description,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async getProject(userId: string, projectId: string) {
    const project = await ProjectModel.findOne({ _id: projectId, userId }).lean();
    if (!project) return null;

    return {
      _id: String(project._id),
      userId: project.userId,
      name: project.name,
      description: project.description,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async listProjects(userId: string) {
    const projects = await ProjectModel.find({ userId }).sort({ updatedAt: -1 }).lean();
    return projects.map((p) => ({
      _id: String(p._id),
      userId: p.userId,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }

  async summarizeProject(userId: string, projectId: string): Promise<string> {
    const project = await this.getProject(userId, projectId);
    if (!project) throw new Error('Project not found');

    const tasks = await taskService.findTasks(userId, { projectId }, 100);

    const summary = {
      project: project.name,
      totalTasks: tasks.length,
      byStatus: {
        todo: tasks.filter((t) => t.status === 'todo').length,
        in_progress: tasks.filter((t) => t.status === 'in_progress').length,
        done: tasks.filter((t) => t.status === 'done').length,
        cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      },
      avgPercentComplete:
        tasks.length > 0
          ? Math.round(tasks.reduce((sum, t) => sum + (t.percentComplete as number), 0) / tasks.length)
          : 0,
      highPriorityOpen: tasks
        .filter((t) => ['todo', 'in_progress'].includes(t.status as string) && ['high', 'urgent'].includes(t.priority as string))
        .map((t) => ({ title: t.title, percentComplete: t.percentComplete, dueDate: t.dueDate })),
      recentlyUpdated: tasks.slice(0, 5).map((t) => ({
        title: t.title,
        status: t.status,
        percentComplete: t.percentComplete,
      })),
    };

    try {
      const response = await fetch(`${config.ollama.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollama.model,
          prompt: `You are a project management assistant. Summarize this project status in 2-4 concise paragraphs for the project owner.\n\n${JSON.stringify(summary, null, 2)}`,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama generate failed: ${response.status}`);
      }

      const data = (await response.json()) as { response: string };
      return data.response.trim();
    } catch {
      return [
        `Project "${project.name}" has ${summary.totalTasks} tasks.`,
        `Status breakdown: ${summary.byStatus.todo} todo, ${summary.byStatus.in_progress} in progress, ${summary.byStatus.done} done.`,
        `Average completion: ${summary.avgPercentComplete}%.`,
        summary.highPriorityOpen.length > 0
          ? `High-priority open items: ${summary.highPriorityOpen.map((t) => t.title).join(', ')}.`
          : 'No high-priority open items.',
      ].join(' ');
    }
  }
}

export const projectService = new ProjectService();
