/**
 * qtask's workload as data-layer calls.
 *
 * Each action is one user-visible request, replayed as the exact sequence of `collection()` calls
 * the service makes for it - same collections, filters, sorts, limits, projections and update
 * operators, in the same order and with the same parallelism. The source of each is cited
 * (file:line) here and in bench/README.md; when a service changes, this is what to re-check.
 *
 * What is deliberately left out: HTTP, auth JWT verification, serialisation, in-process scoring
 * in search, and calls to Ollama/email/object storage. Those cost the same whichever database is
 * underneath; this benchmark is about the part that does not.
 */

import type { Collection, CollectionName, Doc } from '../../src/data/types.ts';
import { Histogram, intBetween, pick, weighted } from './stats.ts';
import { SEARCH_TERMS, runtimeId, type DatasetIndex, type UserIndex } from './dataset.ts';

export type CollectionFn = <T extends Doc = Doc>(name: CollectionName) => Collection<T>;

const READ_METHODS = new Set(['find', 'findOne', 'findById', 'countDocuments', 'distinct']);

/** Per data-layer call latency, keyed `collection.method`. */
export class OpRecorder {
  readonly ops = new Map<string, Histogram>();
  reads = 0;
  writes = 0;
  enabled = true;

  record(key: string, ms: number, isRead: boolean): void {
    if (!this.enabled) return;
    let h = this.ops.get(key);
    if (!h) this.ops.set(key, (h = new Histogram()));
    h.record(ms);
    if (isRead) this.reads++;
    else this.writes++;
  }
}

/** Wraps the data layer so every call is timed. The wrapper adds one closure per call. */
export function instrument(base: CollectionFn, recorder: OpRecorder): CollectionFn {
  const cache = new Map<string, Collection<Doc>>();
  return (<T extends Doc>(name: CollectionName) => {
    let wrapped = cache.get(name);
    if (!wrapped) {
      const inner = base(name);
      wrapped = new Proxy(inner, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          const method = String(prop);
          return async (...args: unknown[]) => {
            const started = performance.now();
            try {
              return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            } finally {
              recorder.record(`${name}.${method}`, performance.now() - started, READ_METHODS.has(method));
            }
          };
        },
      }) as Collection<Doc>;
      cache.set(name, wrapped);
    }
    return wrapped as unknown as Collection<T>;
  }) as CollectionFn;
}

// --- profiles ---------------------------------------------------------------------------------

export type ActionName =
  | 'listTasks' | 'getTask' | 'taskActivity' | 'listProjects' | 'unreadCount' | 'listNotifications'
  | 'search' | 'workload' | 'me' | 'mcpFindTasks' | 'login' | 'listConversations'
  | 'updateTask' | 'createTask' | 'addComment' | 'markNotificationsRead' | 'agentTurn'
  | 'createProject' | 'deleteTask' | 'register';

export const READ_ACTIONS: ActionName[] = [
  'listTasks', 'getTask', 'taskActivity', 'listProjects', 'unreadCount', 'listNotifications',
  'search', 'workload', 'me', 'mcpFindTasks', 'login', 'listConversations',
];

/**
 * The mixed profile: relative frequency of each user action, per 100 actions. qtask has no request
 * telemetry to derive this from, so it is modelled on what the client does (see README): every
 * screen polls the unread count, navigation lists tasks and projects, opening a task loads it and
 * its comments, and edits are a minority of requests. `login` includes its user write.
 */
const MIXED: Record<ActionName, number> = {
  listTasks: 18, getTask: 14, taskActivity: 2, listProjects: 7, unreadCount: 12, listNotifications: 3,
  search: 4, workload: 2, me: 3, mcpFindTasks: 6, login: 1, listConversations: 1,
  updateTask: 12, createTask: 4, addComment: 4, markNotificationsRead: 3, agentTurn: 2,
  createProject: 0.5, deleteTask: 1, register: 0.2,
};

function scaled(base: Record<ActionName, number>, readFactor: number, writeFactor: number): Record<ActionName, number> {
  return Object.fromEntries(
    Object.entries(base).map(([k, w]) => [k, w * (READ_ACTIONS.includes(k as ActionName) ? readFactor : writeFactor)])
  ) as Record<ActionName, number>;
}

