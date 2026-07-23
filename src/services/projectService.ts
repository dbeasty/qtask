import { isValidObjectId } from 'mongoose';
import { ProjectModel, TaskModel, UserModel } from '../models/index.js';
import { config } from '../config/index.js';
import { HttpError } from '../utils/httpError.js';
import {
  canEditProject,
  canManageMembers,
  canUpdateStatus,
  isCollaboratorRole,
  roleAtLeast,
  type CollaboratorRole,
  type ProjectRole,
  type ProjectStatus,
  type SerializedCollaborator,
  type SerializedProject,
} from '../types/project.js';
import {
  computeLeafProjectProgress,
  computeParentProjectProgress,
} from '../utils/projectProgress.js';
import { taskService } from './taskService.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';
import type { StagingContext } from '../types/staging.js';

export const DEFAULT_PROJECT_NAME = 'Project One';

type LeanProject = {
  _id: unknown;
  userId: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  status?: ProjectStatus;
  percentComplete?: number;
  progressShare?: number | null;
  collaborators?: Array<{ userId: string; role: CollaboratorRole }> | null;
  createdAt: Date;
  updatedAt: Date;
  staging?: StagingContext & { stagedAt: Date };
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function resolveRole(project: LeanProject, userId: string): ProjectRole | null {
  if (project.userId === userId) return 'owner';
  const collab = (project.collaborators ?? []).find((c) => c.userId === userId);
  return collab?.role ?? null;
}

async function loadCollaboratorDetails(
  collaborators: Array<{ userId: string; role: CollaboratorRole }>
): Promise<SerializedCollaborator[]> {
  if (collaborators.length === 0) return [];

  const ids = collaborators.map((c) => c.userId);
  const users = await UserModel.find({ _id: { $in: ids } })
    .select('email displayName')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return collaborators.map((c) => {
    const user = byId.get(c.userId);
    return {
      userId: c.userId,
      email: user?.email ?? 'unknown',
      displayName: user?.displayName ?? undefined,
      role: c.role,
    };
  });
}

async function serializeProject(project: LeanProject, viewerId: string): Promise<SerializedProject> {
  const role = resolveRole(project, viewerId);
  if (!role) {
    throw new HttpError(404, 'Project not found');
  }

  const [collaborators, owner] = await Promise.all([
    loadCollaboratorDetails(
      (project.collaborators ?? []).map((c) => ({ userId: c.userId, role: c.role }))
    ),
    UserModel.findById(project.userId).select('email displayName').lean(),
  ]);

  return {
    _id: String(project._id),
    userId: project.userId,
    ownerEmail: owner?.email ?? 'unknown',
    ownerDisplayName: owner?.displayName ?? undefined,
    name: project.name,
    description: project.description ?? undefined,
    parentId: project.parentId ?? null,
    sortOrder: project.sortOrder ?? 0,
    status: project.status ?? 'todo',
    percentComplete: project.percentComplete ?? 0,
    progressShare:
      project.progressShare === undefined || project.progressShare === null
        ? undefined
        : project.progressShare,
    role,
    canEdit: canEditProject(role),
    canUpdateStatus: canUpdateStatus(role),
    canManageMembers: canManageMembers(role),
    collaborators,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export class ProjectService {
  /** One-shot rename of legacy `commenter` collaborator role to `executor`. */
  async migrateLegacyCollaboratorRoles(): Promise<number> {
    const result = await ProjectModel.updateMany(
      { 'collaborators.role': 'commenter' },
      { $set: { 'collaborators.$[c].role': 'executor' } },
      { arrayFilters: [{ 'c.role': 'commenter' }], runValidators: false }
    );
    return result.modifiedCount;
  }

  async ensureDefaultProject(userId: string): Promise<string> {
    const count = await ProjectModel.countDocuments({ userId, staging: { $exists: false } });
    if (count > 0) {
      const existing = await ProjectModel.findOne({ userId, staging: { $exists: false } })
        .sort({ createdAt: 1 })
        .lean();
      return String(existing!._id);
    }

    const project = await ProjectModel.create({
      userId,
      name: DEFAULT_PROJECT_NAME,
      collaborators: [],
      parentId: null,
      sortOrder: 0,
      status: 'todo',
      percentComplete: 0,
    });
    return String(project._id);
  }

  /** Projects the user owns or collaborates on. */
  accessibleProjectFilter(userId: string) {
    return {
      staging: { $exists: false },
      $or: [{ userId }, { 'collaborators.userId': userId }],
    };
  }

  async listAccessibleProjectIds(userId: string): Promise<string[]> {
    const projects = await ProjectModel.find(this.accessibleProjectFilter(userId))
      .select('_id')
      .lean();
    return projects.map((p) => String(p._id));
  }

  async getProjectAccess(
    userId: string,
    projectId: string
  ): Promise<{ project: LeanProject; role: ProjectRole } | null> {
    // Guard against orphaned/invalid projectId values (e.g. a stray title string)
    // so callers get a clean "not found" instead of a Mongoose CastError (HTTP 500).
    if (!isValidObjectId(projectId)) return null;

    const project = await ProjectModel.findOne({
      _id: projectId,
      ...this.accessibleProjectFilter(userId),
    }).lean();
    if (!project) return null;

    const role = resolveRole(project as LeanProject, userId);
    if (!role) return null;

    return { project: project as LeanProject, role };
  }

  /**
   * Require membership. Non-members get 404; members below minRole get 403.
   */
  async assertProjectAccess(
    userId: string,
    projectId: string,
    minRole: ProjectRole = 'viewer'
  ): Promise<{ project: LeanProject; role: ProjectRole }> {
    const access = await this.getProjectAccess(userId, projectId);
    if (!access) {
      throw new HttpError(404, 'Project not found');
    }
    if (!roleAtLeast(access.role, minRole)) {
      throw new HttpError(403, 'Insufficient project permissions');
    }
    return access;
  }

  async assertProjectAccessForStaging(
    userId: string,
    projectId: string,
    staging: StagingContext
  ): Promise<void> {
    const project = await ProjectModel.findOne({
      _id: projectId,
      userId,
      'staging.conversationId': staging.conversationId,
    }).lean();
    if (project) return;
    await this.assertProjectAccess(userId, projectId, 'editor');
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: {
      name?: string;
      description?: string | null;
      parentId?: string | null;
      sortOrder?: number;
      progressShare?: number | null;
    }
  ) {
    const structural =
      input.name !== undefined ||
      input.description !== undefined ||
      input.parentId !== undefined ||
      input.sortOrder !== undefined;

    if (structural) {
      await this.assertProjectAccess(userId, projectId, 'owner');
    } else {
      await this.assertProjectAccess(userId, projectId, 'editor');
    }

    const project = await ProjectModel.findById(projectId);
    if (!project) return null;

    const previousParentId =
      project.parentId !== undefined && project.parentId !== null ? String(project.parentId) : null;

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new HttpError(400, 'Project name cannot be empty');
      }
      project.name = trimmed;
    }
    if (input.description !== undefined) {
      project.description = input.description ?? undefined;
    }
    if (input.parentId !== undefined) {
      await this.assertValidParent(userId, projectId, input.parentId);
      project.parentId = input.parentId;
    }
    if (input.sortOrder !== undefined) {
      project.sortOrder = input.sortOrder;
    }
    if (input.progressShare !== undefined) {
      if (input.progressShare === null) {
        project.set('progressShare', undefined);
        project.markModified('progressShare');
      } else {
        project.progressShare = Math.max(0, Math.min(100, Math.round(input.progressShare)));
      }
    }

    await project.save();

    if (input.progressShare === null) {
      await ProjectModel.updateOne({ _id: projectId }, { $unset: { progressShare: 1 } });
    }

    const affected = new Set<string>([projectId]);
    if (previousParentId) affected.add(previousParentId);
    const newParentId =
      project.parentId !== undefined && project.parentId !== null ? String(project.parentId) : null;
    if (newParentId) affected.add(newParentId);
    await this.recalculateProjects([...affected]);

    const refreshed = await ProjectModel.findById(projectId).lean();
    if (!refreshed) return null;
    return serializeProject(refreshed as LeanProject, userId);
  }

  async createProject(
    userId: string,
    name: string,
    description?: string,
    staging?: StagingContext,
    parentId?: string | null
  ) {
    if (parentId) {
      await this.assertProjectAccess(userId, parentId, 'owner');
    }

    if (staging) {
      const existing = await ProjectModel.findOne({
        userId,
        name,
        'staging.conversationId': staging.conversationId,
      }).lean();
      if (existing) {
        return serializeProject(existing as LeanProject, userId);
      }
    }

    const siblingFilter = {
      userId,
      parentId: parentId ?? null,
      staging: { $exists: false },
    };
    const maxSibling = await ProjectModel.findOne(siblingFilter)
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();
    const sortOrder = maxSibling ? (maxSibling.sortOrder ?? 0) + 1 : 0;

    const project = await ProjectModel.create({
      userId,
      name,
      description,
      parentId: parentId ?? null,
      sortOrder,
      status: 'todo',
      percentComplete: 0,
      collaborators: [],
      staging: staging ? { ...staging, stagedAt: new Date() } : undefined,
    });

    if (parentId) {
      await this.recalculateProjectAndAncestors(parentId);
    }

    const refreshed = await ProjectModel.findById(project._id).lean();
    return serializeProject((refreshed ?? project.toObject()) as LeanProject, userId);
  }

  async moveProject(
    userId: string,
    projectId: string,
    input: { parentId: string | null; index?: number }
  ) {
    await this.assertProjectAccess(userId, projectId, 'owner');
    await this.assertValidParent(userId, projectId, input.parentId);

    const project = await ProjectModel.findById(projectId);
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    const previousParentId =
      project.parentId !== undefined && project.parentId !== null ? String(project.parentId) : null;
    const newParentId = input.parentId;
    const siblings = await ProjectModel.find({
      ...this.accessibleProjectFilter(userId),
      parentId: newParentId,
      _id: { $ne: projectId },
    })
      .sort({ sortOrder: 1, createdAt: 1 })
      .select('_id')
      .lean();

    const orderedIds = siblings.map((s) => String(s._id));
    const insertIndex =
      input.index === undefined
        ? orderedIds.length
        : Math.max(0, Math.min(input.index, orderedIds.length));
    orderedIds.splice(insertIndex, 0, projectId);

    project.parentId = newParentId;
    project.sortOrder = insertIndex;
    await project.save();

    await Promise.all(
      orderedIds.map((id, sortOrder) =>
        ProjectModel.updateOne({ _id: id }, { $set: { sortOrder } })
      )
    );

    const affected = new Set<string>([projectId]);
    if (previousParentId) affected.add(previousParentId);
    if (newParentId) affected.add(newParentId);
    await this.recalculateProjects([...affected]);

    const refreshed = await ProjectModel.findById(projectId).lean();
    if (!refreshed) {
      throw new HttpError(404, 'Project not found');
    }
    return serializeProject(refreshed as LeanProject, userId);
  }

  private async assertValidParent(
    userId: string,
    projectId: string,
    parentId: string | null
  ): Promise<void> {
    if (parentId === null || parentId === undefined) return;
    if (parentId === projectId) {
      throw new HttpError(400, 'A project cannot be its own parent');
    }
    await this.assertProjectAccess(userId, parentId, 'owner');

    // Walk ancestors of the proposed parent; none may be the moving project.
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === projectId) {
        throw new HttpError(400, 'Cannot move a project under its descendant');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const ancestorDoc: { parentId?: string | null } | null = await ProjectModel.findById(cursor)
        .select('parentId')
        .lean();
      cursor = ancestorDoc?.parentId ? String(ancestorDoc.parentId) : null;
    }
  }

  async getProject(userId: string, projectId: string) {
    const access = await this.getProjectAccess(userId, projectId);
    if (!access) return null;
    return serializeProject(access.project, userId);
  }

  async listProjects(userId: string) {
    await this.ensureDefaultProject(userId);
    const projects = await ProjectModel.find(this.accessibleProjectFilter(userId))
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return Promise.all(projects.map((p) => serializeProject(p as LeanProject, userId)));
  }

  async deleteProject(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId, 'owner');

    const project = await ProjectModel.findById(projectId).lean();
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    const parentId = project.parentId ?? null;

    const childIds = (
      await ProjectModel.find({ parentId: projectId }).select('_id').lean()
    ).map((child) => String(child._id));

    // Reparent children to the deleted project's parent.
    await ProjectModel.updateMany(
      { parentId: projectId },
      { $set: { parentId } }
    );

    // Unlink shared tasks; delete tasks that only belonged to this project.
    const linkedTasks = await TaskModel.find({
      $or: [{ projectIds: projectId }, { projectId }],
    })
      .select('_id projectIds projectId')
      .lean();

    const otherProjectIds = new Set<string>();
    let deletedTaskCount = 0;
    for (const task of linkedTasks) {
      const ids = new Set<string>();
      if (Array.isArray(task.projectIds)) {
        for (const id of task.projectIds) ids.add(String(id));
      }
      if (task.projectId) ids.add(String(task.projectId));
      ids.delete(projectId);

      if (ids.size === 0) {
        await TaskModel.deleteOne({ _id: task._id });
        deletedTaskCount += 1;
      } else {
        const remaining = [...ids];
        for (const id of remaining) otherProjectIds.add(id);
        await TaskModel.updateOne(
          { _id: task._id },
          { $set: { projectIds: remaining, projectId: remaining[0] } }
        );
      }
    }

    const { ConversationModel } = await import('../models/index.js');
    await ConversationModel.deleteMany({ projectId });

    await ProjectModel.deleteOne({ _id: projectId, userId });

    const affected = new Set<string>([...childIds, ...otherProjectIds]);
    if (parentId) affected.add(String(parentId));
    await this.recalculateProjects([...affected]);

    const remainingOwned = await ProjectModel.countDocuments({
      userId,
      staging: { $exists: false },
    });
    let nextProjectId: string | null = null;
    if (remainingOwned === 0) {
      const stillAccessible = await ProjectModel.countDocuments(this.accessibleProjectFilter(userId));
      if (stillAccessible === 0) {
        nextProjectId = await this.ensureDefaultProject(userId);
      } else {
        const next = await ProjectModel.findOne(this.accessibleProjectFilter(userId))
          .sort({ sortOrder: 1, createdAt: 1 })
          .lean();
        nextProjectId = next ? String(next._id) : null;
      }
    } else {
      const next = await ProjectModel.findOne({ userId, staging: { $exists: false } })
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
      nextProjectId = next ? String(next._id) : null;
    }

    return { deletedTaskCount, nextProjectId };
  }

  /**
   * Recalculate stored status/percent for a project, then walk ancestors.
   * Leaf projects derive from linked tasks; parents roll up child projects.
   */
  async recalculateProjectAndAncestors(projectId: string): Promise<void> {
    if (!isValidObjectId(projectId)) return;

    let cursor: string | null = projectId;
    const seen = new Set<string>();

    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);

      const project: { _id: unknown; parentId?: string | null } | null =
        await ProjectModel.findById(cursor).select('_id parentId').lean();
      if (!project) break;

      await this.recalculateSingleProject(String(project._id));
      cursor = project.parentId ? String(project.parentId) : null;
    }
  }

  /** Recalculate each project id and its ancestors (deduped). */
  async recalculateProjects(projectIds: string[]): Promise<void> {
    const unique = [
      ...new Set(projectIds.filter((id) => Boolean(id) && isValidObjectId(id))),
    ];
    const visited = new Set<string>();

    for (const projectId of unique) {
      let cursor: string | null = projectId;
      while (cursor) {
        if (visited.has(cursor)) break;
        visited.add(cursor);

        const project: { _id: unknown; parentId?: string | null } | null =
          await ProjectModel.findById(cursor).select('_id parentId').lean();
        if (!project) break;

        await this.recalculateSingleProject(String(project._id));
        cursor = project.parentId ? String(project.parentId) : null;
      }
    }
  }

  /** One-shot backfill of progress fields for all non-staged projects (deepest first). */
  async recalculateAllProjects(): Promise<number> {
    const projects = await ProjectModel.find({ staging: { $exists: false } })
      .select('_id parentId')
      .lean();

    const depthCache = new Map<string, number>();
    const byId = new Map(projects.map((p) => [String(p._id), p]));
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (depthCache.has(id)) return depthCache.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const doc = byId.get(id);
      const parentId = doc?.parentId ? String(doc.parentId) : null;
      const depth = parentId ? depthOf(parentId, seen) + 1 : 0;
      depthCache.set(id, depth);
      return depth;
    };

    const ordered = [...projects].sort(
      (a, b) => depthOf(String(b._id)) - depthOf(String(a._id))
    );

    for (const project of ordered) {
      await this.recalculateSingleProject(String(project._id));
    }

    return projects.length;
  }

  private async recalculateSingleProject(projectId: string): Promise<void> {
    const children = await ProjectModel.find({
      parentId: projectId,
      staging: { $exists: false },
    })
      .select('status percentComplete progressShare')
      .lean();

    let percentComplete: number;
    let status: ProjectStatus;

    if (children.length > 0) {
      const result = computeParentProjectProgress(
        children.map((child) => ({
          status: (child.status as ProjectStatus) ?? 'todo',
          percentComplete: child.percentComplete ?? 0,
          progressShare: child.progressShare,
        }))
      );
      percentComplete = result.percentComplete;
      status = result.status;
    } else {
      const tasks = await TaskModel.find({
        staging: { $exists: false },
        $or: [{ projectIds: projectId }, { projectId }],
      })
        .select('status percentComplete')
        .lean();

      const result = computeLeafProjectProgress(
        tasks.map((task) => ({
          status: (task.status as ProjectStatus) ?? 'todo',
          percentComplete: task.percentComplete ?? 0,
        }))
      );
      percentComplete = result.percentComplete;
      status = result.status;
    }

    await ProjectModel.updateOne(
      { _id: projectId },
      { $set: { status, percentComplete } }
    );
  }

  async addCollaborator(
    userId: string,
    projectId: string,
    input: { email?: string; userId?: string; role?: CollaboratorRole }
  ) {
    await this.assertProjectAccess(userId, projectId, 'owner');

    const role: CollaboratorRole = input.role ?? 'editor';
    if (!isCollaboratorRole(role)) {
      throw new HttpError(400, 'Invalid collaborator role');
    }

    let targetUser: { _id: unknown; email: string; displayName?: string | null } | null = null;
    if (input.userId) {
      targetUser = await UserModel.findById(input.userId).select('email displayName').lean();
    } else if (input.email) {
      targetUser = await UserModel.findOne({ email: normalizeEmail(input.email) })
        .select('email displayName')
        .lean();
    } else {
      throw new HttpError(400, 'email or userId is required');
    }

    if (!targetUser) {
      throw new HttpError(404, 'User not found');
    }

    const targetId = String(targetUser._id);
    const project = await ProjectModel.findById(projectId);
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    if (project.userId === targetId) {
      throw new HttpError(400, 'Project owner is already a member');
    }

    const existing = (project.collaborators ?? []).find((c) => c.userId === targetId);
    if (existing) {
      throw new HttpError(409, 'User is already a collaborator');
    }

    project.collaborators.push({ userId: targetId, role });
    await project.save();
    return serializeProject(project.toObject() as LeanProject, userId);
  }

  async updateCollaboratorRole(
    userId: string,
    projectId: string,
    collaboratorUserId: string,
    role: CollaboratorRole
  ) {
    await this.assertProjectAccess(userId, projectId, 'owner');

    if (!isCollaboratorRole(role)) {
      throw new HttpError(400, 'Invalid collaborator role');
    }

    const project = await ProjectModel.findById(projectId);
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    const collab = (project.collaborators ?? []).find((c) => c.userId === collaboratorUserId);
    if (!collab) {
      throw new HttpError(404, 'Collaborator not found');
    }

    collab.role = role;
    await project.save();
    return serializeProject(project.toObject() as LeanProject, userId);
  }

  async removeCollaborator(userId: string, projectId: string, collaboratorUserId: string) {
    const access = await this.getProjectAccess(userId, projectId);
    if (!access) {
      throw new HttpError(404, 'Project not found');
    }

    const isSelf = collaboratorUserId === userId;
    if (!isSelf && access.role !== 'owner') {
      throw new HttpError(403, 'Insufficient project permissions');
    }

    if (access.project.userId === collaboratorUserId) {
      throw new HttpError(400, 'Cannot remove the project owner');
    }

    const project = await ProjectModel.findById(projectId);
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    const before = project.collaborators.length;
    const remaining = project.collaborators
      .filter((c) => c.userId !== collaboratorUserId)
      .map((c) => ({ userId: c.userId, role: c.role }));
    if (remaining.length === before) {
      throw new HttpError(404, 'Collaborator not found');
    }
    project.set('collaborators', remaining);

    await project.save();

    if (isSelf && access.role !== 'owner') {
      return { left: true as const, project: null };
    }

    return {
      left: false as const,
      project: await serializeProject(project.toObject() as LeanProject, userId),
    };
  }

  async summarizeProject(userId: string, projectId: string): Promise<string> {
    const project = await this.getProject(userId, projectId);
    if (!project) throw new HttpError(404, 'Project not found');

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
        .filter(
          (t) =>
            ['todo', 'in_progress'].includes(t.status as string) &&
            ['high', 'urgent'].includes(t.priority as string)
        )
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
          keep_alive: config.ollama.keepAlive,
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
