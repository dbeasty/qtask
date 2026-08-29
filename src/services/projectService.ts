import { isValidObjectId } from 'mongoose';
import { CommentModel, InviteModel, ProjectModel, TaskModel, UserModel } from '../models/index.js';
import { config } from '../config/index.js';
import {
  enqueueProjectEmbeddingJob,
  enqueueTaskEmbeddingsForProject,
} from './embeddingQueue.js';
import { HttpError } from '../utils/httpError.js';
import {
  canDeleteOwnTasks,
  canDeleteProject,
  canEditProject,
  canManageMembers,
  canManageStructure,
  canUpdateStatus,
  isCollaboratorRole,
  roleAtLeast,
  type CollaboratorRole,
  type ProjectRole,
  type ProjectStatus,
  type SerializedCollaborator,
  type SerializedProject,
} from '../types/project.js';
import type { ShareContact } from '../types/user.js';
import {
  computeLeafProjectProgress,
  computeParentProjectProgress,
} from '../utils/projectProgress.js';
import {
  computeLeafProjectTracking,
  computeParentProjectTracking,
  toStoredTrackingRollup,
} from '../utils/projectTracking.js';
import { taskService } from './taskService.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';
import type { StagingContext } from '../types/staging.js';

export const DEFAULT_PROJECT_NAME = 'Project One';

const defaultProjectLocks = new Map<string, Promise<void>>();

/** Serializes ensureDefaultProject() per user so two concurrent calls (e.g.
 *  two requests firing right after registration) can't both see zero
 *  projects and each create their own "Project One". */
async function withDefaultProjectLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = defaultProjectLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(
    () => gate,
    () => gate
  );
  defaultProjectLocks.set(userId, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    void queued.finally(() => {
      if (defaultProjectLocks.get(userId) === queued) {
        defaultProjectLocks.delete(userId);
      }
    });
  }
}

type LeanProject = {
  _id: unknown;
  userId: string;
  name: string;
  description?: string | null;
  notes?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  status?: ProjectStatus;
  percentComplete?: number;
  progressShare?: number | null;
  hourlyRate?: number | null;
  trackingRollup?: {
    hoursSpent?: number;
    hoursRemaining?: number;
    materialsTotal?: number;
    laborCost?: number;
    totalCost?: number;
    updatedAt?: Date;
  } | null;
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

type UserLookup = { email: string; displayName?: string };

async function loadUserLookup(userIds: string[]): Promise<Map<string, UserLookup>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const users = await UserModel.find({ _id: { $in: unique } })
    .select('email displayName')
    .lean();
  return new Map(
    users.map((u) => [String(u._id), { email: u.email, displayName: u.displayName ?? undefined }])
  );
}

function projectUserIds(project: LeanProject): string[] {
  return [project.userId, ...(project.collaborators ?? []).map((c) => c.userId)];
}