export const PROFILES: Record<string, Record<ActionName, number>> = {
  mixed: MIXED,
  'read-heavy': scaled(MIXED, 1, 0.2),
  'write-heavy': scaled(MIXED, 0.35, 3),
};

// --- actions ----------------------------------------------------------------------------------

const LIST_SORT = { sortOrder: 1, createdAt: -1, _id: 1 } as const; // taskService.ts:459
const NOT_STAGED = { staging: { $exists: false } };

export interface SessionState {
  user: UserIndex;
  /** Tasks this worker created, which deleteTask may remove (so the dataset's own tasks stay). */
  created: string[];
}

export class Workload {
  private readonly users: UserIndex[];
  private readonly cumulative: number[];
  private readonly totalWeight: number;
  private ordinal = 0;
  private readonly touched = new Set<string>();
  private readonly createdByUser = new Map<string, string[]>();
  /** Tasks in projects shared with a user, for commenting on someone else's task. */
  private readonly projectTasks = new Map<string, string[]>();

  constructor(
    private readonly c: CollectionFn,
    index: DatasetIndex,
    private readonly random: () => number,
    private readonly salt: number
  ) {
    this.users = index.users;
    let sum = 0;
    this.cumulative = this.users.map((u) => (sum += u.weight));
    this.totalWeight = sum;
  }

