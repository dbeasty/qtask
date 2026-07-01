import type { TaskStatus } from '../types';

type IndicatorState = 'done' | 'notStarted' | 'inProgress' | 'cancelled';

function indicatorState(status: TaskStatus, percent: number): IndicatorState {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'done' || percent >= 100) return 'done';
  if (percent === 0 && status !== 'in_progress') return 'notStarted';
  return 'inProgress';
}

function ariaLabel(state: IndicatorState, percent: number): string {
  switch (state) {
    case 'done':
      return 'Done';
    case 'notStarted':
      return 'Not started';
    case 'cancelled':
      return 'Cancelled';
    case 'inProgress':
      return `${percent}% complete`;
  }
}

interface TaskProgressIndicatorProps {
  status: TaskStatus;
  percentComplete: number;
}

const SIZE = 16;
const RADIUS = 6;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TaskProgressIndicator({ status, percentComplete }: TaskProgressIndicatorProps) {
  const percent = Math.max(0, Math.min(100, Math.round(percentComplete)));
  const state = indicatorState(status, percent);
  const label = ariaLabel(state, percent);

  if (state === 'done') {
    return (
      <span className="task-progress-indicator task-progress-indicator--done" aria-label={label} role="img">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="#22c55e" />
          <path
            d="M5.25 8.25 L7.25 10.25 L10.75 5.75"
            fill="none"
            stroke="#fff"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (state === 'cancelled') {
    return (
      <span className="task-progress-indicator task-progress-indicator--cancelled" aria-label={label} role="img">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="#64748b" strokeWidth="1.5" />
          <line x1="5" y1="11" x2="11" y2="5" stroke="#64748b" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (state === 'notStarted') {
    return (
      <span className="task-progress-indicator task-progress-indicator--not-started" aria-label={label} role="img">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="#64748b" strokeWidth="1.5" />
        </svg>
      </span>
    );
  }

  const dashOffset = CIRCUMFERENCE * (1 - percent / 100);

  return (
    <span className="task-progress-indicator task-progress-indicator--in-progress" aria-label={label} role="img">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="#334155" strokeWidth="1.5" />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
        />
      </svg>
    </span>
  );
}