function buildSerializedProject(
  project: LeanProject,
  viewerId: string,
  userById: Map<string, UserLookup>
): SerializedProject {
  const role = resolveRole(project, viewerId);
  if (!role) {
    throw new HttpError(404, 'Project not found');
  }

  const owner = userById.get(project.userId);
  const collaborators: SerializedCollaborator[] = (project.collaborators ?? []).map((c) => {
    const user = userById.get(c.userId);
    return {
      userId: c.userId,
      email: user?.email ?? 'unknown',
      displayName: user?.displayName,
      role: c.role,
    };
  });

  return {
    _id: String(project._id),
    userId: project.userId,
    ownerEmail: owner?.email ?? 'unknown',
    ownerDisplayName: owner?.displayName ?? undefined,
    name: project.name,
    description: project.description ?? undefined,
    notes: project.notes ?? undefined,
    parentId: project.parentId ?? null,
    sortOrder: project.sortOrder ?? 0,
    status: project.status ?? 'todo',
    percentComplete: project.percentComplete ?? 0,
    progressShare:
      project.progressShare === undefined || project.progressShare === null
        ? undefined
        : project.progressShare,
    hourlyRate: project.hourlyRate ?? undefined,
    trackingRollup: project.trackingRollup
      ? {
          hoursSpent: project.trackingRollup.hoursSpent ?? 0,
          hoursRemaining: project.trackingRollup.hoursRemaining ?? 0,
          materialsTotal: project.trackingRollup.materialsTotal ?? 0,
          laborCost: project.trackingRollup.laborCost ?? 0,
          totalCost: project.trackingRollup.totalCost ?? 0,
          updatedAt: project.trackingRollup.updatedAt
            ? project.trackingRollup.updatedAt.toISOString()
            : new Date().toISOString(),
        }
      : undefined,
    role,
    canEdit: canEditProject(role),
    canUpdateStatus: canUpdateStatus(role),
    canManageMembers: canManageMembers(role),
    canManageStructure: canManageStructure(role),
    canDeleteProjects: canDeleteProject(role),
    canDeleteOwnTasks: canDeleteOwnTasks(role),
    collaborators,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

async function serializeProject(project: LeanProject, viewerId: string): Promise<SerializedProject> {
  const userById = await loadUserLookup(projectUserIds(project));
  return buildSerializedProject(project, viewerId, userById);
}

/** Batches the owner/collaborator user lookups across the whole list instead of once per project. */
async function serializeProjectsBatch(
  projects: LeanProject[],
  viewerId: string
): Promise<SerializedProject[]> {
  const userById = await loadUserLookup(projects.flatMap(projectUserIds));
  return projects.map((project) => buildSerializedProject(project, viewerId, userById));
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
    return withDefaultProjectLock(userId, async () => {
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
    });
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
    projectId: string,
    stagingConversationId?: string
  ): Promise<{ project: LeanProject; role: ProjectRole } | null> {
    // Guard against orphaned/invalid projectId values (e.g. a stray title string)
    // so callers get a clean "not found" instead of a Mongoose CastError (HTTP 500).
    if (!isValidObjectId(projectId)) return null;

    const project = await ProjectModel.findOne({
      _id: projectId,
      ...this.accessibleProjectFilter(userId),
    }).lean();
    if (project) {
      const role = resolveRole(project as LeanProject, userId);
      if (!role) return null;
      return { project: project as LeanProject, role };
    }

    // A staged project is hidden from every normal access path until
    // approved — except back to the same conversation that staged it,
    // which the agent's own tool instructions promise can reference it in
    // later calls within the same turn (see stagedToolContent()).
    if (stagingConversationId) {
      const staged = await ProjectModel.findOne({
        _id: projectId,
        userId,
        'staging.conversationId': stagingConversationId,
      }).lean();
      if (staged) {
        return { project: staged as LeanProject, role: 'owner' };
      }
    }

    return null;
  }

  /**
   * Require membership. Non-members get 404; members below minRole get 403.
   */
  async assertProjectAccess(
    userId: string,
    projectId: string,
    minRole: ProjectRole = 'viewer',
    stagingConversationId?: string
  ): Promise<{ project: LeanProject; role: ProjectRole }> {
    const access = await this.getProjectAccess(userId, projectId, stagingConversationId);
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
      notes?: string | null;
      parentId?: string | null;
      sortOrder?: number;
      progressShare?: number | null;
      hourlyRate?: number | null;
      done?: boolean;
    },
    stagingConversationId?: string
  ) {
    const structural =
      input.name !== undefined ||
      input.description !== undefined ||
      input.notes !== undefined ||
      input.parentId !== undefined ||
      input.sortOrder !== undefined;

    const rateChanged = input.hourlyRate !== undefined;

    const doneOnly =
      input.done !== undefined &&
      input.name === undefined &&
      input.description === undefined &&
      input.notes === undefined &&
      input.parentId === undefined &&
      input.sortOrder === undefined &&
      input.progressShare === undefined &&
      input.hourlyRate === undefined;

    if (structural) {
      await this.assertProjectAccess(userId, projectId, 'manager', stagingConversationId);
    } else if (doneOnly) {
      await this.assertProjectAccess(userId, projectId, 'executor', stagingConversationId);
    } else {
      await this.assertProjectAccess(userId, projectId, 'editor', stagingConversationId);
    }

    const project = await ProjectModel.findById(projectId);
    if (!project) return null;

    const previousName = project.name;
    const previousDescription = project.description ?? undefined;
    const previousNotes = project.notes ?? undefined;

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
    if (input.notes !== undefined) {
      project.notes = input.notes ?? undefined;
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
    if (input.hourlyRate !== undefined) {
      if (input.hourlyRate === null) {
        project.set('hourlyRate', undefined);
        project.markModified('hourlyRate');
      } else {
        project.hourlyRate = Math.max(0, input.hourlyRate);
      }
    }
    if (input.done !== undefined) {
      project.doneOverride = input.done;
      if (input.done) {
        project.status = 'done';
        project.percentComplete = 100;
      }
    }

    await project.save();

    if (input.progressShare === null) {
      await ProjectModel.updateOne({ _id: projectId }, { $unset: { progressShare: 1 } });
    }
    if (input.hourlyRate === null) {
      await ProjectModel.updateOne({ _id: projectId }, { $unset: { hourlyRate: 1 } });
    }

    const affected = new Set<string>([projectId]);
    if (previousParentId) affected.add(previousParentId);
    const newParentId =
      project.parentId !== undefined && project.parentId !== null ? String(project.parentId) : null;
    if (newParentId) affected.add(newParentId);
    await this.recalculateProjects([...affected]);

    if (rateChanged) {
      await this.recalculateProjectTracking(projectId);
    }

    const nameChanged = input.name !== undefined && input.name.trim() !== previousName;
    const descriptionChanged =
      input.description !== undefined && (input.description ?? undefined) !== previousDescription;
    const notesChanged =
      input.notes !== undefined && (input.notes ?? undefined) !== previousNotes;
    if (!project.staging && (nameChanged || descriptionChanged || notesChanged)) {
      await enqueueProjectEmbeddingJob(projectId);
      await enqueueTaskEmbeddingsForProject(projectId);
    }

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
    let ownerUserId = userId;
    let inheritedCollaborators: Array<{ userId: string; role: CollaboratorRole }> = [];

    if (parentId) {
      if (staging) {
        await this.assertProjectAccessForStaging(userId, parentId, staging);
      } else {
        await this.assertProjectAccess(userId, parentId, 'manager');
      }
      const parentDoc = await ProjectModel.findById(parentId).lean();
      if (!parentDoc) {
        throw new HttpError(404, 'Project not found');
      }
      ownerUserId = String(parentDoc.userId);
      inheritedCollaborators = (parentDoc.collaborators ?? []).map((c) => ({
        userId: c.userId,
        role: c.role,
      }));
    }

    if (staging) {
      const existing = await ProjectModel.findOne({
        userId: ownerUserId,
        name,
        'staging.conversationId': staging.conversationId,
      }).lean();
      if (existing) {
        return serializeProject(existing as LeanProject, userId);
      }
    }

    const siblingFilter = {
      userId: ownerUserId,
      parentId: parentId ?? null,
      staging: { $exists: false },
    };
    const maxSibling = await ProjectModel.findOne(siblingFilter)
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();
    const sortOrder = maxSibling ? (maxSibling.sortOrder ?? 0) + 1 : 0;

    const project = await ProjectModel.create({
      userId: ownerUserId,
      name,
      description,
      parentId: parentId ?? null,
      sortOrder,
      status: 'todo',
      percentComplete: 0,
      collaborators: inheritedCollaborators,
      staging: staging ? { ...staging, stagedAt: new Date() } : undefined,
    });

    if (parentId) {
      await this.recalculateProjectAndAncestors(parentId);
    }

    if (!staging) {
      await enqueueProjectEmbeddingJob(String(project._id));
    }

    const refreshed = await ProjectModel.findById(project._id).lean();
    return serializeProject((refreshed ?? project.toObject()) as LeanProject, userId);
  }

  async moveProject(
    userId: string,
    projectId: string,
    input: { parentId: string | null; index?: number }
  ) {
    await this.assertProjectAccess(userId, projectId, 'manager');
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
    await this.assertProjectAccess(userId, parentId, 'manager');

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

  async getProject(userId: string, projectId: string, stagingConversationId?: string) {
    const access = await this.getProjectAccess(userId, projectId, stagingConversationId);
    if (!access) return null;
    return serializeProject(access.project, userId);
  }

  async listProjects(userId: string) {
    await this.ensureDefaultProject(userId);
    const projects = await ProjectModel.find(this.accessibleProjectFilter(userId))
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return serializeProjectsBatch(projects as LeanProject[], userId);
  }

  /** Users this account has previously shared projects with (accepted invites + owned-project collaborators). */
  async listShareContacts(userId: string, excludeProjectId?: string): Promise<ShareContact[]> {
    const excludeUserIds = new Set<string>([userId]);

    if (excludeProjectId) {
      const project = await ProjectModel.findById(excludeProjectId).lean();
      if (project) {
        excludeUserIds.add(project.userId);
        for (const c of project.collaborators ?? []) {
          excludeUserIds.add(c.userId);
        }
      }
      const pending = await InviteModel.find({
        projectId: excludeProjectId,
        status: 'pending',
      })
        .select('inviteeUserId inviteeEmail')
        .lean();
      for (const invite of pending) {
        if (invite.inviteeUserId) excludeUserIds.add(invite.inviteeUserId);
      }
    }

    const lastSharedAt = new Map<string, Date>();

    const acceptedInvites = await InviteModel.find({
      inviterUserId: userId,
      status: 'accepted',
      inviteeUserId: { $exists: true, $ne: null },
    })
      .select('inviteeUserId respondedAt createdAt')
      .lean();

    for (const invite of acceptedInvites) {
      const id = invite.inviteeUserId as string;
      const at = invite.respondedAt ?? invite.createdAt;
      const prev = lastSharedAt.get(id);
      if (!prev || at > prev) lastSharedAt.set(id, at);
    }

    const ownedProjects = await ProjectModel.find({ userId, staging: { $exists: false } })
      .select('collaborators updatedAt')
      .lean();

    for (const project of ownedProjects) {
      const at = project.updatedAt ?? new Date();
      for (const c of project.collaborators ?? []) {
        const prev = lastSharedAt.get(c.userId);
        if (!prev || at > prev) lastSharedAt.set(c.userId, at);
      }
    }

    const contactIds = [...lastSharedAt.keys()].filter((id) => !excludeUserIds.has(id));
    if (contactIds.length === 0) return [];

    const users = await UserModel.find({ _id: { $in: contactIds } })
      .select('email displayName')
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const contacts: ShareContact[] = contactIds.flatMap((id) => {
      const user = byId.get(id);
      if (!user) return [];
      return [
        {
          userId: id,
          email: user.email,
          ...(user.displayName ? { displayName: user.displayName } : {}),
          lastSharedAt: (lastSharedAt.get(id) ?? new Date()).toISOString(),
        },
      ];
    });

    contacts.sort(
      (a, b) => new Date(b.lastSharedAt).getTime() - new Date(a.lastSharedAt).getTime()
    );
    return contacts;
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
    const taskIdsToDelete: string[] = [];
    const taskUpdates: Array<{ id: unknown; remaining: string[] }> = [];
    for (const task of linkedTasks) {
      const ids = new Set<string>();
      if (Array.isArray(task.projectIds)) {
        for (const id of task.projectIds) ids.add(String(id));
      }
      if (task.projectId) ids.add(String(task.projectId));
      ids.delete(projectId);

      if (ids.size === 0) {
        taskIdsToDelete.push(String(task._id));
      } else {
        const remaining = [...ids];
        for (const id of remaining) otherProjectIds.add(id);
        taskUpdates.push({ id: task._id, remaining });
      }
    }

    // Batched instead of one round trip per task: a project with hundreds
    // of tasks used to issue hundreds of sequential deleteOne/updateOne
    // calls. Deleting tasks this way also used to skip their comments
    // entirely, leaving them orphaned once the owning task was gone.
    if (taskIdsToDelete.length > 0) {
      await TaskModel.deleteMany({ _id: { $in: taskIdsToDelete } });
      await CommentModel.deleteMany({ taskId: { $in: taskIdsToDelete } });
    }
    if (taskUpdates.length > 0) {
      await TaskModel.bulkWrite(
        taskUpdates.map(({ id, remaining }) => ({
          updateOne: {
            filter: { _id: id },
            update: { $set: { projectIds: remaining, projectId: remaining[0] } },
          },
        }))
      );
    }
    const deletedTaskCount = taskIdsToDelete.length;

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

    const projectDoc = await ProjectModel.findById(projectId).select('doneOverride').lean();
    if (projectDoc?.doneOverride) {
      status = 'done';
      percentComplete = 100;
    }

    await ProjectModel.updateOne(
      { _id: projectId },
      { $set: { status, percentComplete } }
    );

    await this.recalculateSingleProjectTracking(projectId);
  }

  private projectRatesFromDoc(project: { hourlyRate?: number | null }) {
    return {
      hourlyRate: project.hourlyRate ?? undefined,
    };
  }

  async recalculateSingleProjectTracking(projectId: string): Promise<void> {
    const project = await ProjectModel.findById(projectId)
      .select('hourlyRate parentId')
      .lean();
    if (!project) return;

    const projectRates = this.projectRatesFromDoc(project);

    const children = await ProjectModel.find({
      parentId: projectId,
      staging: { $exists: false },
    })
      .select('progressShare trackingRollup')
      .lean();

    let tracking;
    if (children.length > 0) {
      tracking = computeParentProjectTracking(
        children.map((child) => ({
          progressShare: child.progressShare,
          trackingRollup: child.trackingRollup
            ? {
                hoursSpent: child.trackingRollup.hoursSpent ?? 0,
                hoursRemaining: child.trackingRollup.hoursRemaining ?? 0,
                materialsTotal: child.trackingRollup.materialsTotal ?? 0,
                laborCost: child.trackingRollup.laborCost ?? 0,
                totalCost: child.trackingRollup.totalCost ?? 0,
                updatedAt: child.trackingRollup.updatedAt
                  ? child.trackingRollup.updatedAt.toISOString()
                  : new Date().toISOString(),
              }
            : undefined,
        })),
        projectRates
      );
    } else {
      const tasks = await TaskModel.find({
        staging: { $exists: false },
        $or: [{ projectIds: projectId }, { projectId }],
      })
        .select('title hoursSpent hoursRemaining materials hourlyRate progressShare subtasks')
        .lean();

      tracking = computeLeafProjectTracking(
        tasks.map((task) => task as unknown as Record<string, unknown>),
        projectRates
      );
    }

    await ProjectModel.updateOne(
      { _id: projectId },
      { $set: { trackingRollup: toStoredTrackingRollup(tracking.totals) } }
    );
  }

  async recalculateProjectTracking(projectId: string): Promise<void> {
    if (!isValidObjectId(projectId)) return;

    let cursor: string | null = projectId;
    const seen = new Set<string>();

    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);

      await this.recalculateSingleProjectTracking(cursor);

      const project: { parentId?: string | null } | null = await ProjectModel.findById(cursor)
        .select('parentId')
        .lean();
      if (!project) break;
      cursor = project.parentId ? String(project.parentId) : null;
    }
  }

  async getProjectTracking(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId, 'viewer');

    const project = await ProjectModel.findById(projectId).lean();
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    const projectRates = this.projectRatesFromDoc(project);
    const children = await ProjectModel.find({
      parentId: projectId,
      staging: { $exists: false },
    })
      .select('progressShare trackingRollup')
      .lean();

    let tracking;
    if (children.length > 0) {
      tracking = computeParentProjectTracking(
        children.map((child) => ({
          progressShare: child.progressShare,
          trackingRollup: child.trackingRollup
            ? {
                hoursSpent: child.trackingRollup.hoursSpent ?? 0,
                hoursRemaining: child.trackingRollup.hoursRemaining ?? 0,
                materialsTotal: child.trackingRollup.materialsTotal ?? 0,
                laborCost: child.trackingRollup.laborCost ?? 0,
                totalCost: child.trackingRollup.totalCost ?? 0,
                updatedAt: child.trackingRollup.updatedAt
                  ? child.trackingRollup.updatedAt.toISOString()
                  : new Date().toISOString(),
              }
            : undefined,
        })),
        projectRates
      );
    } else {
      const tasks = await TaskModel.find({
        staging: { $exists: false },
        $or: [{ projectIds: projectId }, { projectId }],
      })
        .select('title hoursSpent hoursRemaining materials hourlyRate progressShare subtasks')
        .lean();

      tracking = computeLeafProjectTracking(
        tasks.map((task) => task as unknown as Record<string, unknown>),
        projectRates
      );
    }

    return {
      hourlyRate: projectRates.hourlyRate,
      trackingRollup: project.trackingRollup
        ? {
            hoursSpent: project.trackingRollup.hoursSpent ?? 0,
            hoursRemaining: project.trackingRollup.hoursRemaining ?? 0,
            materialsTotal: project.trackingRollup.materialsTotal ?? 0,
            laborCost: project.trackingRollup.laborCost ?? 0,
            totalCost: project.trackingRollup.totalCost ?? 0,
            updatedAt: project.trackingRollup.updatedAt
              ? project.trackingRollup.updatedAt.toISOString()
              : new Date().toISOString(),
          }
        : toStoredTrackingRollup(tracking.totals),
      totals: tracking.totals,
      lines: tracking.lines,
      tree: tracking.tree,
    };
  }

  async getDescendantProjectIds(projectId: string): Promise<string[]> {
    const descendants: string[] = [];
    let frontier = [projectId];

    while (frontier.length > 0) {
      const children = await ProjectModel.find({
        parentId: { $in: frontier },
        staging: { $exists: false },
      })
        .select('_id')
        .lean();

      const childIds = children.map((child) => String(child._id));
      descendants.push(...childIds);
      frontier = childIds;
    }

    return descendants;
  }

  async grantCollaboratorAccess(
    rootProjectId: string,
    targetUserId: string,
    role: CollaboratorRole
  ): Promise<void> {
    const projectIds = [rootProjectId, ...(await this.getDescendantProjectIds(rootProjectId))];

    for (const pid of projectIds) {
      const project = await ProjectModel.findById(pid);
      if (!project) continue;
      if (project.userId === targetUserId) continue;

      const collaborators = (project.collaborators ?? []).map((c) => ({
        userId: c.userId,
        role: c.role,
      }));
      const existing = collaborators.find((c) => c.userId === targetUserId);
      if (existing) {
        existing.role = role;
      } else {
        collaborators.push({ userId: targetUserId, role });
      }
      project.set('collaborators', collaborators);
      await project.save();
    }
  }

  private async removeCollaboratorFromTree(
    rootProjectId: string,
    collaboratorUserId: string
  ): Promise<void> {
    const projectIds = [rootProjectId, ...(await this.getDescendantProjectIds(rootProjectId))];

    for (const pid of projectIds) {
      const project = await ProjectModel.findById(pid);
      if (!project) continue;

      const before = project.collaborators.length;
      const remaining = project.collaborators
        .filter((c) => c.userId !== collaboratorUserId)
        .map((c) => ({ userId: c.userId, role: c.role }));
      if (remaining.length === before) continue;

      project.set('collaborators', remaining);
      await project.save();
    }
  }

  async getProjectShareSummary(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId, 'owner');

    const descendantIds = await this.getDescendantProjectIds(projectId);
    const directTaskCount = await TaskModel.countDocuments({
      staging: { $exists: false },
      $or: [{ projectIds: projectId }, { projectId }],
    });

    let descendantTaskCount = 0;
    for (const childId of descendantIds) {
      descendantTaskCount += await TaskModel.countDocuments({
        staging: { $exists: false },
        $or: [{ projectIds: childId }, { projectId: childId }],
      });
    }

    return {
      directTaskCount,
      descendantProjectCount: descendantIds.length,
      descendantTaskCount,
      totalTaskCount: directTaskCount + descendantTaskCount,
    };
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

    await this.grantCollaboratorAccess(projectId, targetId, role);
    const refreshed = await ProjectModel.findById(projectId);
    if (!refreshed) {
      throw new HttpError(404, 'Project not found');
    }
    return serializeProject(refreshed.toObject() as LeanProject, userId);
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

    const onRoot = (project.collaborators ?? []).some((c) => c.userId === collaboratorUserId);
    if (!onRoot) {
      throw new HttpError(404, 'Collaborator not found');
    }

    await this.removeCollaboratorFromTree(projectId, collaboratorUserId);

    const refreshed = await ProjectModel.findById(projectId);
    if (!refreshed) {
      throw new HttpError(404, 'Project not found');
    }

    if (isSelf && access.role !== 'owner') {
      return { left: true as const, project: null };
    }

    return {
      left: false as const,
      project: await serializeProject(refreshed.toObject() as LeanProject, userId),
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
        // Without a timeout, a stalled/overloaded Ollama instance would
        // hang this request indefinitely instead of falling back to the
        // plain-text summary below.
        signal: AbortSignal.timeout(60_000),
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
