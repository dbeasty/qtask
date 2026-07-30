import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaskActivity } from '../api/client';
import type { ActivityEntry } from '../types';
import {
  formatActivityAction,
  formatActivityActor,
  formatActivityDetails,
  formatActivitySourceLabel,
  formatActivityTimestamp,
} from '../utils/formatActivity';

interface TaskActivitySectionProps {
  taskId: string;
  currentUserId: string;
  refreshKey?: number;
}

export function TaskActivitySection({
  taskId,
  currentUserId,
  refreshKey = 0,
}: TaskActivitySectionProps) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const hasFetchedRef = useRef(false);

  const loadActivity = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { activity: nextActivity } = await getTaskActivity(taskId);
      if (requestId !== requestIdRef.current) return;
      setActivity(nextActivity);
      hasFetchedRef.current = true;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    requestIdRef.current += 1;
    setActivity([]);
    setError(null);
    hasFetchedRef.current = false;
  }, [taskId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    void loadActivity();
  }, [open, taskId, refreshKey, loadActivity]);

  function handleToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    setOpen(event.currentTarget.open);
  }

  return (
    <details
      className="task-form-tracking-section"
      open={open}
      onToggle={handleToggle}
    >
      <summary className="task-form-tracking-summary">
        <span className={`project-toolbar-chevron${open ? ' expanded' : ''}`} aria-hidden="true">
          ›
        </span>
        Activity
      </summary>
      <div className="task-form-tracking-body">
        {loading && (
          <p className="muted" aria-live="polite">
            Loading activity…
          </p>
        )}

        {!loading && error && <p className="error-banner">{error}</p>}

        {!loading && !error && activity.length === 0 && hasFetchedRef.current && (
          <p className="muted" aria-live="polite">
            No activity yet.
          </p>
        )}

        {!loading && !error && activity.length > 0 && (
          <ul className="activity-list">
            {activity.map((entry) => {
              const details = formatActivityDetails(entry);
              const actor = formatActivityActor(entry, currentUserId);
              const timestamp = formatActivityTimestamp(entry.createdAt);

              return (
                <li key={entry._id} className="activity-item">
                  <div className="activity-item-main">
                    <div className="activity-item-content">
                      <p className="activity-item-label">
                        {formatActivityAction(entry.action)}
                        {actor ? <span className="activity-item-actor"> · {actor}</span> : null}
                      </p>
                      {details ? <p className="activity-item-details">{details}</p> : null}
                    </div>
                    <div className="activity-item-meta">
                      <time
                        className="activity-item-time"
                        dateTime={entry.createdAt}
                        title={timestamp.absolute}
                      >
                        {timestamp.relative}
                      </time>
                      <span
                        className={`activity-source-badge activity-source-badge-${entry.source}`}
                      >
                        {formatActivitySourceLabel(entry.source)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
