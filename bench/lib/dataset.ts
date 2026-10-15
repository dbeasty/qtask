/**
 * A deterministic, qtask-shaped dataset (src/models/index.ts), generated in batches so a
 * production-sized one never has to fit in memory at once.
 *
 * Every id is derived from (collection code, ordinal), so the load generator can name any
 * document without asking the database for it, and the same seed gives the same bytes on every
 * run. ObjectId timestamps follow createdAt, so MongoDB's natural (insertion) order and the KDB
 * store's (_id) order agree.
 */

import { createHash } from 'node:crypto';
import { rng, intBetween, pick, weighted } from './stats.ts';

export interface Scale {
  name: string;
  users: number;
  /** Mean tasks per user; the per-user count is skewed (a few heavy users, many light ones). */
  tasks: number;
  projectsPerUser: number;
  /** Fraction of projects shared with collaborators. */
  sharedProjectFraction: number;
  commentsPerTask: number;
  notificationsPerUser: number;
  activitiesPerTask: number;
  conversationsPerUser: number;
  /** Dimensions of the stored embedding (nomic-embed-text is 768); 0 stores none. */
  embeddingDims: number;
  /** Fraction of tasks/projects that already carry an embedding (the worker embeds everything). */
  embeddedFraction: number;
  /** Pending jobs left in each queue for the claim test to work through. */
  pendingEmbeddingJobs: number;
  pendingVisionJobs: number;
}

export const SCALES: Record<string, Scale> = {
  smoke: {
    name: 'smoke', users: 40, tasks: 1_500, projectsPerUser: 4, sharedProjectFraction: 0.3,
    commentsPerTask: 0.5, notificationsPerUser: 30, activitiesPerTask: 2, conversationsPerUser: 2,
    embeddingDims: 768, embeddedFraction: 0.9, pendingEmbeddingJobs: 300, pendingVisionJobs: 100,
  },
  small: {
    name: 'small', users: 200, tasks: 10_000, projectsPerUser: 5, sharedProjectFraction: 0.3,
    commentsPerTask: 0.5, notificationsPerUser: 40, activitiesPerTask: 2, conversationsPerUser: 3,
    embeddingDims: 768, embeddedFraction: 0.9, pendingEmbeddingJobs: 2_000, pendingVisionJobs: 300,
  },
  prod: {
    name: 'prod', users: 1_000, tasks: 100_000, projectsPerUser: 5, sharedProjectFraction: 0.3,
    commentsPerTask: 0.5, notificationsPerUser: 50, activitiesPerTask: 2, conversationsPerUser: 3,
    embeddingDims: 768, embeddedFraction: 0.9, pendingEmbeddingJobs: 20_000, pendingVisionJobs: 2_000,
  },
};

/** Two-hex collection codes inside generated ObjectIds: ids are unique across collections, which
 *  the KDB store needs (every collection shares one namespace). */
const CODE = {
  users: 0x01, projects: 0x02, tasks: 0x03, steps: 0x04, subtasks: 0x05, materials: 0x06,
  comments: 0x07, notifications: 0x08, activities: 0x09, embeddingJobs: 0x0a, conversations: 0x0b,
  mcpApiKeys: 0x0c, invites: 0x0d, feedback: 0x0e, feedbackVisionJobs: 0x0f, labor: 0x10,
  bench: 0x20,
} as const;

const EPOCH = Date.UTC(2025, 9, 15) / 1000; // dataset spans the year before 2026-10-15
const SPAN = 365 * 24 * 3600;

/** An ObjectId-shaped id: 4-byte timestamp, collection code, a seed byte, 6-byte ordinal. */
export function objectId(code: number, ordinal: number, atSec: number, seedByte = 0xb3): string {
  return (
    Math.floor(atSec).toString(16).padStart(8, '0') +
    code.toString(16).padStart(2, '0') +
    seedByte.toString(16).padStart(2, '0') +
    ordinal.toString(16).padStart(12, '0')
  );
}

