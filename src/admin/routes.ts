import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { config } from '../config/index.js';
import { collection } from '../data/index.js';
import type { CollectionName } from '../data/types.js';
import type { AdminAuditDoc, ProjectDoc, TaskDoc, UserDoc } from '../data/documents.js';

function userDocs() {
  return collection<UserDoc>('users');
}

function taskDocs() {
  return collection<TaskDoc>('tasks');
}

function projectDocs() {
  return collection<ProjectDoc>('projects');
}

function conversationDocs() {
  return collection('conversations');
}

function activityDocs() {
  return collection('activities');
}

function feedbackDocs() {
  return collection('feedback');
}

function adminAudits() {
  return collection<AdminAuditDoc>('adminAudits');
}

function embeddingJobs() {
  return collection('embeddingJobs');
}

function callMetrics() {
  return collection('llmCallMetrics');
}

function dailyMetrics() {
  return collection('llmDailyMetrics');
}
import { escapeRegex } from '../services/searchUtils.js';
import { requireAdmin, requireCsrf } from './auth.js';
import { fetchGpuStatus } from './gpuStats.js';
import {
  getAdminFeedbackById,
  getFeedbackAttachment,
  listAdminFeedback,
  updateAdminFeedback,
  deleteFeedbackForUser,
  FeedbackValidationError,
} from '../services/feedbackService.js';

const BCRYPT_ROUNDS = 12;
const router = Router();

router.use(requireAdmin);

function positiveInt(value: unknown, fallback: number, max = 100): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function dateRange(query: Record<string, unknown>): { $gte: Date; $lte: Date } {
  const now = new Date();
  const fallback = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const from = typeof query.from === 'string' ? new Date(query.from) : fallback;
  const to = typeof query.to === 'string' ? new Date(query.to) : now;
  return {
    $gte: Number.isNaN(from.getTime()) ? fallback : from,
    $lte: Number.isNaN(to.getTime()) ? now : to,
  };
}

/**
 * Approximate stored size of one document.
 *
 * This replaces Mongo's `$bsonSize`, which has no equivalent on another backend and
 * no meaning on one that does not store BSON. JSON byte length is within a few
 * percent of BSON for this data and moves the same way, which is all these numbers
 * are used for — an operator judging whether one account is unusually large.
 */
function approximateBytes(doc: unknown): number {
  return Buffer.byteLength(JSON.stringify(doc) ?? '', 'utf8');
}

async function groupedUsage(
  name: CollectionName,
  userIds: string[]
): Promise<Map<string, { count: number; bytes: number }>> {
  if (userIds.length === 0) return new Map();
  const docs = await collection(name).find({ userId: { $in: userIds } });
  const out = new Map<string, { count: number; bytes: number }>();
  for (const doc of docs) {
    const key = String(doc.userId);
    const entry = out.get(key) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += approximateBytes(doc);
    out.set(key, entry);
  }
  return out;
}

async function collectionBytes(name: CollectionName): Promise<number> {
  const docs = await collection(name).find();
  return docs.reduce((sum, doc) => sum + approximateBytes(doc), 0);
}


/**
 * The admin analytics that used to be MongoDB aggregation pipelines.
 *
 * `$group`, `$percentile` and `$dateTrunc` have no equivalent in the data layer, and
 * adding a pipeline dialect that two backends must implement identically is a far
 * larger commitment than these three reports justify. They read a bounded, already
 * time-filtered slice and reduce it here instead.
 */
async function countByStatus(): Promise<Array<[string, number]>> {
  const jobs = await embeddingJobs().find({ status: { $in: ['pending', 'processing', 'failed'] } });
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const status = String(job.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts];
}

