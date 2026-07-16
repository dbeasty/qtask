import { ProjectModel, TaskModel } from '../models/index.js';
import { config } from '../config/index.js';
import { taskService } from './taskService.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';

export const DEFAULT_PROJECT_NAME = 'Project One';

function serializeProject(project: {
  _id: unknown;
  userId: string;
  name: string;
  description?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    _id: String(project._id),
    userId: project.userId,
    name: project.name,
    description: project.description ?? undefined,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export class ProjectService {
  async ensureDefaultProject(userId: string): Promise<string> {
    const count = await ProjectModel.countDocuments({ userId });
    if (count > 0) {
      const existing = await ProjectModel.findOne({ userId }).sort({ createdAt: 1 }).lean();
      return String(existing!._id);
    }

    const project = await ProjectModel.create({ userId, name: DEFAULT_PROJECT_NAME });
    return String(project._id);
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: { name?: string; description?: string | null }
  ) {
    const project = await ProjectModel.findOne({ _id: projectId, userId });
    if (!project) return null;

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new Error('Project name cannot be empty');
      }
      project.name = trimmed;
    }
    if (input.description !== undefined) {
      project.description = input.description ?? undefined;
    }

    await project.save();
    return serializeProject(project);
  }
  async createProject(userId: string, name: string, description?: string) {
    const project = await ProjectModel.create({ userId, name, description });
    return serializeProject(project);
  }

  async getProject(userId: string, projectId: string) {
    const project = await ProjectModel.findOne({ _id: projectId, userId }).lean();
    if (!project) return null;

    return serializeProject(project);
  }

  async listProjects(userId: string) {
    await this.ensureDefaultProject(userId);
    const projects = await ProjectModel.find({ userId }).sort({ updatedAt: -1 }).lean();
    return projects.map((p) => serializeProject(p));
  }

  async deleteProject(userId: string, projectId: string) {
    const project = await ProjectModel.findOne({ _id: projectId, userId });
    if (!project) return null;

    const { deletedCount } = await TaskModel.deleteMany({ userId, projectId });
    await ProjectModel.deleteOne({ _id: projectId, userId });

    const remaining = await ProjectModel.countDocuments({ userId });
    let nextProjectId: string | null = null;
    if (remaining === 0) {
      nextProjectId = await this.ensureDefaultProject(userId);
    } else {
      const next = await ProjectModel.findOne({ userId }).sort({ createdAt: 1 }).lean();
      nextProjectId = next ? String(next._id) : null;
    }

    return { deletedTaskCount: deletedCount, nextProjectId };
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

    const tracker = createLlmCallTracker({
      callType: 'generate',
      source: 'project_summary',
      model: config.ollama.model,
      userId,
    });
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

      const data = (await response.json()) as { response: string } & OllamaTimingFields;
      tracker.complete(response.status, data);
      return data.response.trim();
    } catch (error) {
      tracker.fail(error, undefined, true);
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
