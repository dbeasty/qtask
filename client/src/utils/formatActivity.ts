import type { ActivityEntry } from '../types';

const ACTION_LABELS: Record<string, string> = {
  'task.created': 'Task created',
  'task.updated': 'Task updated',
  'task.deleted': 'Task deleted',
  'task.deleted_keep_children': 'Task deleted (children kept)',
  'task.link_added': 'Link added',
  'task.link_removed': 'Link removed',
  'subtask.added': 'Subtask added',
  'subtask.updated': 'Subtask updated',
  'subtask.moved': 'Subtask moved',
  'subtask.promoted': 'Subtask promoted to task',
  'subtask.deleted': 'Subtask deleted',
  'subtask.deleted_keep_children': 'Subtask deleted (children kept)',
  'task.attached_as_subtask': 'Task attached as subtask',
  'task.reordered': 'Task reordered',
  'task.moved_project': 'Task moved to project',
  'task.shared_project': 'Task shared to project',
  'task.unlinked_project': 'Task unlinked from project',
  'task.duplicated': 'Task duplicated',
  'comment.added': 'Comment added',
  'comment.updated': 'Comment updated',
  'comment.deleted': 'Comment deleted',
};

function humanizeAction(action: string): string {
  return action
    .split('.')
    .map((part) => part.replace(/_/g, ' '))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatActivityAction(action: string): string {
  return ACTION_LABELS[action] ?? humanizeAction(action);
}

function formatPath(path: unknown): string | null {
  if (!Array.isArray(path) || path.length === 0) return null;
  return path.filter((part) => typeof part === 'string').join(' › ');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(', ');
  return JSON.stringify(value);
}

export function formatActivityDetails(entry: ActivityEntry): string | null {
  const { action, details } = entry;
  if (!details || Object.keys(details).length === 0) return null;

  const parts: string[] = [];

  if (action === 'task.updated' || action === 'subtask.updated') {
    const fields = Object.keys(details).filter((key) => key !== 'path');
    if (fields.length > 0) {
      parts.push(fields.join(', '));
    }
  }

  if (typeof details.title === 'string' && details.title) {
    parts.push(`"${details.title}"`);
  }

  const path = formatPath(details.path);
  if (path) {
    parts.push(path);
  }

  if (typeof details.fromPath !== 'undefined' || typeof details.toParentPath !== 'undefined') {
    const from = formatPath(details.fromPath);
    const to = formatPath(details.toParentPath);
    if (from && to) {
      parts.push(`${from} → ${to}`);
    } else if (from) {
      parts.push(`from ${from}`);
    } else if (to) {
      parts.push(`to ${to}`);
    }
  }

  if (typeof details.linkedTaskId === 'string' && details.linkedTaskId) {
    parts.push(`linked task ${details.linkedTaskId}`);
  }

  if (typeof details.type === 'string' && details.type) {
    parts.push(details.type);
  }

  if (typeof details.projectId === 'string' && details.projectId) {
    parts.push(`project ${details.projectId}`);
  }

  if (typeof details.sourceTaskId === 'string' && details.sourceTaskId) {
    parts.push(`from ${details.sourceTaskId}`);
  }

  if (typeof details.promotedTaskId === 'string' && details.promotedTaskId) {
    parts.push(`promoted to ${details.promotedTaskId}`);
  }

  if (typeof details.index === 'number') {
    parts.push(`position ${details.index + 1}`);
  }

  if (typeof details.bodyPreview === 'string' && details.bodyPreview) {
    parts.push(`"${details.bodyPreview}"`);
  }

  if (parts.length === 0) {
    const fallback = Object.entries(details)
      .map(([key, value]) => `${key}: ${formatValue(value)}`)
      .join('; ');
    return fallback || null;
  }

  return parts.join(' · ');
}

export function formatActivityActor(entry: ActivityEntry, currentUserId: string): string | null {
  if (entry.source === 'ai') return 'AI';
  if (entry.source === 'system') return 'System';
  if (entry.userId === currentUserId) return 'You';
  return null;
}

export function formatActivitySourceLabel(source: ActivityEntry['source']): string {
  switch (source) {
    case 'ai':
      return 'AI';
    case 'system':
      return 'System';
    default:
      return 'User';
  }
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatActivityTimestamp(createdAt: string): {
  relative: string;
  absolute: string;
} {
  const date = new Date(createdAt);
  const absolute = date.toLocaleString();
  const diffMs = date.getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < 60) {
    return { relative: relativeTimeFormatter.format(diffSeconds, 'second'), absolute };
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return { relative: relativeTimeFormatter.format(diffMinutes, 'minute'), absolute };
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return { relative: relativeTimeFormatter.format(diffHours, 'hour'), absolute };
  }

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) {
    return { relative: relativeTimeFormatter.format(diffDays, 'day'), absolute };
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return { relative: relativeTimeFormatter.format(diffMonths, 'month'), absolute };
  }

  const diffYears = Math.round(diffMonths / 12);
  return { relative: relativeTimeFormatter.format(diffYears, 'year'), absolute };
}