/** Exact percentile by nearest rank — Mongo's was approximate, so this is no worse. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

async function summarizeCalls(range: Record<string, unknown>) {
  const calls = await callMetrics().find({ startedAt: range });
  const groups = new Map<string, Record<string, unknown> & { durations: number[] }>();

  for (const call of calls) {
    const key = `${String(call.callType)}\u0000${String(call.model)}`;
    const group = groups.get(key) ?? {
      _id: { callType: call.callType, model: call.model },
      calls: 0,
      successes: 0,
      failures: 0,
      degradedFallbacks: 0,
      promptTokens: 0,
      evalTokens: 0,
      durations: [] as number[],
    };
    group.calls = (group.calls as number) + 1;
    if (call.success) group.successes = (group.successes as number) + 1;
    else group.failures = (group.failures as number) + 1;
    if (call.degradedFallback) group.degradedFallbacks = (group.degradedFallbacks as number) + 1;
    group.promptTokens = (group.promptTokens as number) + Number(call.promptEvalCount ?? 0);
    group.evalTokens = (group.evalTokens as number) + Number(call.evalCount ?? 0);
    group.durations.push(Number(call.durationMs ?? 0));
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((entry) => {
      const { durations, ...group } = entry;
      const sorted = [...durations].sort((a, b) => a - b);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      return {
        ...group,
        _id: group._id as { callType: string; model: string },
        averageDurationMs: sorted.length > 0 ? total / sorted.length : 0,
        percentiles: [percentile(sorted, 0.5), percentile(sorted, 0.95), percentile(sorted, 0.99)],
      };
    })
    .sort(
      (a, b) =>
        a._id.callType.localeCompare(b._id.callType) || a._id.model.localeCompare(b._id.model)
    );
}

/** Truncates an instant to the start of its minute, hour or day — `$dateTrunc`. */
function truncateTo(date: Date, unit: string): Date {
  const out = new Date(date.getTime());
  out.setUTCMilliseconds(0);
  out.setUTCSeconds(0);
  if (unit === 'minute') return out;
  out.setUTCMinutes(0);
  if (unit === 'hour') return out;
  out.setUTCHours(0);
  return out;
}

