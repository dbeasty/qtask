/**
 * A synthetic, qtask-shaped dataset for migration rehearsals, backup drills and benchmarks.
 *
 * NOT production data. Nothing here was derived from a production database: it is generated from
 * the Mongoose schemas (src/models/index.ts) and from guesses about how a task app is used. What it
 * is good for is exercising the migration path at a realistic *shape and scale* - every
 * collection, the relationships between them (owners, collaborators, task -> comments ->
 * notifications, one embedding job per entity), skewed per-user volumes, sub-document arrays,
 * 768-dimension embeddings on most tasks and projects (what nomic-embed-text produces), TTL'd
 * documents, unique fields. What it cannot tell you is how real data behaves: odd legacy shapes,
 * real text, real size outliers. Stage 0 of docs/KDB_MIGRATION.md still needs a restored copy of
 * production for that.
 *
 * Deterministic: the same seed and scale produce the same documents (ids included), so a run can
 * be repeated and two runs compared.
 *
 * Documents come out "raw" - the shape a service would hand to Mongoose. `castForMongo` runs them
 * through the model (defaults, casting, sub-document ObjectIds) exactly as a save would, and
 * `castForStore` additionally turns ObjectIds into strings, which is what the data layer's
 * MongoDataStore hands out and what KdbDataStore.importDocument expects.
 */

import mongoose from 'mongoose';
import type { CollectionName, Doc } from '../../src/data/types.js';
import { MODEL_BY_COLLECTION } from '../../src/data/modelNames.js';

export interface Scale {
  users: number;
  projects: number;
  tasks: number;
  comments: number;
  activities: number;
  conversations: number;
  notifications: number;
  invites: number;
  feedback: number;
  feedbackVisionJobs: number;
  llmCallMetrics: number;
  llmDailyMetrics: number;
  adminAudits: number;
  mcpApiKeys: number;
  mcpSessions: number;
  mcpOAuthClients: number;
  mcpOAuthAuthorizationCodes: number;
  mcpOAuthRefreshTokens: number;
  mcpOAuthPendingConsents: number;
  userOAuthAuthCodes: number;
}

/**
 * Collection sizes for a given number of tasks. The ratios are assumptions (stated so they can be
 * argued with), roughly: 50 tasks per user on average with a long tail, 4 projects per user, half
 * a comment and two activity entries per task, one embedding job per task and per project.
 */
export function scaleFor(tasks: number): Scale {
  const r = (ratio: number, min = 1) => Math.max(min, Math.round(tasks * ratio));
  return {
    users: r(0.02, 5),
    projects: r(0.08, 5),
    tasks,
    comments: r(0.5),
    activities: r(2),
    conversations: r(0.04),
    notifications: r(0.4),
    invites: r(0.03),
    feedback: r(0.003),
    feedbackVisionJobs: r(0.001),
    llmCallMetrics: r(0.3),
    llmDailyMetrics: r(0.03),
    adminAudits: r(0.003),
    mcpApiKeys: r(0.006),
    mcpSessions: r(0.02),
    mcpOAuthClients: r(0.0015),
    mcpOAuthAuthorizationCodes: r(0.0005),
    mcpOAuthRefreshTokens: r(0.01),
    mcpOAuthPendingConsents: r(0.0003),
    userOAuthAuthCodes: r(0.0002),
  };
}

/** Collections in the order they are generated (later ones reference earlier ones). */
export const GENERATED: Array<CollectionName> = [
  'users', 'projects', 'tasks', 'embeddingJobs', 'comments', 'activities', 'notifications',
  'conversations', 'invites', 'feedback', 'feedbackVisionJobs', 'llmCallMetrics', 'llmDailyMetrics',
  'adminAudits', 'mcpApiKeys', 'mcpSessions', 'mcpOAuthClients', 'mcpOAuthAuthorizationCodes',
  'mcpOAuthRefreshTokens', 'mcpOAuthPendingConsents', 'userOAuthAuthCodes', 'appMeta',
];

