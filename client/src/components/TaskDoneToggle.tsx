import type { DragEvent } from 'react';
import type { TaskStatus } from '../types';
import { TaskProgressIndicator } from './TaskProgressIndicator';

interface TaskDoneToggleProps {
  status: TaskStatus;
  percentComplete: number;
  saving?: boolean;
  canToggle?: boolean;
  onToggle?: (done: boolean) => void;
}

function stopDragPropagation(event: DragEvent) {
  event.stopPropagation();
}

export function TaskDoneToggle({
  status,
  percentComplete,
  saving = false,
  canToggle = false,
  onToggle,
}: TaskDoneToggleProps) {
  const indicator = <TaskProgressIndicator status={status} percentComplete={percentComplete} />;

  if (!canToggle || !onToggle) {
    return <span className="task-done-toggle task-done-toggle--static">{indicator}</span>;
  }

  const isDone = status === 'done';
  const label = isDone ? 'Mark as not done' : 'Mark as done';

  return (
    <button
      type="button"
      className={`task-done-toggle${isDone ? ' task-done-toggle--done' : ''}`}
      title={label}
      aria-label={label}
      disabled={saving}
      draggable={false}
      onDragStart={stopDragPropagation}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(!isDone);
      }}
    >
      {indicator}
    </button>
  );
}
