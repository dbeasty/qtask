export type DragNodeKind = 'task' | 'subtask';

export interface DragPayload {
  kind: DragNodeKind;
  taskId: string;
  path: string[];
}

export type DropZone = 'before' | 'after' | 'inside';

const DRAG_MIME = 'application/x-qtask-node';

export function encodeDragPayload(payload: DragPayload): string {
  return JSON.stringify(payload);
}

export function decodeDragPayload(data: string): DragPayload | null {
  try {
    const parsed = JSON.parse(data) as DragPayload;
    if (!parsed.taskId || !parsed.kind) return null;
    return { kind: parsed.kind, taskId: parsed.taskId, path: parsed.path ?? [] };
  } catch {
    return null;
  }
}

export function getDropZone(clientY: number, rect: DOMRect, allowInside: boolean): DropZone {
  const relativeY = clientY - rect.top;
  const third = rect.height / 3;

  if (allowInside && relativeY >= third && relativeY <= third * 2) {
    return 'inside';
  }
  if (relativeY < rect.height / 2) {
    return 'before';
  }
  return 'after';
}

export function setDragData(dataTransfer: DataTransfer, payload: DragPayload): void {
  const encoded = encodeDragPayload(payload);
  dataTransfer.setData(DRAG_MIME, encoded);
  dataTransfer.setData('text/plain', encoded);
  dataTransfer.effectAllowed = 'move';
}

export function readDragData(dataTransfer: DataTransfer): DragPayload | null {
  const raw = dataTransfer.getData(DRAG_MIME) || dataTransfer.getData('text/plain');
  if (!raw) return null;
  return decodeDragPayload(raw);
}

export function isSameNode(a: DragPayload, taskId: string, path: string[]): boolean {
  if (a.taskId !== taskId) return false;
  if (a.path.length !== path.length) return false;
  return a.path.every((id, index) => id === path[index]);
}

export function isDescendantPath(ancestorPath: string[], path: string[]): boolean {
  if (ancestorPath.length === 0) return false;
  if (path.length < ancestorPath.length) return false;
  return ancestorPath.every((id, index) => path[index] === id);
}

export interface DropTarget {
  taskId: string;
  path: string[];
  zone: DropZone;
  siblingIndex: number;
  parentPath: string[];
  childCount: number;
}

export type DropAction =
  | { kind: 'move-task'; taskId: string; index: number }
  | { kind: 'move-subtask'; taskId: string; fromPath: string[]; toParentPath: string[]; index: number }
  | { kind: 'attach-task'; sourceTaskId: string; targetTaskId: string; parentPath: string[]; index: number };

export function resolveDropAction(drag: DragPayload, target: DropTarget): DropAction | null {
  if (isSameNode(drag, target.taskId, target.path) && target.zone !== 'inside') {
    return null;
  }

  if (drag.kind === 'task') {
    if (drag.taskId === target.taskId && target.path.length === 0 && target.zone !== 'inside') {
      return null;
    }

    if (target.zone === 'inside' && drag.taskId !== target.taskId) {
      return {
        kind: 'attach-task',
        sourceTaskId: drag.taskId,
        targetTaskId: target.taskId,
        parentPath: target.path,
        index: target.childCount,
      };
    }

    if (target.path.length > 0) return null;
    if (target.zone === 'inside') return null;
    if (drag.taskId === target.taskId) return null;

    let index = target.siblingIndex;
    if (target.zone === 'after') index += 1;

    return { kind: 'move-task', taskId: drag.taskId, index };
  }

  if (drag.kind === 'subtask') {
    if (drag.taskId !== target.taskId) return null;
    if (isDescendantPath(drag.path, target.path) && target.zone === 'inside') return null;
    if (isSameNode(drag, target.taskId, target.path)) return null;

    if (target.path.length === 0 && target.zone !== 'inside') {
      return null;
    }

    if (target.zone === 'inside') {
      if (isDescendantPath(drag.path, target.path)) return null;
      return {
        kind: 'move-subtask',
        taskId: drag.taskId,
        fromPath: drag.path,
        toParentPath: target.path,
        index: target.childCount,
      };
    }

    let index = target.siblingIndex;
    if (target.zone === 'after') index += 1;

    return {
      kind: 'move-subtask',
      taskId: drag.taskId,
      fromPath: drag.path,
      toParentPath: target.parentPath,
      index,
    };
  }

  return null;
}

export function isValidDropTarget(drag: DragPayload, target: DropTarget): boolean {
  return resolveDropAction(drag, target) !== null;
}
