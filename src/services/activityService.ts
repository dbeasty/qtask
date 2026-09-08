import { collection } from '../data/index.js';

function activities() {
  return collection('activities');
}

export async function logActivity(params: {
  taskId: string;
  userId: string;
  action: string;
  details?: Record<string, unknown>;
  source?: 'user' | 'ai' | 'system';
}) {
  await activities().create({
    taskId: params.taskId,
    userId: params.userId,
    action: params.action,
    details: params.details ?? {},
    source: params.source ?? 'user',
  });
}

export async function getActivityForTask(taskId: string, limit = 50) {
  const entries = await activities().find({ taskId }, { sort: { createdAt: -1 }, limit });

  return entries.map((entry) => ({
    ...entry,
    _id: String(entry._id),
    createdAt: new Date(entry.createdAt as string | Date).toISOString(),
  }));
}