// --- deterministic randomness ----------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'the a to and of for in on with update review fix add remove check plan draft call email send ' +
  'meeting client invoice report budget design build test deploy release kitchen bathroom roof ' +
  'garden paint order materials quote schedule follow up contractor permit inspection tile floor ' +
  'cabinet window door wiring plumbing pipe drywall estimate labor hours deadline team weekly ' +
  'monthly quarterly sprint backlog feature bug customer support onboarding docs api database ' +
  'migration server backup monitor alert dashboard metrics invoice payment tax receipt vendor ' +
  'supplier shipment delivery warehouse inventory price discount contract signature legal note ' +
  'idea research prototype sketch mockup feedback survey interview hire train mentor goal ' +
  'milestone phase scope risk issue blocker dependency approve reject confirm cancel urgent ' +
  'tomorrow today next week friday monday after before during new old final second first'
).split(/\s+/);

const TAGS = [
  'urgent', 'client', 'home', 'work', 'finance', 'errand', 'design', 'backend', 'frontend', 'ops',
  'research', 'waiting', 'phone', 'email', 'weekly', 'q1', 'q2', 'q3', 'q4', 'personal', 'health',
  'garden', 'renovation', 'invoice', 'legal', 'travel', 'hiring', 'docs', 'bug', 'idea',
];

export class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Geometric-ish count with the given mean, capped. */
  count(mean: number, max: number): number {
    if (mean <= 0) return 0;
    const p = 1 / (mean + 1);
    let n = 0;
    while (n < max && this.next() > p) n++;
    return n;
  }
  /** Log-normal-ish length: most short, a long tail. */
  lengthTail(median: number, max: number): number {
    const z = Math.sqrt(-2 * Math.log(this.next() || 1e-9)) * Math.cos(2 * Math.PI * this.next());
    return Math.max(1, Math.min(max, Math.round(median * Math.exp(0.8 * z))));
  }
  words(n: number): string {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.pick(WORDS));
    const text = out.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  paragraph(medianWords: number, maxWords: number): string {
    return this.words(this.lengthTail(medianWords, maxWords));
  }
  hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
  /** A 768-dimension unit-ish vector, as nomic-embed-text returns (full double precision). */
  embedding(): number[] {
    const v: number[] = new Array(768);
    for (let i = 0; i < 768; i++) v[i] = (this.next() - 0.5) * 0.12;
    return v;
  }
}

// --- ids and time --------------------------------------------------------------------------

const DAY = 86_400_000;

/** An ObjectId whose timestamp is `at`, as MongoDB would have minted it then. */
function objectIdAt(rng: Rng, at: Date): string {
  return Math.floor(at.getTime() / 1000).toString(16).padStart(8, '0') + rng.hex(16);
}

export interface Dataset {
  scale: Scale;
  /** Every collection's documents, generated lazily in batches. */
  batches(name: CollectionName, size: number): Generator<Doc[]>;
  /** Ids generated so far, for callers that need to pick existing documents. */
  ids: { users: string[]; projects: string[]; tasks: string[] };
  /** Users with their task volume, heaviest first: for picking a "heavy" and a "typical" user. */
  userTaskCounts(): Array<{ userId: string; tasks: number }>;
}

export interface DatasetOptions {
  seed?: number;
  /** "Now" for the short-lived documents: auth codes, refresh tokens and LLM call metrics are
   *  stamped relative to it, so their TTLs behave as they would in production. */
  now?: Date;
  /** The end of the two-year window everything else falls in. Fixed by default, so ids (which carry
   *  their creation time, as ObjectIds do) are the same on every run with the same seed. */
  anchor?: Date;
  /** Fraction of tasks that carry an embedding (default 0.85). */
  embeddedFraction?: number;
}

/**
 * Builds the generator. Users, projects and task ids are materialised up front (small, and every
 * other collection references them); everything else is generated a batch at a time.
 */
