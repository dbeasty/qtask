import { ActivityModel } from '../models/index.js';

export async function logActivity(params: {
  taskId: string;
  userId: string;
  action: string;
  details?: Record<string, unknown>;
  source?: 'user' | 'ai' | 'system';
}) {
  await ActivityModel.create({
    taskId: params.taskId,
    userId: params.userId,
    action: params.action,
    details: params.details ?? {},
    source: params.source ?? 'user',
  });
}

export async function getActivityForTask(taskId: string, limit = 50) {
  const entries = await ActivityModel.find({ taskId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return entries.map((entry) => ({
    ...entry,
    _id: String(entry._id),
    createdAt: entry.createdAt.toISOString(),
  }));
}
