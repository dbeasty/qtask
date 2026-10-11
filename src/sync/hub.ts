/**
 * The cloud side: an authenticated, per-user view of the hub engine.
 *
 * `HubAuthorizer` is what makes the hub "just another peer" safely. A device may
 * pull only its own scope and the projects it owns or collaborates on, and may push
 * only what its role in the target project allows. The decisions are made from the
 * hub's own stored state (project owner, collaborator list), never from what the
 * pushing device claims — including the `scope` it labels a document with, which the
 * hub recomputes itself.
 */

import { Router, type Request, type Response } from 'express';
import { decodeValue } from './codec.js';
import { isReplicated, projectScope, userScope } from './policy.js';
import { getHubEngine } from './runtime.js';
import type { SyncDataStore } from './tracker.js';
import type { SyncAuthorizer, WireDoc } from './types.js';
import { roleAtLeast, type ProjectRole } from '../types/project.js';
import type { Doc } from '../data/types.js';

/** What an `executor` may change on a task: report progress, not edit content. */
export const EXECUTOR_TASK_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'hoursSpent',
  'hoursRemaining',
  'percentCompleteOverride',
  'subtasks',
]);

/** Project fields only the owner may change. */
const OWNER_ONLY_PROJECT_FIELDS: ReadonlySet<string> = new Set(['collaborators', 'userId']);

export class HubAuthorizer implements SyncAuthorizer {
  constructor(
    private readonly store: SyncDataStore,
    readonly userId: string
  ) {}

  private get inner() {
    return this.store.inner;
  }

  async readableScopes(): Promise<Set<string>> {
    const scopes = new Set<string>([userScope(this.userId)]);
    const projects = await this.inner.collection('projects').find(
      { $or: [{ userId: this.userId }, { 'collaborators.userId': this.userId }] },
      { select: '_id' }
    );
    for (const project of projects) scopes.add(projectScope(String(project._id)));
    return scopes;
  }

  /** Role lookups repeat for every document of a project in a batch, so they are memoised. */
  private readonly roles = new Map<string, { role: ProjectRole | null; exists: boolean }>();
  private readonly taskProjects = new Map<string, string | undefined>();

  private async roleIn(projectId: string): Promise<{ role: ProjectRole | null; exists: boolean }> {
    const cached = this.roles.get(projectId);
    if (cached) return cached;
    const project = await this.inner.collection('projects').findById(projectId);
    let result: { role: ProjectRole | null; exists: boolean };
    if (!project) result = { role: null, exists: false };
    else if (project.userId === this.userId) result = { role: 'owner', exists: true };
    else {
      const collaborators = (project.collaborators ?? []) as Array<{ userId: string; role: string }>;
      const found = collaborators.find((c) => c.userId === this.userId);
      result = { role: (found?.role as ProjectRole) ?? null, exists: true };
    }
    this.roles.set(projectId, result);
    return result;
  }

  private projectIdOf(coll: string, id: string, fieldValue: (n: string) => unknown, existing: Doc | null): string | undefined {
    if (coll === 'projects') return id;
    const source = (name: string) => existing?.[name] ?? fieldValue(name);
    const single = source('projectId');
    if (typeof single === 'string' && single) return single;
    const many = source('projectIds');
    if (Array.isArray(many) && typeof many[0] === 'string') return many[0] as string;
    return undefined;
  }

  async checkWrite(wire: WireDoc, existing: Doc | null, changed: string[]): Promise<string | null> {
    // A project document is about to change, which can change roles: forget what we cached.
    if (wire.coll === 'projects') {
      this.roles.clear();
      this.taskProjects.clear();
    }
    return this.checkWriteUncached(wire, existing, changed);
  }