export function createDataset(scale: Scale, options: DatasetOptions = {}): Dataset {
  const seed = options.seed ?? 20261015;
  const now = options.now ?? new Date();
  const anchor = options.anchor ?? new Date(Date.UTC(2026, 9, 1));
  const embeddedFraction = options.embeddedFraction ?? 0.85;
  const since = anchor.getTime() - 730 * DAY;
  const at = (rng: Rng, from = since, to = anchor.getTime()) => new Date(from + rng.next() * (to - from));

  // Users, with a Zipf-like weight: a handful of power users own a large share of the tasks.
  const userRng = new Rng(seed ^ 0x1001);
  const users: Doc[] = [];
  const weights: number[] = [];
  for (let i = 0; i < scale.users; i++) {
    const createdAt = at(userRng);
    const _id = objectIdAt(userRng, createdAt);
    const linked = userRng.chance(0.2);
    const provider = userRng.chance(0.7) ? 'google' : 'microsoft';
    users.push({
      _id,
      email: `user${i}.${userRng.hex(4)}@example.${userRng.pick(['com', 'org', 'net', 'io'])}`,
      passwordHash: linked && userRng.chance(0.5) ? undefined : `$2b$12$${userRng.hex(53)}`,
      displayName: userRng.chance(0.9) ? `${userRng.words(1)} ${userRng.words(1)}` : undefined,
      emailVerified: userRng.chance(0.85),
      legalAcceptedAt: createdAt,
      legalVersion: '2025-11',
      lastLoginAt: at(userRng, createdAt.getTime()),
      lastActiveAt: at(userRng, createdAt.getTime()),
      hourlyRate: userRng.chance(0.3) ? userRng.int(20, 180) : undefined,
      preferences: {
        theme: userRng.chance(0.4) ? 'dark' : 'light',
        trackExpenses: userRng.chance(0.6),
        startupView: userRng.pick(['auto', 'agent', 'projects', 'tasks', 'last']),
        completedDemoTour: userRng.chance(0.7),
      },
      identityProviders: linked
        ? [{ provider, providerUserId: `${provider}-${i}-${userRng.hex(10)}`, linkedAt: createdAt }]
        : [],
      createdAt,
      updatedAt: at(userRng, createdAt.getTime()),
    });
    weights.push(1 / Math.pow(i + 1, 0.9));
  }
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const cumulative: number[] = [];
  weights.reduce((acc, w, i) => (cumulative[i] = acc + w / weightTotal), 0);
  const pickUserIndex = (rng: Rng) => {
    const x = rng.next();
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // Projects: owned with the same skew, 20% nested under another of the owner's, 30% shared.
  const projectRng = new Rng(seed ^ 0x2002);
  const projects: Doc[] = [];
  const projectsByOwner = new Map<number, number[]>();
  const collaboratorsOf: string[][] = [];
  for (let i = 0; i < scale.projects; i++) {
    const owner = i < scale.users ? i : pickUserIndex(projectRng); // everyone has at least one
    const ownerId = users[owner]!._id as string;
    const createdAt = at(projectRng, Math.max(since, (users[owner]!.createdAt as Date).getTime()));
    const mine = projectsByOwner.get(owner) ?? [];
    const parent = mine.length > 0 && projectRng.chance(0.2) ? (projects[projectRng.pick(mine)]!._id as string) : null;
    const collaborators: Array<{ userId: string; role: string }> = [];
    if (projectRng.chance(0.3)) {
      const n = projectRng.int(1, 4);
      for (let c = 0; c < n; c++) {
        const other = users[projectRng.int(0, users.length - 1)]!._id as string;
        if (other !== ownerId && !collaborators.some((x) => x.userId === other)) {
          collaborators.push({ userId: other, role: projectRng.pick(['editor', 'executor', 'viewer', 'manager']) });
        }
      }
    }
    collaboratorsOf.push([ownerId, ...collaborators.map((c) => c.userId)]);
    const done = projectRng.chance(0.25);
    projects.push({
      _id: objectIdAt(projectRng, createdAt),
      userId: ownerId,
      name: projectRng.words(projectRng.int(1, 5)),
      description: projectRng.chance(0.6) ? projectRng.paragraph(25, 300) : undefined,
      notes: projectRng.chance(0.2) ? projectRng.paragraph(80, 1500) : undefined,
      parentId: parent,
      sortOrder: mine.length,
      status: done ? 'done' : projectRng.pick(['todo', 'in_progress', 'in_progress', 'todo', 'cancelled']),
      percentComplete: done ? 100 : projectRng.int(0, 95),
      hourlyRate: projectRng.chance(0.2) ? projectRng.int(30, 150) : undefined,
      trackingRollup: projectRng.chance(0.4)
        ? {
            hoursSpent: projectRng.int(0, 400), hoursRemaining: projectRng.int(0, 200),
            materialsTotal: projectRng.int(0, 20000), laborCost: projectRng.int(0, 30000),
            trainingCost: 0, totalCost: projectRng.int(0, 50000), updatedAt: at(projectRng, createdAt.getTime()),
          }
        : undefined,
      collaborators,
      embedding: projectRng.chance(0.85) ? projectRng.embedding() : undefined,
      createdAt,
      updatedAt: at(projectRng, createdAt.getTime()),
    });
    mine.push(i);
    projectsByOwner.set(owner, mine);
  }

  // Task skeletons (id, owner, project) up front so later collections can point at them.
  const skeletonRng = new Rng(seed ^ 0x3003);
  const taskIds: string[] = [];
  const taskOwner: number[] = [];
  const taskProject: number[] = [];
  const taskCreated: number[] = [];
  const userTaskCount = new Array<number>(users.length).fill(0);
  for (let i = 0; i < scale.tasks; i++) {
    const owner = pickUserIndex(skeletonRng);
    const mine = projectsByOwner.get(owner)!;
    const project = skeletonRng.pick(mine);
    const createdAt = at(skeletonRng, Math.max(since, (projects[project]!.createdAt as Date).getTime()));
    taskIds.push(objectIdAt(skeletonRng, createdAt));
    taskOwner.push(owner);
    taskProject.push(project);
    taskCreated.push(createdAt.getTime());
    userTaskCount[owner]!++;
  }

  const steps = (rng: Rng, mean: number) =>
    Array.from({ length: rng.count(mean, 25) }, () => ({ text: rng.words(rng.int(2, 12)), done: rng.chance(0.5) }));
  const materials = (rng: Rng) =>
    rng.chance(0.15)
      ? Array.from({ length: rng.int(1, 8) }, () => ({
          description: rng.words(rng.int(1, 6)), quantity: rng.int(1, 50), unitPrice: Math.round(rng.next() * 50000) / 100,
        }))
      : [];
  const labor = (rng: Rng) =>
    rng.chance(0.1) ? Array.from({ length: rng.int(1, 4) }, () => ({ description: rng.words(3), hours: rng.int(1, 16) })) : [];
  const subtask = (rng: Rng, depth: number, created: Date): Doc => ({
    title: rng.words(rng.int(2, 8)),
    description: rng.chance(0.3) ? rng.paragraph(15, 120) : undefined,
    steps: steps(rng, 1.5),
    status: rng.pick(['todo', 'todo', 'in_progress', 'done', 'done']),
    priority: rng.pick(['low', 'medium', 'medium', 'high']),
    dueDate: rng.chance(0.3) ? at(rng, created.getTime(), created.getTime() + 60 * DAY) : undefined,
    tags: rng.chance(0.2) ? [rng.pick(TAGS)] : [],
    percentComplete: rng.int(0, 100),
    materials: materials(rng),
    laborLines: labor(rng),
    subtasks: depth < 2 && rng.chance(0.1) ? Array.from({ length: rng.int(1, 3) }, () => subtask(rng, depth + 1, created)) : [],
    createdAt: created,
    updatedAt: created,
  });

  function task(i: number, rng: Rng): Doc {
    const createdAt = new Date(taskCreated[i]!);
    const projectIds = [projects[taskProject[i]!]!._id as string];
    if (rng.chance(0.05)) projectIds.push(projects[rng.int(0, projects.length - 1)]!._id as string);
    const status = rng.pick(['todo', 'todo', 'todo', 'in_progress', 'done', 'done', 'done', 'cancelled'] as const);
    const collaborators = collaboratorsOf[taskProject[i]!]!;
    return {
      _id: taskIds[i],
      userId: users[taskOwner[i]!]!._id,
      projectId: rng.chance(0.3) ? projectIds[0] : undefined, // legacy field still present on old tasks
      projectIds,
      title: rng.words(rng.int(3, 10)),
      description: rng.chance(0.6) ? rng.paragraph(30, 600) : undefined,
      steps: steps(rng, 3),
      status,
      priority: rng.pick(['low', 'medium', 'medium', 'medium', 'high', 'urgent']),
      dueDate: rng.chance(0.5) ? at(rng, createdAt.getTime(), createdAt.getTime() + 90 * DAY) : undefined,
      tags: Array.from(new Set(Array.from({ length: rng.count(1.2, 5) }, () => rng.pick(TAGS)))),
      percentComplete: status === 'done' ? 100 : rng.int(0, 90),
      hoursSpent: rng.chance(0.2) ? rng.int(0, 40) : undefined,
      hoursRemaining: rng.chance(0.15) ? rng.int(0, 40) : undefined,
      materials: materials(rng),
      laborLines: labor(rng),
      subtasks: rng.chance(0.3) ? Array.from({ length: rng.int(1, 6) }, () => subtask(rng, 1, createdAt)) : [],
      links: rng.chance(0.05) ? [{ taskId: taskIds[rng.int(0, Math.max(0, i - 1))], type: rng.pick(['related', 'blocking', 'blocked_by']) }] : [],
      sortOrder: rng.int(-5000, 5000),
      assigneeId: collaborators.length > 1 && rng.chance(0.3) ? rng.pick(collaborators) : undefined,
      embedding: rng.chance(embeddedFraction) ? rng.embedding() : undefined,
      staging: rng.chance(0.01) ? { conversationId: rng.hex(24), proposalId: rng.hex(12), stagedAt: createdAt } : undefined,
      createdAt,
      updatedAt: at(rng, createdAt.getTime()),
    };
  }

  const randomTask = (rng: Rng) => rng.int(0, taskIds.length - 1);
  const userOf = (index: number) => users[index]!._id as string;

  /** One generator per collection: `count` documents, made by `make(i, rng)`. */
  function* simple(name: CollectionName, count: number, size: number, make: (i: number, rng: Rng) => Doc): Generator<Doc[]> {
    const rng = new Rng(seed ^ hashName(name));
    let batch: Doc[] = [];
    for (let i = 0; i < count; i++) {
      batch.push(make(i, rng));
      if (batch.length === size) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  }

  const MODELS = ['qwen3.5:2b', 'qwen3.5:9b', 'nomic-embed-text'];

  function* batches(name: CollectionName, size: number): Generator<Doc[]> {
    switch (name) {
      case 'users':
        for (let i = 0; i < users.length; i += size) yield users.slice(i, i + size);
        return;
      case 'projects':
        for (let i = 0; i < projects.length; i += size) yield projects.slice(i, i + size);
        return;
      case 'tasks':
        yield* simple('tasks', scale.tasks, size, task);
        return;
      case 'embeddingJobs':
        // One per task and one per project: (entityType, entityId) is unique.
        yield* simple('embeddingJobs', taskIds.length + projects.length, size, (i, rng) => {
          const isTask = i < taskIds.length;
          const entityId = isTask ? taskIds[i]! : (projects[i - taskIds.length]!._id as string);
          const createdAt = isTask ? new Date(taskCreated[i]!) : (projects[i - taskIds.length]!.createdAt as Date);
          const status = rng.chance(0.97) ? 'completed' : rng.pick(['pending', 'failed', 'processing']);
          return {
            _id: objectIdAt(rng, createdAt), entityType: isTask ? 'task' : 'project', entityId,
            taskId: isTask ? entityId : undefined, status, attempts: status === 'failed' ? 3 : 1,
            lastError: status === 'failed' ? 'Ollama embedding failed (503): model loading' : undefined,
            dirty: false, createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'comments':
        yield* simple('comments', scale.comments, size, (i, rng) => {
          const t = randomTask(rng);
          const createdAt = at(rng, taskCreated[t]!);
          return {
            _id: objectIdAt(rng, createdAt), taskId: taskIds[t],
            subtaskPath: rng.chance(0.05) ? [rng.hex(24)] : [],
            userId: rng.pick(collaboratorsOf[taskProject[t]!]!), body: rng.paragraph(20, 400),
            parentId: rng.chance(0.1) ? objectIdAt(rng, createdAt) : undefined,
            editedAt: rng.chance(0.05) ? createdAt : undefined, createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'activities':
        yield* simple('activities', scale.activities, size, (i, rng) => {
          const t = randomTask(rng);
          const createdAt = at(rng, taskCreated[t]!);
          const action = rng.pick(['created', 'updated', 'status_changed', 'step_completed', 'commented', 'moved']);
          return {
            _id: objectIdAt(rng, createdAt), taskId: taskIds[t], userId: userOf(taskOwner[t]!), action,
            details: action === 'status_changed' ? { from: 'todo', to: rng.pick(['in_progress', 'done']) }
              : action === 'updated' ? { fields: [rng.pick(['title', 'description', 'dueDate', 'priority'])] } : {},
            source: rng.pick(['user', 'user', 'user', 'ai', 'system']), createdAt,
          };
        });
        return;
      case 'notifications':
        yield* simple('notifications', scale.notifications, size, (i, rng) => {
          const t = randomTask(rng);
          const createdAt = at(rng, taskCreated[t]!);
          const type = rng.pick(['task_comment', 'task_comment', 'task_comment_reply', 'project_invite', 'project_share_accepted', 'feedback_reply']);
          return {
            _id: objectIdAt(rng, createdAt), userId: rng.pick(collaboratorsOf[taskProject[t]!]!), type,
            payload: { taskId: taskIds[t], projectId: projects[taskProject[t]!]!._id, actorName: rng.words(2), preview: rng.words(rng.int(3, 20)) },
            read: rng.chance(0.7), createdAt,
          };
        });
        return;
      case 'conversations':
        yield* simple('conversations', scale.conversations, size, (i, rng) => {
          const owner = pickUserIndex(rng);
          const createdAt = at(rng);
          const n = rng.lengthTail(10, 120);
          const messages: Doc[] = [{ role: 'system', content: rng.paragraph(200, 400) }];
          for (let m = 0; m < n; m++) {
            const role = m % 2 === 0 ? 'user' : rng.chance(0.2) ? 'tool' : 'assistant';
            messages.push({
              role,
              content: role === 'user' ? rng.paragraph(15, 200) : rng.paragraph(60, 900),
              ...(role === 'assistant' && rng.chance(0.3)
                ? { toolCalls: [{ id: rng.hex(8), function: { name: 'create_task', arguments: { title: rng.words(5) } } }] }
                : {}),
              ...(role === 'tool' ? { toolName: rng.pick(['create_task', 'find_tasks', 'update_task']) } : {}),
            });
          }
          return {
            _id: objectIdAt(rng, createdAt), userId: userOf(owner),
            projectId: rng.chance(0.6) ? projects[rng.pick(projectsByOwner.get(owner)!)]!._id : undefined,
            title: rng.words(rng.int(2, 6)), messages,
            pendingProposals: rng.chance(0.05) ? [{ id: rng.hex(12), kind: 'create_task', payload: { title: rng.words(4) } }] : [],
            pausedBatch: null, createdAt, updatedAt: at(rng, createdAt.getTime()),
          };
        });
        return;
      case 'invites':
        yield* simple('invites', scale.invites, size, (i, rng) => {
          const p = rng.int(0, projects.length - 1);
          const createdAt = at(rng, (projects[p]!.createdAt as Date).getTime());
          const status = rng.pick(['pending', 'accepted', 'accepted', 'declined', 'expired']);
          return {
            _id: objectIdAt(rng, createdAt), projectId: projects[p]!._id, inviterUserId: projects[p]!.userId,
            inviteeEmail: `invitee${i}.${rng.hex(4)}@example.com`, inviteeUserId: status === 'accepted' ? userOf(rng.int(0, users.length - 1)) : undefined,
            role: rng.pick(['editor', 'executor', 'viewer', 'manager']), status, token: `inv_${rng.hex(40)}`,
            expiresAt: new Date(createdAt.getTime() + 14 * DAY), respondedAt: status === 'pending' ? undefined : createdAt,
            createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'feedback':
        yield* simple('feedback', scale.feedback, size, (i, rng) => {
          const createdAt = at(rng);
          return {
            _id: objectIdAt(rng, createdAt), userId: userOf(rng.int(0, users.length - 1)), message: rng.paragraph(40, 600),
            category: rng.pick(['bug', 'feature', 'other']), status: rng.pick(['open', 'read', 'resolved']), validationStatus: 'validated',
            context: { url: 'https://qtask.dev/tasks', userAgent: 'Mozilla/5.0 (Macintosh)', appVersion: '0.1.61' },
            attachments: rng.chance(0.3) ? [{ storageKey: `feedback/${rng.hex(24)}.png`, contentType: 'image/png', sizeBytes: rng.int(20000, 900000) }] : [],
            createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'feedbackVisionJobs':
        yield* simple('feedbackVisionJobs', scale.feedbackVisionJobs, size, (i, rng) => {
          const createdAt = at(rng);
          return { _id: objectIdAt(rng, createdAt), feedbackId: `fb${i}${rng.hex(20)}`, status: 'completed', attempts: 1, createdAt, updatedAt: createdAt };
        });
        return;
      case 'llmCallMetrics':
        yield* simple('llmCallMetrics', scale.llmCallMetrics, size, (i, rng) => {
          // The last 30 days only: Mongo's TTL index has removed anything older.
          const startedAt = at(rng, now.getTime() - 30 * DAY, now.getTime());
          const durationMs = rng.lengthTail(900, 60000);
          return {
            _id: objectIdAt(rng, startedAt), requestId: `req_${i}_${rng.hex(16)}`, userId: userOf(pickUserIndex(rng)),
            callType: rng.pick(['agent', 'agent', 'generate', 'embed']), source: rng.pick(['agent_loop', 'project_summary', 'embedding_job', 'semantic_search']),
            model: rng.pick(MODELS), startedAt, completedAt: new Date(startedAt.getTime() + durationMs), durationMs,
            success: rng.chance(0.97), degradedFallback: false, evalCount: rng.int(10, 900), promptEvalCount: rng.int(100, 6000),
            totalDurationNs: durationMs * 1e6, expiresAt: new Date(startedAt.getTime() + 30 * DAY),
          };
        });
        return;
      case 'llmDailyMetrics':
        yield* simple('llmDailyMetrics', scale.llmDailyMetrics, size, (i, rng) => {
          // (day, userId, callType, model) is unique: walk days x users deterministically.
          const day = new Date(Math.floor(now.getTime() / DAY) * DAY - Math.floor(i / 3) * DAY);
          const createdAt = day;
          return {
            _id: objectIdAt(rng, createdAt), day, userId: userOf(i % users.length), callType: ['agent', 'generate', 'embed'][i % 3],
            model: MODELS[i % 3], calls: rng.int(1, 300), successes: rng.int(1, 290), failures: rng.int(0, 5), degradedFallbacks: 0,
            durationMs: rng.int(1000, 900000), promptTokens: rng.int(100, 900000), evalTokens: rng.int(100, 200000), createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'adminAudits':
        yield* simple('adminAudits', scale.adminAudits, size, (i, rng) => {
          const createdAt = at(rng);
          const target = rng.int(0, users.length - 1);
          return {
            _id: objectIdAt(rng, createdAt), adminIdentity: 'admin@qtask.dev', action: rng.pick(['view_user', 'reset_password', 'disable_user', 'export']),
            targetUserId: userOf(target), targetEmail: users[target]!.email, details: { reason: rng.words(4) }, createdAt,
          };
        });
        return;
      case 'mcpApiKeys':
        yield* simple('mcpApiKeys', scale.mcpApiKeys, size, (i, rng) => {
          const createdAt = at(rng);
          return {
            _id: objectIdAt(rng, createdAt), userId: userOf(pickUserIndex(rng)), name: rng.words(2), prefix: `qtk_${rng.hex(6)}`,
            keyHash: rng.hex(64), scope: rng.pick(['read', 'read_write']), lastUsedAt: at(rng, createdAt.getTime()),
            revokedAt: rng.chance(0.1) ? at(rng, createdAt.getTime()) : undefined, createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'mcpSessions':
        yield* simple('mcpSessions', scale.mcpSessions, size, (i, rng) => {
          const createdAt = at(rng);
          return {
            _id: `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-a${rng.hex(3)}-${rng.hex(12)}`, // string id, as the MCP transport mints
            userId: userOf(pickUserIndex(rng)), keyId: rng.hex(24), activeProjectId: rng.chance(0.5) ? projects[rng.int(0, projects.length - 1)]!._id : undefined,
            pendingProposals: rng.chance(0.1) ? [{ id: rng.hex(12), kind: 'update_task', payload: { status: 'done' } }] : [], createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'mcpOAuthClients':
        yield* simple('mcpOAuthClients', scale.mcpOAuthClients, size, (i, rng) => {
          const createdAt = at(rng);
          return {
            _id: objectIdAt(rng, createdAt), clientId: `client_${i}_${rng.hex(16)}`, clientSecretHash: rng.chance(0.5) ? rng.hex(64) : undefined,
            name: rng.pick(['Claude', 'Cursor', 'ChatGPT', 'Custom agent']), userId: rng.chance(0.5) ? userOf(pickUserIndex(rng)) : undefined,
            redirectUris: [`https://client${i}.example.com/callback`], source: rng.pick(['registered', 'dcr', 'cimd']), createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'mcpOAuthAuthorizationCodes':
        // Short-lived: a few minutes either side of "now", so some are already past their TTL.
        yield* simple('mcpOAuthAuthorizationCodes', scale.mcpOAuthAuthorizationCodes, size, (i, rng) => {
          const createdAt = new Date(now.getTime() - rng.int(0, 600_000));
          return {
            _id: objectIdAt(rng, createdAt), codeHash: rng.hex(64), clientId: `client_${rng.int(0, Math.max(0, scale.mcpOAuthClients - 1))}`,
            userId: userOf(pickUserIndex(rng)), scope: 'tasks:read tasks:write', codeChallenge: rng.hex(43), codeChallengeMethod: 'S256',
            redirectUri: 'https://claude.ai/api/mcp/auth_callback', resource: 'https://qtask.dev/mcp',
            expiresAt: new Date(createdAt.getTime() + 600_000), createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'mcpOAuthRefreshTokens':
        yield* simple('mcpOAuthRefreshTokens', scale.mcpOAuthRefreshTokens, size, (i, rng) => {
          const createdAt = at(rng, now.getTime() - 29 * DAY, now.getTime());
          return {
            _id: objectIdAt(rng, createdAt), tokenHash: rng.hex(64), clientId: `client_${rng.int(0, Math.max(0, scale.mcpOAuthClients - 1))}`,
            userId: userOf(pickUserIndex(rng)), scope: 'tasks:read tasks:write', resource: 'https://qtask.dev/mcp',
            revokedAt: rng.chance(0.1) ? createdAt : undefined, expiresAt: new Date(createdAt.getTime() + 30 * DAY), createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'mcpOAuthPendingConsents':
        yield* simple('mcpOAuthPendingConsents', scale.mcpOAuthPendingConsents, size, (i, rng) => {
          const createdAt = new Date(now.getTime() - rng.int(0, 600_000));
          return {
            _id: objectIdAt(rng, createdAt), state: rng.hex(32), clientId: `client_${i}`, clientName: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback',
            scope: 'tasks:read', stateParam: rng.hex(16), codeChallenge: rng.hex(43), codeChallengeMethod: 'S256', resource: 'https://qtask.dev/mcp',
            expiresAt: new Date(createdAt.getTime() + 600_000), createdAt, updatedAt: createdAt,
          };
        });
        return;
      case 'userOAuthAuthCodes':
        yield* simple('userOAuthAuthCodes', scale.userOAuthAuthCodes, size, (i, rng) => {
          const createdAt = new Date(now.getTime() - rng.int(0, 120_000));
          return { _id: objectIdAt(rng, createdAt), codeHash: rng.hex(64), userId: userOf(pickUserIndex(rng)), expiresAt: new Date(createdAt.getTime() + 120_000), createdAt, updatedAt: createdAt };
        });
        return;
      case 'appMeta': {
        // The one-shot migration markers a long-running deployment has (src/db/migrations.ts).
        const rng = new Rng(seed ^ 0x9009);
        yield ['search_embedding_v1', 'llm_metrics_call_types_v1'].map((key) => ({ _id: objectIdAt(rng, new Date(since)), key, at: new Date(since) }));
        return;
      }
      default:
        return;
    }
  }

  return {
    scale,
    batches,
    ids: { users: users.map((u) => u._id as string), projects: projects.map((p) => p._id as string), tasks: taskIds },
    userTaskCounts: () =>
      userTaskCount.map((tasks, i) => ({ userId: users[i]!._id as string, tasks })).sort((a, b) => b.tasks - a.tasks),
  };
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Drops keys whose value is undefined, as a BSON encoder would. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out as T;
  }
  return value;
}

/**
 * A raw document as Mongoose would store it: through the model, so defaults, enum casting and
 * sub-document `_id`s are exactly what a save produces. Timestamps are taken from the document
 * (a save would stamp "now"). `__v: 0` as every Mongoose-created document has.
 */
export function castForMongo(name: CollectionName, raw: Doc): Record<string, unknown> {
  const Model = mongoose.models[MODEL_BY_COLLECTION[name]];
  if (!Model) throw new Error(`model for ${name} is not registered - import src/models/index.js first`);
  const doc = new Model(stripUndefined(raw));
  const out = doc.toObject({ depopulate: true, versionKey: true, flattenMaps: true }) as Record<string, unknown>;
  for (const key of ['createdAt', 'updatedAt'] as const) if (raw[key] instanceof Date) out[key] = raw[key];
  if (name !== 'appMeta') out.__v = 0;
  return out;
}

/** What the data layer's Mongo store hands out for that document: ObjectIds as strings. */
export function castForStore(name: CollectionName, raw: Doc): Doc {
  return toPlain(castForMongo(name, raw)) as Doc;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toPlain(item);
    return out;
  }
  return value;
}
