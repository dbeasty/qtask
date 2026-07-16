import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  ActivityModel,
  AdminAuditModel,
  ConversationModel,
  EmbeddingJobModel,
  LlmCallMetricModel,
  LlmDailyMetricModel,
  ProjectModel,
  TaskModel,
  UserModel,
} from '../models/index.js';
import { requireAdmin, requireCsrf } from './auth.js';

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

async function groupedUsage(
  model: { aggregate: (pipeline: any[]) => any },
  userIds: string[]
): Promise<Map<string, { count: number; bytes: number }>> {
  if (userIds.length === 0) return new Map();
  const rows = (await model.aggregate([
    { $match: { userId: { $in: userIds } } },
    {
      $group: {
        _id: '$userId',
        count: { $sum: 1 },
        bytes: { $sum: { $bsonSize: '$$ROOT' } },
      },
    },
  ])) as Array<{ _id: string; count: number; bytes: number }>;
  return new Map(rows.map((row) => [String(row._id), { count: row.count, bytes: row.bytes }]));
}

async function modelBytes(model: { aggregate: (pipeline: any[]) => any }): Promise<number> {
  const result = (await model.aggregate([
    { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } },
  ])) as Array<{ bytes: number }>;
  return result[0]?.bytes ?? 0;
}

router.get('/stats', async (_req, res, next) => {
  try {
    const [users, tasks, projects, conversations, activities, bytes] = await Promise.all([
      UserModel.countDocuments(),
      TaskModel.countDocuments(),
      ProjectModel.countDocuments(),
      ConversationModel.countDocuments(),
      ActivityModel.countDocuments(),
      Promise.all([
        modelBytes(UserModel),
        modelBytes(TaskModel),
        modelBytes(ProjectModel),
        modelBytes(ConversationModel),
        modelBytes(ActivityModel),
        modelBytes(EmbeddingJobModel),
        modelBytes(LlmCallMetricModel),
        modelBytes(LlmDailyMetricModel),
        modelBytes(AdminAuditModel),
      ]),
    ]);
    res.json({
      users,
      tasks,
      projects,
      conversations,
      activities,
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
    const match = search
      ? { $or: [{ email: { $regex: search, $options: 'i' } }, { displayName: { $regex: search, $options: 'i' } }] }
      : {};
    const [total, users] = await Promise.all([
      UserModel.countDocuments(match),
      UserModel.find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const userIds = users.map((user) => String(user._id));
    const [tasks, projects, conversations, activities] = await Promise.all([
      groupedUsage(TaskModel, userIds),
      groupedUsage(ProjectModel, userIds),
      groupedUsage(ConversationModel, userIds),
      groupedUsage(ActivityModel, userIds),
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
    if (!isValidObjectId(req.params.id)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await UserModel.findById(req.params.id).lean();
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const id = String(user._id);
    const [tasks, projects, conversations, activities] = await Promise.all([
      groupedUsage(TaskModel, [id]),
      groupedUsage(ProjectModel, [id]),
      groupedUsage(ConversationModel, [id]),
      groupedUsage(ActivityModel, [id]),
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
    if (!isValidObjectId(req.params.id)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await UserModel.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    user.passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    user.mustChangePassword = true;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    await AdminAuditModel.create({
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
    if (!isValidObjectId(req.params.id)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = await UserModel.findById(req.params.id).lean();
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (config.admin.deleteConfirmEmail && req.body?.confirmEmail !== user.email) {
      res.status(400).json({ error: 'Email confirmation does not match' });
      return;
    }
    const userId = String(user._id);
    const ownedProjectIds = (await ProjectModel.find({ userId }).distinct('_id')).map(String);
    // Delete everything in owned projects, plus orphan tasks with no project.
    // Tasks created in someone else's shared project are kept.
    const orphanFilter = {
      userId,
      $or: [{ projectId: { $exists: false } }, { projectId: null }, { projectId: '' }],
    };
    const taskIdsToDelete = [
      ...(ownedProjectIds.length
        ? await TaskModel.find({ projectId: { $in: ownedProjectIds } }).distinct('_id')
        : []),
      ...(await TaskModel.find(orphanFilter).distinct('_id')),
    ].map(String);

    const [tasksInOwned, orphanTasks, projects, conversations, activities, embeddingJobs, metrics, dailyMetrics] =
      await Promise.all([
        ownedProjectIds.length
          ? TaskModel.deleteMany({ projectId: { $in: ownedProjectIds } })
          : Promise.resolve({ deletedCount: 0 }),
        TaskModel.deleteMany(orphanFilter),
        ProjectModel.deleteMany({ userId }),
        ConversationModel.deleteMany({ userId }),
        ActivityModel.deleteMany({ userId }),
        EmbeddingJobModel.deleteMany({ taskId: { $in: taskIdsToDelete } }),
        LlmCallMetricModel.deleteMany({ userId }),
        LlmDailyMetricModel.deleteMany({ userId }),
      ]);
    await ProjectModel.updateMany(
      { 'collaborators.userId': userId },
      { $pull: { collaborators: { userId } } }
    );
    await UserModel.deleteOne({ _id: user._id });
    const tasks = {
      deletedCount: (tasksInOwned.deletedCount ?? 0) + (orphanTasks.deletedCount ?? 0),
    };
    await AdminAuditModel.create({
      adminIdentity: req.admin!.identity,
      action: 'delete_user',
      targetUserId: userId,
      details: {
        tasks: tasks.deletedCount,
        projects: projects.deletedCount,
        conversations: conversations.deletedCount,
        activities: activities.deletedCount,
        embeddingJobs: embeddingJobs.deletedCount,
        metrics: metrics.deletedCount,
        dailyMetrics: dailyMetrics.deletedCount,
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

async function gpuStatus(): Promise<Record<string, unknown>> {
  if (!config.resourceMonitoring.dcgmMetricsUrl) {
    return { available: false, reason: 'GPU collector is not configured' };
  }
  try {
    const response = await fetch(config.resourceMonitoring.dcgmMetricsUrl, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const metric = (name: string) => {
      const values = [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)$`, 'gm'))]
        .map((match) => Number(match[1]))
        .filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
    };
    return {
      available: true,
      utilizationPercent: metric('DCGM_FI_DEV_GPU_UTIL'),
      memoryUsedMiB: metric('DCGM_FI_DEV_FB_USED'),
      memoryFreeMiB: metric('DCGM_FI_DEV_FB_FREE'),
      temperatureC: metric('DCGM_FI_DEV_GPU_TEMP'),
      powerWatts: metric('DCGM_FI_DEV_POWER_USAGE'),
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

router.get('/ollama/status', async (_req, res) => {
  const base = config.ollama.baseUrl.replace(/\/$/, '');
  const [version, tags, running, queue, resources, gpu] = await Promise.all([
    fetchJson(`${base}/api/version`).catch((error) => ({ error: String(error) })),
    fetchJson(`${base}/api/tags`).catch((error) => ({ error: String(error) })),
    fetchJson(`${base}/api/ps`).catch((error) => ({ error: String(error) })),
    EmbeddingJobModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: { $in: ['pending', 'processing', 'failed'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    resourceStatus(),
    gpuStatus(),
  ]);
  res.json({
    available: !(version as { error?: string }).error,
    configuredModels: {
      chat: config.ollama.model,
      embedding: config.ollama.embeddingModel,
    },
    version,
    tags,
    running,
    embeddingQueue: Object.fromEntries(queue.map((row) => [row._id, row.count])),
    resources,
    gpu,
  });
});

router.get('/ollama/summary', async (req, res, next) => {
  try {
    const range = dateRange(req.query as Record<string, unknown>);
    const rows = await LlmCallMetricModel.aggregate([
      { $match: { startedAt: range } },
      {
        $group: {
          _id: { callType: '$callType', model: '$model' },
          calls: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          failures: { $sum: { $cond: ['$success', 0, 1] } },
          degradedFallbacks: { $sum: { $cond: ['$degradedFallback', 1, 0] } },
          promptTokens: { $sum: { $ifNull: ['$promptEvalCount', 0] } },
          evalTokens: { $sum: { $ifNull: ['$evalCount', 0] } },
          averageDurationMs: { $avg: '$durationMs' },
          percentiles: {
            $percentile: { input: '$durationMs', p: [0.5, 0.95, 0.99], method: 'approximate' },
          },
        },
      },
      { $sort: { '_id.callType': 1, '_id.model': 1 } },
    ] as any[]);
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
    const points = await LlmCallMetricModel.aggregate([
      { $match: { startedAt: range } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$startedAt', unit } },
          calls: { $sum: 1 },
          failures: { $sum: { $cond: ['$success', 0, 1] } },
          durationMs: { $avg: '$durationMs' },
          promptTokens: { $sum: { $ifNull: ['$promptEvalCount', 0] } },
          evalTokens: { $sum: { $ifNull: ['$evalCount', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
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
    if (['chat', 'generate', 'embed'].includes(String(req.query.callType))) {
      filter.callType = req.query.callType;
    }
    if (typeof req.query.model === 'string' && req.query.model) filter.model = req.query.model;
    if (req.query.success === 'true') filter.success = true;
    if (req.query.success === 'false') filter.success = false;
    const [total, calls] = await Promise.all([
      LlmCallMetricModel.countDocuments(filter),
      LlmCallMetricModel.find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const userIds = [...new Set(calls.map((call) => call.userId).filter(Boolean))] as string[];
    const users = await UserModel.find({ _id: { $in: userIds } }, { email: 1 }).lean();
    const emails = new Map(users.map((user) => [String(user._id), user.email]));
    res.json({
      page,
      limit,
      total,
      calls: calls.map((call) => ({
        ...call,
        userEmail: call.userId ? emails.get(call.userId) : undefined,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export const adminRouter = router;