  private async checkWriteUncached(wire: WireDoc, existing: Doc | null, changed: string[]): Promise<string | null> {
    if (!isReplicated(wire.coll)) return 'collection does not replicate';
    const uid = this.userId;
    const incoming = (name: string): unknown => {
      const field = wire.fields[name];
      return field && !field.x ? decodeValue(field.v) : undefined;
    };
    const isDelete = Boolean(wire.del) && Object.keys(wire.fields).length === 0;
    const authorId = (existing?.userId ?? incoming('userId')) as string | undefined;

    // Users only ever write documents they own, whatever the collection.
    const personalOnly = wire.coll === 'conversations' || wire.coll === 'notifications';
    let projectId = personalOnly ? undefined : this.projectIdOf(wire.coll, wire.id, incoming, existing);
    if ((wire.coll === 'comments' || wire.coll === 'activities') && !projectId) {
      const taskId = (existing?.taskId ?? incoming('taskId')) as string | undefined;
      if (taskId) {
        if (!this.taskProjects.has(taskId)) {
          const task = await this.inner.collection('tasks').findById(taskId);
          this.taskProjects.set(taskId, task ? this.projectIdOf('tasks', taskId, () => undefined, task) : undefined);
        }
        projectId = this.taskProjects.get(taskId);
      }
    }

    if (!projectId) {
      if (authorId !== uid) return 'document belongs to another user';
      if (existing && 'userId' in Object.fromEntries(changed.map((n) => [n, 1])) && incoming('userId') !== uid) {
        return 'cannot reassign ownership';
      }
      return null;
    }

    const { role, exists } = await this.roleIn(projectId);
    if (!exists) {
      // The project has not been pushed yet (batches are ordered by change, not by
      // dependency). Only the author may stage documents against it.
      if (wire.coll === 'projects') return authorId === uid ? null : 'project belongs to another user';
      return authorId === uid ? null : 'project unknown and document is not yours';
    }
    if (!role) return 'not a member of the project';

    switch (wire.coll) {
      case 'projects': {
        if (role === 'owner') return null;
        if (isDelete) return 'only the owner can delete a project';
        if (!roleAtLeast(role, 'manager')) return `role ${role} cannot edit the project`;
        if (changed.some((name) => OWNER_ONLY_PROJECT_FIELDS.has(name))) return 'only the owner can change members';
        return null;
      }
      case 'tasks': {
        if (isDelete) {
          if (role === 'owner') return null;
          if (role === 'editor' && existing?.userId === uid) return null;
          return `role ${role} cannot delete this task`;
        }
        if (role === 'viewer') return 'viewers cannot edit';
        if (role === 'executor') {
          if (!existing) return 'executors cannot create tasks';
          const outside = changed.filter((name) => !EXECUTOR_TASK_FIELDS.has(name));
          return outside.length ? `executors may not change ${outside.join(', ')}` : null;
        }
        if (!existing && authorId !== uid) return 'new tasks must be authored by the pushing user';
        if (existing && changed.includes('userId') && role !== 'owner') return 'cannot reassign ownership';
        // Moving a task into another project needs write access there too.
        const target = this.projectIdOf('tasks', wire.id, incoming, null);
        if (target && target !== projectId && changed.some((n) => n === 'projectId' || n === 'projectIds')) {
          const moved = await this.roleIn(target);
          if (moved.exists && (!moved.role || !roleAtLeast(moved.role, 'editor'))) {
            return 'no edit access to the destination project';
          }
        }
        return null;
      }
      case 'comments':
      case 'activities': {
        if (!roleAtLeast(role, 'executor')) return 'viewers cannot comment';
        if (existing && existing.userId !== uid && !roleAtLeast(role, 'manager')) {
          return 'cannot change another user\'s entry';
        }
        if (!existing && authorId !== uid) return 'new entries must be authored by the pushing user';
        return null;
      }
      default:
        return null;
    }
  }
}

/** Express router for `/api/sync`. Mount behind `requireAuth`. */
export function createSyncRouter(): Router {
  const router = Router();

  function serviceFor(req: Request, res: Response) {
    const engine = getHubEngine();
    if (!engine) {
      res.status(503).json({ error: 'Sync is not enabled on this server' });
      return undefined;
    }
    const userId = req.auth!.userId;
    return engine.service(new HubAuthorizer(engine.store, userId));
  }

  router.post('/hello', async (req, res, next) => {
    try {
      const service = serviceFor(req, res);
      if (service) res.json(await service.hello(req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post('/pull', async (req, res, next) => {
    try {
      const service = serviceFor(req, res);
      if (!service) return;
      const { from, cursor, limit, sig } = req.body ?? {};
      if (typeof from !== 'string' || typeof cursor !== 'number' || typeof limit !== 'number') {
        res.status(400).json({ error: 'from, cursor and limit are required' });
        return;
      }
      res.json(await service.pull({ from, cursor, limit, sig: typeof sig === 'string' ? sig : undefined }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/push', async (req, res, next) => {
    try {
      const service = serviceFor(req, res);
      if (!service) return;
      const { from, docs, more } = req.body ?? {};
      if (typeof from !== 'string' || !Array.isArray(docs)) {
        res.status(400).json({ error: 'from and docs are required' });
        return;
      }
      res.json(await service.push({ from, docs, more: more === true }));
    } catch (error) {
      next(error);
    }
  });

  // Liveness for the device's "can I reach the hub" check; deliberately says nothing
  // about how much data the server holds.
  router.get('/status', (req, res) => {
    const engine = getHubEngine();
    if (!engine) {
      res.status(503).json({ error: 'Sync is not enabled on this server' });
      return;
    }
    res.json({ role: engine.role, nodeId: engine.nodeId, serverTime: new Date().toISOString() });
  });

  return router;
}
