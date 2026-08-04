import { updateSubtask, updateTask } from '../api/client';
import type { Task, TaskStatus, UpdateSubtaskInput, UpdateTaskInput } from '../types';

export function buildTaskDoneTogglePatch(
  done: boolean,
  canEdit: boolean
): UpdateTaskInput | UpdateSubtaskInput {
  const status: TaskStatus = done ? 'done' : 'todo';
  if (!done && canEdit) {
    return { status, percentComplete: 0, lastProgressField: 'percent' };
  }
  return { status };
}

export async function toggleTaskDone(
  taskId: string,
  path: string[],
  done: boolean,
  canEdit: boolean
): Promise<Task> {
  const patch = buildTaskDoneTogglePatch(done, canEdit);
  const { task } =
    path.length === 0
      ? await updateTask(taskId, patch)
      : await updateSubtask(taskId, path, patch);
  return task;
}