export const userId = (i: number) => objectId(CODE.users, i, EPOCH + 1 + i);
export const userEmail = (i: number) => `bench.user${i}@bench.qtask.test`;
/** What mcpKeyService stores: sha256 of the raw key. */
export const apiKeyHash = (i: number) => createHash('sha256').update(`qtk_bench_${i}`).digest('hex');
export const mcpSessionId = (keyIndex: number, n: number) =>
  `5e55${keyIndex.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** Ids the load generator creates at run time: a distinct code so they never collide with data. */
export function runtimeId(workerSalt: number, ordinal: number): string {
  return objectId(CODE.bench, ordinal, Date.now() / 1000, workerSalt & 0xff);
}

const WORDS = [
  'invoice', 'roof', 'garden', 'kitchen', 'quote', 'client', 'deploy', 'release', 'review', 'design',
  'budget', 'order', 'supplier', 'paint', 'tiles', 'plumbing', 'wiring', 'inspection', 'permit', 'meeting',
  'report', 'draft', 'migrate', 'backup', 'server', 'database', 'onboarding', 'training', 'audit', 'schedule',
  'delivery', 'estimate', 'contract', 'repair', 'fence', 'window', 'door', 'flooring', 'cabinet', 'lighting',
  'marketing', 'website', 'newsletter', 'payroll', 'tax', 'insurance', 'vehicle', 'maintenance', 'cleanup', 'survey',
];
/** Words the search workload looks for: common enough to hit, specific enough to filter. */
export const SEARCH_TERMS = ['invoice', 'roof', 'kitchen', 'deploy', 'budget', 'permit', 'payroll', 'fence'];

function sentence(random: () => number, min: number, max: number): string {
  const n = intBetween(random, min, max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(random, WORDS));
  const text = out.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function embedding(random: () => number, dims: number): number[] {
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) out[i] = (random() - 0.5) * 0.2;
  return out;
}

const STATUSES = { todo: 45, in_progress: 25, done: 25, cancelled: 5 } as const;
const PRIORITIES = { low: 25, medium: 45, high: 22, urgent: 8 } as const;
const ROLES = { editor: 50, viewer: 25, executor: 15, manager: 10 } as const;

export interface UserIndex {
  i: number;
  id: string;
  email: string;
  /** Relative activity weight: who the simulated sessions act as. */
  weight: number;
  ownProjectIds: string[];
  /** Projects shared with this user (collaborator). */
  sharedProjectIds: string[];
  taskIds: string[];
  apiKeyHash?: string;
  mcpSessionIds: string[];
}

export interface DatasetIndex {
  scale: Scale;
  seed: number;
  users: UserIndex[];
  counts: Record<string, number>;
}

export interface Batch {
  collection: string;
  docs: Record<string, unknown>[];
}

/**
 * Generates the dataset. `sink` receives batches in dependency order (users, projects, then per
 * user their tasks and everything hanging off them). Returns the index the load generator uses.
 */
export async function generate(scale: Scale, seed: number, sink: (batch: Batch) => Promise<void>): Promise<DatasetIndex> {
  const random = rng(seed);
  const counts: Record<string, number> = {};
  const emit = async (collection: string, docs: Record<string, unknown>[]) => {
    if (docs.length === 0) return;
    counts[collection] = (counts[collection] ?? 0) + docs.length;
    await sink({ collection, docs });
  };
  const ord: Record<string, number> = {};
  const next = (code: keyof typeof CODE) => (ord[code] = (ord[code] ?? 0) + 1);
  const at = (frac: number) => EPOCH + Math.floor(frac * SPAN);
  const dateAt = (sec: number) => new Date(sec * 1000);

  // --- users ----------------------------------------------------------------------------------
  const users: UserIndex[] = [];
  const userDocs: Record<string, unknown>[] = [];
  for (let i = 0; i < scale.users; i++) {
    // Activity is skewed: a power law over users, so a few are much busier than the rest.
    const weight = 1 / Math.pow(i + 1, 0.6);
    const created = EPOCH + 1 + i;
    users.push({ i, id: userId(i), email: userEmail(i), weight, ownProjectIds: [], sharedProjectIds: [], taskIds: [], mcpSessionIds: [] });
    userDocs.push({
      _id: userId(i),
      email: userEmail(i),
      // A real bcrypt hash shape (cost 10); the benchmark never verifies it.
      passwordHash: '$2b$10$' + createHash('sha256').update(`pw${i}`).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 53).padEnd(53, 'x'),
      displayName: `Bench User ${i}`,
      emailVerified: true,
      legalAcceptedAt: dateAt(created),
      legalVersion: '2026-01',
      lastLoginAt: dateAt(at(0.9 + random() * 0.1)),
      lastActiveAt: dateAt(at(0.95 + random() * 0.05)),
      mustChangePassword: false,
      hourlyRate: random() < 0.4 ? intBetween(random, 20, 120) : undefined,
      preferences: { autoApproveProposals: false, skipConfirmations: false, trackExpenses: true, agentEnterToSend: true, completedDemoTour: true, theme: random() < 0.5 ? 'dark' : 'light', startupView: 'last' },
      identityProviders: random() < 0.3 ? [{ provider: 'google', providerUserId: `g-${i}`, linkedAt: dateAt(created) }] : [],
      createdAt: dateAt(created),
      updatedAt: dateAt(at(0.95)),
    });
  }
  for (let b = 0; b < userDocs.length; b += 500) await emit('users', userDocs.slice(b, b + 500));

  // --- projects (with collaborators) ----------------------------------------------------------
  const projectDocs: Record<string, unknown>[] = [];
  const allProjects: Array<{ id: string; owner: number; collaborators: number[] }> = [];
  for (const user of users) {
    const n = Math.max(1, Math.round(scale.projectsPerUser * (0.5 + random())));
    for (let p = 0; p < n; p++) {
      const created = at(random() * 0.5);
      const id = objectId(CODE.projects, next('projects'), created);
      const collaborators: number[] = [];
      if (scale.users > 1 && random() < scale.sharedProjectFraction) {
        const k = intBetween(random, 1, 3);
        for (let c = 0; c < k; c++) {
          const other = Math.floor(random() * scale.users);
          if (other !== user.i && !collaborators.includes(other)) collaborators.push(other);
        }
      }
      allProjects.push({ id, owner: user.i, collaborators });
      user.ownProjectIds.push(id);
      for (const c of collaborators) users[c]!.sharedProjectIds.push(id);
      const parent = p > 0 && random() < 0.15 ? user.ownProjectIds[0] : null;
      projectDocs.push({
        _id: id,
        userId: user.id,
        name: sentence(random, 1, 3),
        description: sentence(random, 4, 14),
        notes: random() < 0.3 ? sentence(random, 5, 30) : undefined,
        parentId: parent,
        sortOrder: p,
        status: weighted(random, { todo: 40, in_progress: 40, done: 20 }),
        percentComplete: intBetween(random, 0, 100),
        doneOverride: false,
        hourlyRate: random() < 0.3 ? intBetween(random, 30, 90) : undefined,
        trackingRollup: { hoursSpent: intBetween(random, 0, 200), hoursRemaining: intBetween(random, 0, 100), materialsTotal: intBetween(random, 0, 5000), laborCost: 0, trainingCost: 0, totalCost: intBetween(random, 0, 9000), updatedAt: dateAt(at(0.9)) },
        collaborators: collaborators.map((c) => ({ userId: users[c]!.id, role: weighted(random, ROLES) })),
        embedding: scale.embeddingDims && random() < scale.embeddedFraction ? embedding(random, scale.embeddingDims) : undefined,
        createdAt: dateAt(created),
        updatedAt: dateAt(at(0.5 + random() * 0.5)),
      });
    }
  }
  projectDocs.sort((a, b) => String(a._id).localeCompare(String(b._id)));
  for (let b = 0; b < projectDocs.length; b += 200) await emit('projects', projectDocs.slice(b, b + 200));

  // --- per user: tasks and everything that hangs off them ---------------------------------------
  const totalWeight = users.reduce((s, u) => s + Math.sqrt(u.weight), 0);
  const stepDoc = (random: () => number, sec: number) => ({ _id: objectId(CODE.steps, next('steps'), sec), text: sentence(random, 2, 7), done: random() < 0.4 });
  const materialDoc = (random: () => number, sec: number) => ({ _id: objectId(CODE.materials, next('materials'), sec), description: sentence(random, 1, 4), quantity: intBetween(random, 1, 40), unitPrice: Math.round(random() * 20000) / 100 });

  let pendingEmbedding = scale.pendingEmbeddingJobs;
  for (const user of users) {
    // Heavier users own more tasks; the total is scale.tasks.
    const n = Math.max(1, Math.round((scale.tasks * Math.sqrt(user.weight)) / totalWeight));
    const writableProjects = [...user.ownProjectIds, ...user.sharedProjectIds];
    const tasks: Record<string, unknown>[] = [];
    const jobs: Record<string, unknown>[] = [];
    const comments: Record<string, unknown>[] = [];
    const activities: Record<string, unknown>[] = [];
    for (let t = 0; t < n; t++) {
      const created = at(0.3 + random() * 0.69);
      const id = objectId(CODE.tasks, next('tasks'), created);
      user.taskIds.push(id);
      const status = weighted(random, STATUSES);
      const subtaskCount = random() < 0.25 ? intBetween(random, 1, 4) : 0;
      const embedded = scale.embeddingDims > 0 && random() < scale.embeddedFraction;
      const projectId = writableProjects.length && random() < 0.85 ? pick(random, writableProjects) : undefined;
      tasks.push({
        _id: id,
        userId: user.id,
        projectIds: projectId ? [projectId] : [],
        title: sentence(random, 2, 6),
        description: random() < 0.8 ? sentence(random, 5, 40) : undefined,
        steps: Array.from({ length: random() < 0.6 ? intBetween(random, 1, 8) : 0 }, () => stepDoc(random, created)),
        status,
        priority: weighted(random, PRIORITIES),
        dueDate: random() < 0.5 ? dateAt(at(0.6 + random() * 0.6)) : undefined,
        tags: Array.from({ length: intBetween(random, 0, 3) }, () => pick(random, WORDS)),
        percentComplete: status === 'done' ? 100 : intBetween(random, 0, 90),
        hoursSpent: random() < 0.3 ? intBetween(random, 0, 40) : undefined,
        hoursRemaining: random() < 0.3 ? intBetween(random, 0, 40) : undefined,
        materials: Array.from({ length: random() < 0.2 ? intBetween(random, 1, 5) : 0 }, () => materialDoc(random, created)),
        laborLines: random() < 0.1 ? [{ _id: objectId(CODE.labor, next('labor'), created), description: 'Labour', hours: intBetween(random, 1, 16) }] : [],
        subtasks: Array.from({ length: subtaskCount }, () => ({
          _id: objectId(CODE.subtasks, next('subtasks'), created),
          title: sentence(random, 2, 5),
          steps: Array.from({ length: intBetween(random, 0, 4) }, () => stepDoc(random, created)),
          status: weighted(random, STATUSES),
          priority: 'medium',
          tags: [],
          percentComplete: intBetween(random, 0, 100),
          materials: [],
          laborLines: [],
          links: [],
          subtasks: [],
          createdAt: dateAt(created),
          updatedAt: dateAt(created),
        })),
        links: [],
        sortOrder: t,
        assigneeId: random() < 0.1 ? user.id : undefined,
        embedding: embedded ? embedding(random, scale.embeddingDims) : undefined,
        createdAt: dateAt(created),
        updatedAt: dateAt(Math.min(EPOCH + SPAN, created + Math.floor(random() * 30 * 24 * 3600))),
      });
      // One embedding job per entity (unique on entityType + entityId); most have finished.
      const pending = !embedded && pendingEmbedding > 0;
      if (pending) pendingEmbedding--;
      jobs.push({
        _id: objectId(CODE.embeddingJobs, next('embeddingJobs'), created),
        entityType: 'task', entityId: id, taskId: id,
        status: pending ? 'pending' : embedded ? 'completed' : 'failed',
        attempts: pending ? 0 : 1, dirty: false,
        createdAt: dateAt(created), updatedAt: dateAt(created + 5),
      });
      for (let c = 0; c < Math.floor(scale.commentsPerTask + random()); c++) {
        const sec = created + intBetween(random, 60, 86_400 * 10);
        const author = projectId && random() < 0.4 ? users[Math.floor(random() * users.length)]!.id : user.id;
        comments.push({
          _id: objectId(CODE.comments, next('comments'), sec), taskId: id, subtaskPath: [], userId: author,
          body: sentence(random, 3, 30), createdAt: dateAt(sec), updatedAt: dateAt(sec),
        });
      }
      for (let a = 0; a < Math.round(scale.activitiesPerTask); a++) {
        const sec = created + a * 3600;
        activities.push({
          _id: objectId(CODE.activities, next('activities'), sec), taskId: id, userId: user.id,
          action: a === 0 ? 'created' : pick(random, ['updated', 'status_changed', 'step_completed']),
          details: a === 0 ? { title: 'created' } : { field: 'status', to: status },
          source: random() < 0.2 ? 'ai' : 'user', createdAt: dateAt(sec),
        });
      }
    }
    await emit('tasks', tasks);
    await emit('embeddingJobs', jobs);
    await emit('comments', comments.sort((a, b) => String(a._id).localeCompare(String(b._id))));
    await emit('activities', activities.sort((a, b) => String(a._id).localeCompare(String(b._id))));
  }
  // Top up the queue if there were not enough unembedded tasks to leave pending jobs on. These are
  // project jobs, which the worker processes the same way.
  const extraJobs: Record<string, unknown>[] = [];
  for (const project of allProjects) {
    if (pendingEmbedding <= 0) break;
    const sec = at(0.99);
    extraJobs.push({ _id: objectId(CODE.embeddingJobs, next('embeddingJobs'), sec), entityType: 'project', entityId: project.id, status: 'pending', attempts: 0, dirty: false, createdAt: dateAt(sec), updatedAt: dateAt(sec) });
    pendingEmbedding--;
  }
  await emit('embeddingJobs', extraJobs);

  // --- notifications ----------------------------------------------------------------------------
  for (const user of users) {
    const docs: Record<string, unknown>[] = [];
    const n = Math.round(scale.notificationsPerUser * (0.5 + random()));
    for (let k = 0; k < n; k++) {
      const sec = at(random());
      const taskOwner = users[Math.floor(random() * users.length)]!;
      docs.push({
        _id: objectId(CODE.notifications, next('notifications'), sec), userId: user.id,
        type: weighted(random, { task_comment: 60, task_comment_reply: 20, project_invite: 10, project_share_accepted: 10 }),
        payload: { taskId: taskOwner.taskIds.length ? pick(random, taskOwner.taskIds) : undefined, actorUserId: taskOwner.id, actorName: `Bench User ${taskOwner.i}`, preview: sentence(random, 3, 10) },
        // Older notifications have been read; the last few days are mostly unread.
        read: sec < EPOCH + SPAN * 0.95 ? random() < 0.95 : random() < 0.3,
        createdAt: dateAt(sec),
      });
    }
    await emit('notifications', docs.sort((a, b) => String(a._id).localeCompare(String(b._id))));
  }

  // --- conversations, MCP keys and sessions, invites, feedback ------------------------------------
  const conversations: Record<string, unknown>[] = [];
  const keys: Record<string, unknown>[] = [];
  const sessions: Record<string, unknown>[] = [];
  const invites: Record<string, unknown>[] = [];
  const feedback: Record<string, unknown>[] = [];
  const visionJobs: Record<string, unknown>[] = [];
  let pendingVision = scale.pendingVisionJobs;
  for (const user of users) {
    for (let c = 0; c < scale.conversationsPerUser; c++) {
      const sec = at(random());
      const messages = [];
      for (let m = 0; m < intBetween(random, 2, 16); m++) {
        messages.push({ role: m % 2 === 0 ? 'user' : 'assistant', content: sentence(random, 4, 60) });
      }
      conversations.push({ _id: objectId(CODE.conversations, next('conversations'), sec), userId: user.id, projectId: user.ownProjectIds[0], title: sentence(random, 2, 5), messages, pendingProposals: [], pausedBatch: null, createdAt: dateAt(sec), updatedAt: dateAt(sec + 600) });
    }
    if (user.i % 3 === 0) {
      const sec = at(random() * 0.8);
      const keyId = objectId(CODE.mcpApiKeys, next('mcpApiKeys'), sec);
      user.apiKeyHash = apiKeyHash(user.i);
      keys.push({ _id: keyId, userId: user.id, name: 'Claude Desktop', prefix: `qtk_${user.i}`, keyHash: user.apiKeyHash, scope: 'read_write', lastUsedAt: dateAt(at(0.99)), createdAt: dateAt(sec), updatedAt: dateAt(sec) });
      for (let s = 0; s < 2; s++) {
        const sid = mcpSessionId(user.i, s);
        user.mcpSessionIds.push(sid);
        sessions.push({ _id: sid, userId: user.id, keyId, activeProjectId: user.ownProjectIds[0], pendingProposals: [], createdAt: dateAt(at(0.98)), updatedAt: dateAt(at(0.99)) });
      }
    }
    if (random() < 0.2 && users.length > 1) {
      const sec = at(random());
      const invitee = users[(user.i + 1) % users.length]!;
      invites.push({ _id: objectId(CODE.invites, next('invites'), sec), projectId: user.ownProjectIds[0], inviterUserId: user.id, inviteeEmail: invitee.email, inviteeUserId: invitee.id, role: 'editor', status: weighted(random, { pending: 30, accepted: 50, declined: 10, expired: 10 }), token: createHash('sha256').update(`invite${user.i}`).digest('hex'), expiresAt: dateAt(sec + 7 * 86_400), createdAt: dateAt(sec), updatedAt: dateAt(sec) });
    }
    if (random() < 0.3) {
      const sec = at(random());
      const id = objectId(CODE.feedback, next('feedback'), sec);
      const withImage = pendingVision > 0;
      feedback.push({ _id: id, userId: user.id, message: sentence(random, 5, 40), category: weighted(random, { bug: 50, feature: 30, other: 20 }), status: 'open', validationStatus: withImage ? 'pending' : 'validated', context: { url: '/tasks', userAgent: 'bench', appVersion: '0.1.61' }, attachments: withImage ? [{ storageKey: `feedback/${id}/1.png`, contentType: 'image/png', sizeBytes: 123_456 }] : [], createdAt: dateAt(sec), updatedAt: dateAt(sec) });
      if (withImage) {
        visionJobs.push({ _id: objectId(CODE.feedbackVisionJobs, next('feedbackVisionJobs'), sec), feedbackId: id, status: 'pending', attempts: 0, createdAt: dateAt(sec), updatedAt: dateAt(sec) });
        pendingVision--;
      }
    }
  }
  // The vision queue is small in practice; pad it with jobs for synthetic feedback ids so the claim
  // test has enough to claim.
  while (pendingVision > 0) {
    const sec = at(0.99);
    const fid = objectId(CODE.feedback, next('feedback'), sec, 0xb4);
    visionJobs.push({ _id: objectId(CODE.feedbackVisionJobs, next('feedbackVisionJobs'), sec), feedbackId: fid, status: 'pending', attempts: 0, createdAt: dateAt(sec), updatedAt: dateAt(sec) });
    pendingVision--;
  }
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a._id).localeCompare(String(b._id));
  for (const [name, docs] of [['conversations', conversations], ['mcpApiKeys', keys], ['mcpSessions', sessions], ['invites', invites], ['feedback', feedback], ['feedbackVisionJobs', visionJobs]] as const) {
    docs.sort(byId);
    for (let b = 0; b < docs.length; b += 500) await emit(name, docs.slice(b, b + 500));
  }

  return { scale, seed, users, counts };
}