async function bucketCalls(range: Record<string, unknown>, unit: string) {
  const calls = await callMetrics().find({ startedAt: range });
  const buckets = new Map<number, { _id: Date; calls: number; failures: number; durations: number[]; promptTokens: number; evalTokens: number }>();

  for (const call of calls) {
    const startedAt = new Date(call.startedAt as string | Date);
    const bucketStart = truncateTo(startedAt, unit);
    const key = bucketStart.getTime();
    const bucket = buckets.get(key) ?? {
      _id: bucketStart,
      calls: 0,
      failures: 0,
      durations: [],
      promptTokens: 0,
      evalTokens: 0,
    };
    bucket.calls++;
    if (!call.success) bucket.failures++;
    bucket.durations.push(Number(call.durationMs ?? 0));
    bucket.promptTokens += Number(call.promptEvalCount ?? 0);
    bucket.evalTokens += Number(call.evalCount ?? 0);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .sort((a, b) => a._id.getTime() - b._id.getTime())
    .map(({ durations, ...bucket }) => ({
      ...bucket,
      durationMs:
        durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
    }));
}

router.get('/stats', async (_req, res, next) => {
  try {
    const [users, tasks, projects, conversations, activities, feedback, bytes] = await Promise.all([
      userDocs().countDocuments(),
      taskDocs().countDocuments(),
      projectDocs().countDocuments(),
      conversationDocs().countDocuments(),
      activityDocs().countDocuments(),
      feedbackDocs().countDocuments(),
      Promise.all([
        collectionBytes('users'),
        collectionBytes('tasks'),
        collectionBytes('projects'),
        collectionBytes('conversations'),
        collectionBytes('activities'),
        collectionBytes('embeddingJobs'),
        collectionBytes('llmCallMetrics'),
        collectionBytes('llmDailyMetrics'),
        collectionBytes('adminAudits'),
        collectionBytes('feedback'),
      ]),
    ]);
    res.json({
      users,
      tasks,
      projects,
      conversations,
      activities,
      feedback,
      totalDataBytes: bytes.reduce((sum, value) => sum + value, 0),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1, 1_000_000);
    const limit = positiveInt(req.query.limit, 25, 100);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const searchPattern = escapeRegex(search);
    const match = search
      ? { $or: [{ email: { $regex: searchPattern, $options: 'i' } }, { displayName: { $regex: searchPattern, $options: 'i' } }] }
      : {};
    const [total, users] = await Promise.all([
      userDocs().countDocuments(match),
      // _id breaks ties so skip/limit paging cannot drop or repeat rows when several
      // users share a createdAt millisecond.
      userDocs().find(match, {
        sort: { createdAt: -1, _id: 1 },
        skip: (page - 1) * limit,
        limit,
      }),
    ]);
    const userIds = users.map((user) => String(user._id));
    const [tasks, projects, conversations, activities] = await Promise.all([
      groupedUsage('tasks', userIds),
      groupedUsage('projects', userIds),
      groupedUsage('conversations', userIds),
      groupedUsage('activities', userIds),
    ]);
    res.json({
      page,
      limit,
      total,
      users: users.map((user) => {
        const id = String(user._id);
        const task = tasks.get(id) ?? { count: 0, bytes: 0 };
        const project = projects.get(id) ?? { count: 0, bytes: 0 };
        const conversation = conversations.get(id) ?? { count: 0, bytes: 0 };
        const activity = activities.get(id) ?? { count: 0, bytes: 0 };
        return {
          id,
          email: user.email,
          displayName: user.displayName,
          emailVerified: user.emailVerified !== false,
          active: user.emailVerified !== false && Boolean(user.lastLoginAt),
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          lastActiveAt: user.lastActiveAt,
          taskCount: task.count,
          projectCount: project.count,
          conversationCount: conversation.count,
          storageBytes: task.bytes + project.bytes + conversation.bytes + activity.bytes,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    if (!isValidObjectId(String(req.params.id))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await userDocs().findById(String(req.params.id));
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const id = String(user._id);
    const [tasks, projects, conversations, activities] = await Promise.all([
      groupedUsage('tasks', [id]),
      groupedUsage('projects', [id]),
      groupedUsage('conversations', [id]),
      groupedUsage('activities', [id]),
    ]);
    const task = tasks.get(id) ?? { count: 0, bytes: 0 };
    const project = projects.get(id) ?? { count: 0, bytes: 0 };
    const conversation = conversations.get(id) ?? { count: 0, bytes: 0 };
    const activity = activities.get(id) ?? { count: 0, bytes: 0 };
    res.json({
      user: {
        id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified !== false,
        active: user.emailVerified !== false && Boolean(user.lastLoginAt),
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        lastActiveAt: user.lastActiveAt,
        taskCount: task.count,
        projectCount: project.count,
        conversationCount: conversation.count,
        activityCount: activity.count,
        storageBytes: task.bytes + project.bytes + conversation.bytes + activity.bytes,
      },
    });
  } catch (error) {
    next(error);
  }
});

const resetSchema = z.object({ password: z.string().min(10).max(200) });

router.post('/users/:id/reset-password', requireCsrf, async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Temporary password must be 10-200 characters' });
      return;
    }
    if (!isValidObjectId(String(req.params.id))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await userDocs().findById(String(req.params.id));
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    user.passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    user.mustChangePassword = true;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    await userDocs().replaceOne({ _id: user._id }, user);
    await adminAudits().create({
      adminIdentity: req.admin!.identity,
      action: 'reset_password',
      targetUserId: String(user._id),
      targetEmail: user.email,
    });
    res.json({ message: 'Temporary password set; the user must change it at next login.' });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', requireCsrf, async (req, res, next) => {
  try {
    if (!isValidObjectId(String(req.params.id))) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await userDocs().findById(String(req.params.id));
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (config.admin.deleteConfirmEmail && req.body?.confirmEmail !== user.email) {
      res.status(400).json({ error: 'Email confirmation does not match' });
      return;
    }
    const userId = String(user._id);
    const ownedProjectIds = (await projectDocs().distinct('_id', { userId })).map(String);
    // Delete everything in owned projects, plus orphan tasks with no project.
    // Tasks created in someone else's shared project are kept (after unlinking owned projects).
    const orphanFilter = {
      userId,
      $and: [
        {
          $or: [
            { projectIds: { $exists: false } },
            { projectIds: { $size: 0 } },
            { projectIds: null },
          ],
        },
        {
          $or: [{ projectId: { $exists: false } }, { projectId: null }, { projectId: '' }],
        },
      ],
    };
    const ownedMembershipFilter = ownedProjectIds.length
      ? {
          $or: [
            { projectIds: { $in: ownedProjectIds } },
            { projectId: { $in: ownedProjectIds } },
          ],
        }
      : null;
    const taskIdsToDelete = [
      ...(ownedMembershipFilter ? await taskDocs().distinct('_id', ownedMembershipFilter) : []),
      ...(await taskDocs().distinct('_id', orphanFilter)),
    ].map(String);

    const [tasksInOwned, orphanTasks, projectsDeleted, conversationsDeleted, activitiesDeleted, embeddingJobsDeleted, metrics, dailyDeleted, feedbackDeleted] =
      await Promise.all([
        ownedMembershipFilter
          ? taskDocs().deleteMany(ownedMembershipFilter)
          : Promise.resolve({ deleted: 0 }),
        taskDocs().deleteMany(orphanFilter),
        projectDocs().deleteMany({ userId }),
        conversationDocs().deleteMany({ userId }),
        activityDocs().deleteMany({ userId }),
        embeddingJobs().deleteMany({ taskId: { $in: taskIdsToDelete } }),
        callMetrics().deleteMany({ userId }),
        dailyMetrics().deleteMany({ userId }),
        deleteFeedbackForUser(userId),
      ]);
    await projectDocs().updateMany(
      { 'collaborators.userId': userId },
      { $pull: { collaborators: { userId } } }
    );
    await userDocs().deleteOne({ _id: user._id });
    const tasks = {
      deleted: (tasksInOwned.deleted ?? 0) + (orphanTasks.deleted ?? 0),
    };
    await adminAudits().create({
      adminIdentity: req.admin!.identity,
      action: 'delete_user',
      targetUserId: userId,
      details: {
        tasks: tasks.deleted,
        projects: projectsDeleted.deleted,
        conversations: conversationsDeleted.deleted,
        activities: activitiesDeleted.deleted,
        embeddingJobs: embeddingJobsDeleted.deleted,
        metrics: metrics.deleted,
        dailyMetrics: dailyDeleted.deleted,
        feedback: feedbackDeleted,
      },
    });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function dockerUsage(stats: Record<string, any>): Record<string, unknown> {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCount = stats.cpu_stats?.online_cpus ?? 1;
  return {
    cpuPercent: systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0,
    memoryBytes: stats.memory_stats?.usage,
    memoryLimitBytes: stats.memory_stats?.limit,
    networkRxBytes: Object.values(stats.networks ?? {}).reduce(
      (sum: number, network: any) => sum + (network.rx_bytes ?? 0),
      0
    ),
    networkTxBytes: Object.values(stats.networks ?? {}).reduce(
      (sum: number, network: any) => sum + (network.tx_bytes ?? 0),
      0
    ),
  };
}

async function resourceStatus(): Promise<Record<string, unknown>> {
  if (!config.resourceMonitoring.dockerApiUrl) {
    return { available: false, reason: 'Docker collector is not configured' };
  }
  try {
    const separator = config.resourceMonitoring.dockerApiUrl.includes('?') ? '&' : '?';
    const raw = await fetchJson(
      `${config.resourceMonitoring.dockerApiUrl.replace(/\/$/, '')}/containers/${encodeURIComponent(
        config.resourceMonitoring.dockerContainer
      )}/stats${separator}stream=false`
    );
    return { available: true, ...dockerUsage(raw as Record<string, any>) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

router.get('/ollama/status', async (_req, res) => {
  const base = config.ollama.baseUrl.replace(/\/$/, '');
  const [version, tags, running, queue, resources] = await Promise.all([
    fetchJson(`${base}/api/version`).catch((error) => ({ error: String(error) })),
    fetchJson(`${base}/api/tags`).catch((error) => ({ error: String(error) })),
    fetchJson(`${base}/api/ps`).catch((error) => ({ error: String(error) })),
    countByStatus(),
    resourceStatus(),
  ]);
  res.json({
    available: !(version as { error?: string }).error,
    configuredModels: {
      agent: config.ollama.model,
      embedding: config.ollama.embeddingModel,
    },
    version,
    tags,
    running,
    embeddingQueue: Object.fromEntries(queue),
    resources,
  });
});

router.get('/ollama/gpu', async (_req, res) => {
  const gpu = await fetchGpuStatus({
    jetsonGpuStatsUrl: config.resourceMonitoring.jetsonGpuStatsUrl,
    dcgmMetricsUrl: config.resourceMonitoring.dcgmMetricsUrl,
    ollamaBaseUrl: config.ollama.baseUrl,
  });
  res.json(gpu);
});

router.get('/ollama/summary', async (req, res, next) => {
  try {
    const range = dateRange(req.query as Record<string, unknown>);
    const rows = await summarizeCalls(range);
    res.json({ from: range.$gte, to: range.$lte, groups: rows });
  } catch (error) {
    next(error);
  }
});

router.get('/ollama/timeseries', async (req, res, next) => {
  try {
    const range = dateRange(req.query as Record<string, unknown>);
    const unit = ['minute', 'hour', 'day'].includes(String(req.query.interval))
      ? String(req.query.interval)
      : 'hour';
    const points = await bucketCalls(range, unit);
    res.json({ from: range.$gte, to: range.$lte, interval: unit, points });
  } catch (error) {
    next(error);
  }
});

router.get('/ollama/calls', async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1, 1_000_000);
    const limit = positiveInt(req.query.limit, 25, 100);
    const filter: Record<string, unknown> = {};
    if (['agent', 'generate', 'embed', 'feedback_vision'].includes(String(req.query.callType))) {
      filter.callType = req.query.callType;
    }
    if (typeof req.query.model === 'string' && req.query.model) filter.model = req.query.model;
    if (req.query.success === 'true') filter.success = true;
    if (req.query.success === 'false') filter.success = false;
    const [total, calls] = await Promise.all([
      callMetrics().countDocuments(filter),
      // See the users listing: a unique tiebreaker keeps paging total. LLM metrics
      // are written in bursts, so startedAt ties are common.
      callMetrics().find(filter, {
        sort: { startedAt: -1, _id: 1 },
        skip: (page - 1) * limit,
        limit,
      }),
    ]);
    const userIds = [...new Set(calls.map((call) => call.userId).filter(Boolean))] as string[];
    const users = await userDocs().find({ _id: { $in: userIds } }, { select: 'email' });
    const emails = new Map(users.map((user) => [String(user._id), user.email]));
    res.json({
      page,
      limit,
      total,
      calls: calls.map((call) => ({
        ...call,
        userEmail: call.userId ? emails.get(String(call.userId)) : undefined,
      })),
    });
  } catch (error) {
    next(error);
  }
});

const feedbackStatusSchema = z.enum(['open', 'read', 'resolved']);
const feedbackPatchSchema = z
  .object({
    status: feedbackStatusSchema.optional(),
    reply: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => body.status !== undefined || body.reply !== undefined, {
    message: 'Status or reply is required',
  });

router.get('/feedback', async (req, res, next) => {
  try {
    const page = positiveInt(req.query.page, 1, 1_000_000);
    const limit = positiveInt(req.query.limit, 25, 100);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const status = feedbackStatusSchema.safeParse(req.query.status).success
      ? (req.query.status as 'open' | 'read' | 'resolved')
      : undefined;
    const from =
      typeof req.query.from === 'string' && !Number.isNaN(new Date(req.query.from).getTime())
        ? new Date(req.query.from)
        : undefined;
    const to =
      typeof req.query.to === 'string' && !Number.isNaN(new Date(req.query.to).getTime())
        ? new Date(req.query.to)
        : undefined;
    const result = await listAdminFeedback({
      page,
      limit,
      status,
      search: search || undefined,
      from,
      to,
    });
    res.json({
      page: result.page,
      limit: result.limit,
      total: result.total,
      items: result.items.map((item) => ({
        id: String(item._id),
        userId: item.userId,
        userEmail: item.userEmail,
        userDisplayName: item.userDisplayName,
        message: item.message,
        category: item.category,
        status: item.status,
        validationStatus: item.validationStatus ?? 'validated',
        createdAt: item.createdAt,
        attachmentCount: item.attachments?.length ?? 0,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/feedback/:id', async (req, res, next) => {
  try {
    const feedbackId = String(req.params.id);
    if (!isValidObjectId(feedbackId)) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    const feedback = await getAdminFeedbackById(feedbackId);
    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    res.json({
      id: String(feedback._id),
      userId: feedback.userId,
      userEmail: feedback.userEmail,
      userDisplayName: feedback.userDisplayName,
      message: feedback.message,
      category: feedback.category,
      status: feedback.status,
      validationStatus: feedback.validationStatus ?? 'validated',
      context: feedback.context,
      attachments: (feedback.attachments ?? []).map((attachment, index) => ({
        index,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        visionCheck: attachment.visionCheck,
      })),
      adminReply: feedback.adminReply
        ? {
            message: feedback.adminReply.message,
            repliedAt: feedback.adminReply.repliedAt,
          }
        : null,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/feedback/:id', requireCsrf, async (req, res, next) => {
  try {
    const feedbackId = String(req.params.id);
    if (!isValidObjectId(feedbackId)) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    const body = feedbackPatchSchema.parse(req.body);
    const feedback = await updateAdminFeedback(feedbackId, body);
    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    res.json({
      id: String(feedback._id),
      status: feedback.status,
      adminReply: feedback.adminReply
        ? {
            message: feedback.adminReply.message,
            repliedAt: feedback.adminReply.repliedAt,
          }
        : null,
      updatedAt: feedback.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (error instanceof FeedbackValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get('/feedback/:id/attachments/:index', async (req, res, next) => {
  try {
    const feedbackId = String(req.params.id);
    if (!isValidObjectId(feedbackId)) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: 'Invalid attachment index' });
      return;
    }
    const result = await getFeedbackAttachment(feedbackId, index);
    if (!result) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    res.setHeader('Content-Type', result.object.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.object.body);
  } catch (error) {
    next(error);
  }
});

export const adminRouter = router;