  /** A user to act as, weighted by activity (a few users are much busier than most). */
  pickUser(): UserIndex {
    const roll = this.random() * this.totalWeight;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid]! < roll) lo = mid + 1;
      else hi = mid;
    }
    return this.users[lo]!;
  }

  pickAction(profile: Record<ActionName, number>): ActionName {
    return weighted(this.random, profile);
  }

  private newId(): string {
    return runtimeId(this.salt, ++this.ordinal);
  }

  async run(action: ActionName, user: UserIndex): Promise<void> {
    // auth.ts:15-27: requireAuth touches lastActiveAt at most once per user per 15 minutes per
    // process, without awaiting it. A run is shorter than that, so: once per user per worker.
    if (!this.touched.has(user.id)) {
      this.touched.add(user.id);
      void this.c('users').updateOne({ _id: user.id }, { $set: { lastActiveAt: new Date() } }).catch(() => undefined);
    }
    switch (action) {
      case 'listTasks': return this.listTasks(user);
      case 'getTask': return this.getTask(user);
      case 'taskActivity': return this.taskActivity(user);
      case 'listProjects': return this.listProjects(user);
      case 'unreadCount': return this.unreadCount(user);
      case 'listNotifications': return this.listNotifications(user);
      case 'search': return this.search(user);
      case 'workload': return this.workload(user);
      case 'me': return this.me(user);
      case 'mcpFindTasks': return this.mcpFindTasks(user);
      case 'login': return this.login(user);
      case 'listConversations': return this.listConversations(user);
      case 'updateTask': return this.updateTask(user);
      case 'createTask': return this.createTask(user);
      case 'addComment': return this.addComment(user);
      case 'markNotificationsRead': return this.markNotificationsRead(user);
      case 'agentTurn': return this.agentTurn(user);
      case 'createProject': return this.createProject(user);
      case 'deleteTask': return this.deleteTask(user);
      case 'register': return this.register();
    }
  }

  // --- shared service fragments ---------------------------------------------------------------

  /** projectService.ts:280 accessibleProjectFilter */
  private accessFilter(userId: string) {
    return { ...NOT_STAGED, $or: [{ userId }, { 'collaborators.userId': userId }] };
  }

  /** taskService.ts:232 accessibleTaskQuery (+ listAccessibleProjectIds, projectService.ts:287) */
  private async accessibleTaskQuery(userId: string): Promise<Record<string, unknown>> {
    const projects = await this.c('projects').find(this.accessFilter(userId), { select: '_id' });
    const ids = projects.map((p) => String(p._id));
    if (ids.length === 0) return { userId };
    return { $or: [{ userId }, { projectIds: { $in: ids } }, { projectId: { $in: ids } }] };
  }

  /** projectService.ts:301 getProjectAccess */
  private projectAccess(userId: string, projectId: string) {
    return this.c('projects').findOne({ _id: projectId, ...this.accessFilter(userId) });
  }

  /** taskService.ts:287 loadAccessibleTaskWithRole: the task, then each of its projects in turn. */
  private async loadTask(userId: string, taskId: string): Promise<Doc | null> {
    const task = await this.c('tasks').findById(taskId);
    if (!task) return null;
    const projectIds = (task.projectIds as string[] | undefined) ?? [];
    for (const pid of projectIds) {
      if (await this.projectAccess(userId, pid)) return task;
    }
    return task.userId === userId ? task : null;
  }

  /** embeddingQueue.ts:30-73 enqueueEntityEmbeddingJob: two exclusive conditional updates. */
  private async enqueueEmbedding(entityType: 'task' | 'project', entityId: string): Promise<void> {
    const jobs = this.c('embeddingJobs');
    const dirty = await jobs.updateOne({ entityType, entityId, status: 'processing' }, { $set: { dirty: true }, $unset: { lastError: '' } });
    if (dirty.matched === 0) {
      await jobs.updateOne(
        { entityType, entityId },
        {
          $set: { entityType, entityId, ...(entityType === 'task' ? { taskId: entityId } : {}), status: 'pending' },
          $setOnInsert: { attempts: 0, dirty: false },
          $unset: { lastError: '' },
        },
        { upsert: true }
      );
    }
  }

  /** activityService.ts:7-21 logActivity */
  private logActivity(taskId: string, userId: string, action: string, details: Doc) {
    return this.c('activities').create({ taskId, userId, action, details, source: 'user' });
  }

  /**
   * projectService.ts:851 recalculateProjects: for each project and each ancestor, the status
   * rollup (:901) and the tracking rollup (:956). A leaf project reads all of its tasks twice.
   */
  private async recalculateProjects(projectIds: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const start of projectIds) {
      let id: string | null = start;
      while (id && !seen.has(id)) {
        seen.add(id);
        const node: Doc | null = await this.c('projects').findById(id, { select: '_id parentId' });
        if (!node) break;
        await this.recalculateSingleProject(id);
        await this.recalculateSingleProjectTracking(id);
        id = (node.parentId as string | null) ?? null;
      }
    }
  }

  private async recalculateSingleProject(id: string): Promise<void> {
    const children = await this.c('projects').find({ parentId: id, ...NOT_STAGED }, { select: 'status percentComplete progressShare' });
    let percent = 0;
    let status = 'todo';
    if (children.length === 0) {
      const tasks = await this.c('tasks').find({ ...NOT_STAGED, $or: [{ projectIds: id }, { projectId: id }] }, { select: 'status percentComplete' });
      const live = tasks.filter((t) => t.status !== 'cancelled');
      percent = live.length ? Math.round(live.reduce((s, t) => s + Number(t.percentComplete ?? 0), 0) / live.length) : 0;
      status = live.length && live.every((t) => t.status === 'done') ? 'done' : live.some((t) => t.status !== 'todo') ? 'in_progress' : 'todo';
    } else {
      percent = Math.round(children.reduce((s, p) => s + Number(p.percentComplete ?? 0), 0) / children.length);
      status = percent === 100 ? 'done' : percent > 0 ? 'in_progress' : 'todo';
    }
    const current = await this.c('projects').findById(id, { select: 'doneOverride' });
    if (current?.doneOverride) status = 'done';
    await this.c('projects').updateOne({ _id: id }, { $set: { status, percentComplete: percent } });
  }

  private async recalculateSingleProjectTracking(id: string): Promise<void> {
    await this.c('projects').findById(id, { select: 'hourlyRate parentId' });
    const children = await this.c('projects').find({ parentId: id, ...NOT_STAGED }, { select: 'progressShare trackingRollup' });
    let hoursSpent = 0;
    let materialsTotal = 0;
    if (children.length === 0) {
      const tasks = await this.c('tasks').find(
        { ...NOT_STAGED, $or: [{ projectIds: id }, { projectId: id }] },
        { select: 'title hoursSpent hoursRemaining materials hourlyRate progressShare subtasks' }
      );
      for (const t of tasks) {
        hoursSpent += Number(t.hoursSpent ?? 0);
        for (const m of (t.materials as Array<{ quantity: number; unitPrice: number }> | undefined) ?? []) materialsTotal += m.quantity * m.unitPrice;
      }
    } else {
      for (const p of children) hoursSpent += Number((p.trackingRollup as Doc | undefined)?.hoursSpent ?? 0);
    }
    await this.c('projects').updateOne(
      { _id: id },
      { $set: { trackingRollup: { hoursSpent, hoursRemaining: 0, materialsTotal: Math.round(materialsTotal * 100) / 100, laborCost: 0, trainingCost: 0, totalCost: Math.round(materialsTotal * 100) / 100, updatedAt: new Date() } } }
    );
  }

  private someTask(user: UserIndex): string | undefined {
    const created = this.createdByUser.get(user.id);
    if (created?.length && this.random() < 0.2) return pick(this.random, created);
    return user.taskIds.length ? pick(this.random, user.taskIds) : undefined;
  }

  // --- read actions -----------------------------------------------------------------------------

  /** GET /api/tasks (routes/tasks.ts:184; taskService.ts:470, :552). Default limit 200. */
  async listTasks(user: UserIndex): Promise<void> {
    const roll = this.random();
    let projectId: string | undefined;
    const writable = [...user.ownProjectIds, ...user.sharedProjectIds];
    if (roll < 0.35 && writable.length) {
      projectId = pick(this.random, writable);
      await this.projectAccess(user.id, projectId);
    }
    const query: Record<string, unknown> = { ...(await this.accessibleTaskQuery(user.id)), ...NOT_STAGED };
    if (projectId) query.$and = [{ $or: [{ projectIds: projectId }, { projectId }] }];
    if (this.random() < 0.3) query.status = { $in: ['todo', 'in_progress'] };
    const offset = this.random() < 0.1 ? 200 : 0;
    await Promise.all([
      this.c('tasks').find(query, { sort: LIST_SORT, limit: 200, skip: offset }),
      this.c('tasks').countDocuments(query),
    ]);
  }

  /** GET /api/tasks/:id + its comments (taskService.ts:287; commentService.ts:195-199, :55). */
  async getTask(user: UserIndex): Promise<void> {
    const taskId = this.someTask(user);
    if (!taskId) return;
    const task = await this.loadTask(user.id, taskId);
    if (!task) return;
    // commentService.ts:44 subtaskPathQuery for the root
    const comments = await this.c('comments').find(
      { taskId, $or: [{ subtaskPath: { $exists: false } }, { subtaskPath: { $size: 0 } }] },
      { sort: { createdAt: 1 } }
    );
    const authors = [...new Set(comments.map((c) => String(c.userId)))];
    if (authors.length) await this.c('users').find({ _id: { $in: authors } }, { select: 'email displayName' });
  }

  /** GET /api/tasks/:id/activity (activityService.ts:24) */
  async taskActivity(user: UserIndex): Promise<void> {
    const taskId = this.someTask(user);
    if (!taskId) return;
    if (!(await this.loadTask(user.id, taskId))) return;
    await this.c('activities').find({ taskId }, { sort: { createdAt: -1 }, limit: 50 });
  }

  /** GET /api/projects (projectService.ts:647; ensureDefaultProject :252-254; users :145) */
  async listProjects(user: UserIndex): Promise<void> {
    await this.c('projects').countDocuments({ userId: user.id, ...NOT_STAGED });
    await this.c('projects').findOne({ userId: user.id, ...NOT_STAGED }, { sort: { createdAt: 1 } });
    const projects = await this.c('projects').find(this.accessFilter(user.id), { sort: { sortOrder: 1, createdAt: 1 } });
    const people = new Set<string>();
    for (const p of projects) {
      people.add(String(p.userId));
      for (const c of (p.collaborators as Array<{ userId: string }> | undefined) ?? []) people.add(c.userId);
    }
    await this.c('users').find({ _id: { $in: [...people] } }, { select: 'email displayName' });
  }

  /** GET /api/notifications/unread-count (notificationService.ts:81): polled by every open client. */
  async unreadCount(user: UserIndex): Promise<void> {
    await this.c('notifications').countDocuments({ userId: user.id, read: false });
  }

  /** GET /api/notifications (notificationService.ts:69) */
  async listNotifications(user: UserIndex): Promise<void> {
    await this.c('notifications').find({ userId: user.id }, { sort: { createdAt: -1 }, limit: 50 });
  }

  /**
   * GET /api/search (searchService.ts:335): projects and tasks in parallel, each a lexical
   * candidate read and a semantic candidate read of up to 500 full documents (:41, :245), then
   * the project names of the hits (:200). Scoring is in process and not timed.
   */
  async search(user: UserIndex): Promise<void> {
    const term = pick(this.random, SEARCH_TERMS);
    const taskArm = async () => {
      const base = { ...(await this.accessibleTaskQuery(user.id)), ...NOT_STAGED };
      const text = await this.c('tasks').find(base, { sort: { updatedAt: -1 }, limit: 500 });
      await this.c('tasks').find({ ...base, embedding: { $exists: true, $ne: [] } }, { sort: { updatedAt: -1 }, limit: 500 });
      const hits = text.filter((t) => String(t.title ?? '').toLowerCase().includes(term)).slice(0, 20);
      const pids = [...new Set(hits.flatMap((t) => (t.projectIds as string[]) ?? []))];
      if (pids.length) await this.c('projects').find({ _id: { $in: pids } }, { select: '_id name' });
    };
    const projectArm = async () => {
      const base = this.accessFilter(user.id);
      await this.c('projects').find(base, { sort: { updatedAt: -1 }, limit: 500 });
      await this.c('projects').find({ ...base, embedding: { $exists: true, $ne: [] } }, { sort: { updatedAt: -1 }, limit: 500 });
    };
    await Promise.all([taskArm(), projectArm()]);
  }

  /** GET /api/tasks/workload (taskService.ts:842): open tasks, no sort, no limit. */
  async workload(user: UserIndex): Promise<void> {
    const q = { ...(await this.accessibleTaskQuery(user.id)), ...NOT_STAGED, status: { $in: ['todo', 'in_progress'] } };
    await this.c('tasks').find(q);
  }

  /** GET /api/auth/me (authService.ts:613) */
  async me(user: UserIndex): Promise<void> {
    await this.c('users').findById(user.id);
  }

  /** POST /api/auth/login (authService.ts:197, :217): lookup by email, then save lastLoginAt. */
  async login(user: UserIndex): Promise<void> {
    const found = await this.c('users').findOne({ email: user.email });
    if (!found) return;
    await this.c('users').replaceOne({ _id: found._id }, { ...found, lastLoginAt: new Date() });
  }

  /**
   * One MCP request: API-key auth (mcpKeyService.ts:73, a write on every request), session lookup
   * and touch (mcpSessionService.ts:44, :52), then find_tasks for the active project (tools.ts:293
   * -> listTasks unpaginated, taskService.ts:569). Users without a key fall back to listTasks.
   */
  async mcpFindTasks(user: UserIndex): Promise<void> {
    if (!user.apiKeyHash || user.mcpSessionIds.length === 0) return this.listTasks(user);
    const key = await this.c('mcpApiKeys').findOneAndUpdate(
      { keyHash: user.apiKeyHash, revokedAt: { $exists: false } },
      { $set: { lastUsedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!key) throw new Error('mcp key not found');
    const sid = pick(this.random, user.mcpSessionIds);
    const session = await this.c('mcpSessions').findOne({ _id: sid, userId: user.id });
    await this.c('mcpSessions').updateOne({ _id: sid, userId: user.id }, { $set: { updatedAt: new Date() } });
    const projectId = (session?.activeProjectId as string | undefined) ?? user.ownProjectIds[0];
    if (projectId) await this.projectAccess(user.id, projectId);
    const query: Record<string, unknown> = { ...(await this.accessibleTaskQuery(user.id)), ...NOT_STAGED };
    if (projectId) query.$and = [{ $or: [{ projectIds: projectId }, { projectId }] }];
    await this.c('tasks').find(query, { sort: LIST_SORT });
  }

  /** GET /api/conversations (conversationService.ts:131) */
  async listConversations(user: UserIndex): Promise<void> {
    await this.c('conversations').find({ userId: user.id }, { sort: { updatedAt: -1 }, select: 'userId projectId title createdAt updatedAt' });
  }

  // --- write actions ----------------------------------------------------------------------------

  /**
   * PATCH /api/tasks/:id (taskService.ts:590-691): load with access check, change it in memory,
   * write the whole document back (replaceOne, :85 - the app issues no $set/$push on tasks),
   * enqueue an embedding, log the activity, roll the projects up.
   */
  async updateTask(user: UserIndex): Promise<void> {
    const taskId = this.someTask(user);
    if (!taskId) return;
    const task = await this.loadTask(user.id, taskId);
    if (!task) return;
    const kind = weighted(this.random, { status: 30, percent: 20, toggleStep: 30, addStep: 10, title: 10 });
    const steps = ((task.steps as Doc[] | undefined) ?? []).map((s) => ({ ...s }));
    const changes: Doc = {};
    if (kind === 'status') task.status = changes.status = pick(this.random, ['todo', 'in_progress', 'done']);
    else if (kind === 'percent') task.percentComplete = changes.percentComplete = intBetween(this.random, 0, 100);
    else if (kind === 'toggleStep' && steps.length) {
      const step = pick(this.random, steps);
      step.done = !step.done;
      changes.steps = steps.length;
    } else if (kind === 'addStep' || kind === 'toggleStep') {
      steps.push({ _id: this.newId(), text: 'Bench step', done: false });
      changes.steps = steps.length;
    } else task.title = changes.title = `Bench edit ${this.ordinal}`;
    task.steps = steps;
    await this.c('tasks').replaceOne({ _id: taskId }, task);
    await this.enqueueEmbedding('task', taskId);
    await this.logActivity(taskId, user.id, 'task.updated', changes);
    await this.recalculateProjects((task.projectIds as string[]) ?? []);
  }

  /** POST /api/tasks (taskService.ts:355-440) with steps and sometimes subtasks. */
  async createTask(user: UserIndex): Promise<void> {
    const writable = [...user.ownProjectIds, ...user.sharedProjectIds];
    const projectId = writable.length ? pick(this.random, writable) : undefined;
    if (projectId) await this.projectAccess(user.id, projectId);
    else {
      await this.c('projects').countDocuments({ userId: user.id, ...NOT_STAGED });
      await this.c('projects').findOne({ userId: user.id, ...NOT_STAGED }, { sort: { createdAt: 1 } });
    }
    let sortOrder = 0;
    if (projectId) {
      const first = await this.c('tasks').findOne({ $or: [{ projectIds: projectId }, { projectId }], ...NOT_STAGED }, { sort: { sortOrder: 1 }, select: 'sortOrder' });
      sortOrder = Number(first?.sortOrder ?? 0) - 1;
    }
    const id = this.newId();
    await this.c('tasks').create({
      _id: id,
      userId: user.id,
      projectIds: projectId ? [projectId] : [],
      title: `Bench task ${this.ordinal}`,
      description: 'Created by the database benchmark: invoice roof kitchen budget',
      steps: Array.from({ length: intBetween(this.random, 0, 6) }, (_, i) => ({ _id: this.newId(), text: `Step ${i + 1}`, done: false })),
      subtasks: this.random() < 0.25 ? [{ _id: this.newId(), title: 'Bench subtask', steps: [{ _id: this.newId(), text: 'Sub step', done: false }] }] : [],
      status: 'todo',
      priority: pick(this.random, ['low', 'medium', 'high']),
      tags: [pick(this.random, SEARCH_TERMS)],
      sortOrder,
    });
    const mine = this.createdByUser.get(user.id) ?? [];
    mine.push(id);
    this.createdByUser.set(user.id, mine);
    await this.enqueueEmbedding('task', id);
    await this.logActivity(id, user.id, 'task.created', { title: `Bench task ${this.ordinal}` });
    if (projectId) await this.recalculateProjects([projectId]);
  }

  /** POST /api/tasks/:id/comments (commentService.ts:211-307). */
  async addComment(user: UserIndex): Promise<void> {
    const taskId = this.someTask(user);
    if (!taskId) return;
    const task = await this.loadTask(user.id, taskId);
    if (!task) return;
    await this.c('comments').create({ taskId, subtaskPath: [], userId: user.id, body: 'Benchmark comment about the invoice and the roof' });
    await this.logActivity(taskId, user.id, 'comment.added', {});
    await this.c('users').findById(user.id, { select: 'email displayName' });
    const recipients = [task.userId, task.assigneeId].filter((r): r is string => typeof r === 'string' && r !== user.id);
    if (recipients.length) {
      const pid = ((task.projectIds as string[]) ?? [])[0];
      if (pid) await this.c('projects').findById(pid, { select: 'name' });
      await this.c('users').find({ _id: { $in: recipients } }, { select: 'email displayName' });
      for (const r of new Set(recipients)) {
        await this.c('notifications').create({ userId: r, type: 'task_comment', payload: { taskId, actorUserId: user.id }, read: false });
      }
    }
    await this.enqueueEmbedding('task', taskId);
  }

  /** Opening the notification panel: list, then mark one or all read (notificationService.ts:85, :105). */
  async markNotificationsRead(user: UserIndex): Promise<void> {
    const list = await this.c('notifications').find({ userId: user.id }, { sort: { createdAt: -1 }, limit: 50 });
    if (this.random() < 0.3) {
      await this.c('notifications').updateMany({ userId: user.id, read: false }, { $set: { read: true } });
      return;
    }
    const target = list.find((n) => !n.read) ?? list[0];
    if (target) await this.c('notifications').findOneAndUpdate({ _id: target._id, userId: user.id }, { $set: { read: true } }, { returnDocument: 'after' });
  }

  /**
   * One agent chat turn's persistence (agentService.ts:1240+, conversationService.ts:119, :235):
   * load the conversation, rewrite its whole message history, load it again. The LLM call and
   * any tool calls are not included.
   */
  async agentTurn(user: UserIndex): Promise<void> {
    const list = await this.c('conversations').find({ userId: user.id }, { sort: { updatedAt: -1 }, select: 'userId projectId title createdAt updatedAt', limit: 1 });
    const id = list[0]?._id as string | undefined;
    if (!id) return;
    const conversation = await this.c('conversations').findOne({ _id: id, userId: user.id });
    if (!conversation) return;
    const messages = [...((conversation.messages as Doc[]) ?? []), { role: 'user', content: 'What is overdue on the roof job?' }, { role: 'assistant', content: 'Three tasks: the permit, the tiles order and the inspection.' }];
    // Keep the history bounded so a long run does not grow one document without limit.
    await this.c('conversations').findOneAndUpdate({ _id: id, userId: user.id }, { $set: { messages: messages.slice(-40) } }, { returnDocument: 'after' });
    await this.c('conversations').findOne({ _id: id, userId: user.id });
  }

  /** POST /api/projects (projectService.ts:491-557), top level. */
  async createProject(user: UserIndex): Promise<void> {
    const last = await this.c('projects').findOne({ userId: user.id, parentId: null, ...NOT_STAGED }, { sort: { sortOrder: -1 }, select: 'sortOrder' });
    const id = this.newId();
    await this.c('projects').create({ _id: id, userId: user.id, name: `Bench project ${this.ordinal}`, description: 'Created by the benchmark', parentId: null, sortOrder: Number(last?.sortOrder ?? 0) + 1, collaborators: [] });
    await this.enqueueEmbedding('project', id);
    const project = await this.c('projects').findById(id);
    await this.c('users').find({ _id: { $in: [String(project?.userId ?? user.id)] } }, { select: 'email displayName' });
  }

  /** DELETE /api/tasks/:id (taskService.ts:693-711): delete, cascade comments, log, roll up.
   *  Only tasks this worker created, so the dataset's own tasks stay for the other actions. */
  async deleteTask(user: UserIndex): Promise<void> {
    const mine = this.createdByUser.get(user.id);
    if (!mine?.length) return this.createTask(user);
    const id = mine.splice(Math.floor(this.random() * mine.length), 1)[0]!;
    const task = await this.loadTask(user.id, id);
    if (!task) return;
    await this.c('tasks').deleteOne({ _id: id });
    await this.c('comments').deleteMany({ taskId: id });
    await this.logActivity(id, user.id, 'task.deleted', {});
    await this.recalculateProjects((task.projectIds as string[]) ?? []);
  }

  /** POST /api/auth/register (authService.ts:150-160; ensureDefaultProject projectService.ts:250). */
  async register(): Promise<void> {
    const email = `bench.reg.${this.salt}.${++this.ordinal}.${Date.now()}@bench.qtask.test`;
    if (await this.c('users').findOne({ email })) return;
    const created = await this.c('users').create({ email, passwordHash: '$2b$10$benchbenchbenchbenchbenchbenchbenchbenchbenchbenchbe', displayName: 'Bench registrant', legalAcceptedAt: new Date(), legalVersion: '2026-01' });
    await this.c('projects').countDocuments({ userId: created._id, ...NOT_STAGED });
    await this.c('projects').create({ _id: this.newId(), userId: created._id, name: 'My tasks', parentId: null, sortOrder: 0, collaborators: [] });
  }
}

// --- queues -----------------------------------------------------------------------------------

/**
 * embeddingQueue.ts:158-162 - the claim, exactly. Returns the job or null.
 */
export function claimEmbeddingJob(c: CollectionFn) {
  return c('embeddingJobs').findOneAndUpdate(
    { status: 'pending', attempts: { $lt: 3 } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

/** embeddingQueue.ts:129-150 finishEmbeddingJob */
export async function finishEmbeddingJob(c: CollectionFn, jobId: string, status: 'completed' | 'failed'): Promise<void> {
  const requeued = await c('embeddingJobs').updateOne({ _id: jobId, dirty: true }, { $set: { status: 'pending', dirty: false }, $unset: { lastError: '' } });
  if (requeued.matched === 0) {
    await c('embeddingJobs').updateOne({ _id: jobId, dirty: { $ne: true } }, { $set: { status, dirty: false }, $unset: { lastError: '' } });
  }
}

/**
 * One embedding job, as the worker runs it for a task (embeddingQueue.ts:197-239): read the task,
 * its projects' names, its comments and their authors, (Ollama), write the embedding back.
 */
export async function processEmbeddingJob(c: CollectionFn, job: Doc, ollamaDelayMs: number, dims: number): Promise<void> {
  const entityId = String(job.entityId);
  if (job.entityType === 'project') {
    const project = await c('projects').findById(entityId);
    if (ollamaDelayMs) await new Promise((r) => setTimeout(r, ollamaDelayMs));
    if (project) await c('projects').updateOne({ _id: entityId }, { $set: { embedding: fakeEmbedding(dims) } });
    return finishEmbeddingJob(c, String(job._id), project ? 'completed' : 'failed');
  }
  const task = await c('tasks').findById(entityId);
  if (!task) return finishEmbeddingJob(c, String(job._id), 'failed');
  const pids = (task.projectIds as string[]) ?? [];
  if (pids.length) await c('projects').find({ _id: { $in: pids } }, { select: 'name' });
  const comments = await c('comments').find({ taskId: entityId }, { sort: { createdAt: 1 }, select: 'body subtaskPath userId' });
  const authors = [...new Set(comments.map((x) => String(x.userId)))];
  if (authors.length) await c('users').find({ _id: { $in: authors } }, { select: 'email displayName' });
  if (ollamaDelayMs) await new Promise((r) => setTimeout(r, ollamaDelayMs));
  await c('tasks').updateOne({ _id: entityId }, { $set: { embedding: fakeEmbedding(dims) } });
  await finishEmbeddingJob(c, String(job._id), 'completed');
}

function fakeEmbedding(dims: number): number[] {
  return Array.from({ length: dims }, () => (Math.random() - 0.5) * 0.2);
}

/** feedbackVisionQueue.ts:68-72 - the claim, exactly (no attempts guard). */
export function claimVisionJob(c: CollectionFn) {
  return c('feedbackVisionJobs').findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { sort: { updatedAt: 1 }, returnDocument: 'after' }
  );
}

/** feedbackVisionQueue.ts:117 complete, then :28-48 enqueue again (a re-submitted screenshot),
 *  which keeps the queue at a steady depth for as long as the test runs. */
export async function completeAndRequeueVisionJob(c: CollectionFn, job: Doc): Promise<void> {
  await c('feedbackVisionJobs').updateOne({ _id: job._id }, { $set: { status: 'completed' }, $unset: { lastError: '' } });
  const existing = await c('feedbackVisionJobs').findOne({ feedbackId: job.feedbackId });
  if (existing?.status === 'processing') return;
  await c('feedbackVisionJobs').updateOne(
    { feedbackId: job.feedbackId },
    { $set: { status: 'pending', feedbackId: job.feedbackId }, $unset: { lastError: '' }, $setOnInsert: { attempts: 0 } },
    { upsert: true }
  );
}
