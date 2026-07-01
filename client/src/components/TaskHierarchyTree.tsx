import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from 'react';
import { TaskMoveMenu } from './TaskMoveMenu';
import { TaskProgressIndicator } from './TaskProgressIndicator';
import type { Subtask, Task } from '../types';
import {
  ancestorKeys,
  buildSubtaskPath,
  canMoveUp,
  collectAttachTargets,
  collectProjectAttachTargets,
  countNestedSubtasks,
  getSiblingContext,
  nodeKey,
  type AttachTarget,
  type ProjectAttachTarget,
} from '../utils/taskTree';
import {
  getDropZone,
  isValidDropTarget,
  readDragData,
  resolveDropAction,
  setDragData,
  type DragPayload,
  type DropTarget,
  type DropZone,
} from '../utils/taskDragDrop';

export type TaskSelection = { kind: 'task'; taskId: string };
export type SubtaskSelection = { kind: 'subtask'; taskId: string; path: string[] };
export type Selection = TaskSelection | SubtaskSelection;

interface TaskHierarchyTreeProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
  onSelect: (selection: Selection) => void;
  onMoveSubtask: (
    taskId: string,
    fromPath: string[],
    toParentPath: string[],
    index?: number
  ) => void;
  onMoveUp: (taskId: string, path: string[]) => void;
  onPromoteSubtask: (taskId: string, path: string[]) => void;
  onMoveTask: (taskId: string, index: number) => void;
  onAttachTask: (
    sourceTaskId: string,
    targetTaskId: string,
    parentPath: string[],
    index?: number
  ) => void;
}

function isSelectionActive(selection: Selection | null, taskId: string, path: string[]): boolean {
  if (!selection || selection.taskId !== taskId) return false;
  if (path.length === 0) return selection.kind === 'task';
  return (
    selection.kind === 'subtask' &&
    selection.path.length === path.length &&
    selection.path.every((id, index) => id === path[index])
  );
}

function stopDragPropagation(event: DragEvent) {
  event.stopPropagation();
}

interface UseTreeDragDropOptions {
  saving: boolean;
  onMoveTask: (taskId: string, index: number) => void;
  onMoveSubtask: TaskHierarchyTreeProps['onMoveSubtask'];
  onAttachTask: TaskHierarchyTreeProps['onAttachTask'];
}

function useTreeDragDrop({ saving, onMoveTask, onMoveSubtask, onAttachTask }: UseTreeDragDropOptions) {
  const [dropHint, setDropHint] = useState<{ key: string; zone: DropZone } | null>(null);
  const draggingRef = useRef<DragPayload | null>(null);

  const handleDragStart = useCallback(
    (payload: DragPayload) => (event: DragEvent) => {
      if (saving) {
        event.preventDefault();
        return;
      }
      draggingRef.current = payload;
      setDragData(event.dataTransfer, payload);
    },
    [saving]
  );

  const handleDragEnd = useCallback(() => {
    draggingRef.current = null;
    setDropHint(null);
  }, []);

  const handleDragOver = useCallback(
    (target: DropTarget, rowKey: string, allowInside: boolean) => (event: DragEvent) => {
      const dragging = draggingRef.current;
      if (saving || !dragging) return;
      event.preventDefault();
      const zone = getDropZone(event.clientY, event.currentTarget.getBoundingClientRect(), allowInside);
      const hintTarget = { ...target, zone };
      if (isValidDropTarget(dragging, hintTarget)) {
        event.dataTransfer.dropEffect = 'move';
        setDropHint({ key: rowKey, zone });
      } else {
        event.dataTransfer.dropEffect = 'none';
        setDropHint(null);
      }
    },
    [saving]
  );

  const handleDragLeave = useCallback((rowKey: string) => () => {
    setDropHint((current) => (current?.key === rowKey ? null : current));
  }, []);

  const handleDrop = useCallback(
    (target: DropTarget, _rowKey: string, allowInside: boolean) => (event: DragEvent) => {
      event.preventDefault();
      setDropHint(null);

      if (saving) return;

      const drag = readDragData(event.dataTransfer) ?? draggingRef.current;
      draggingRef.current = null;
      if (!drag) return;

      const zone = getDropZone(event.clientY, event.currentTarget.getBoundingClientRect(), allowInside);
      const action = resolveDropAction(drag, { ...target, zone });
      if (!action) return;

      if (action.kind === 'move-task') {
        onMoveTask(action.taskId, action.index);
        return;
      }

      if (action.kind === 'attach-task') {
        onAttachTask(
          action.sourceTaskId,
          action.targetTaskId,
          action.parentPath,
          action.index
        );
        return;
      }

      onMoveSubtask(action.taskId, action.fromPath, action.toParentPath, action.index);
    },
    [onAttachTask, onMoveSubtask, onMoveTask, saving]
  );

  const rowDropClass = useCallback(
    (rowKey: string) => {
      if (!dropHint || dropHint.key !== rowKey) return '';
      return ` drop-${dropHint.zone}`;
    },
    [dropHint]
  );

  return {
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    rowDropClass,
  };
}

interface SubtaskTreeNodeProps {
  task: Task;
  subtask: Subtask;
  path: string[];
  depth: number;
  expanded: Set<string>;
  selection: Selection | null;
  saving: boolean;
  openMoveMenuKey: string | null;
  moveTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleMoveMenu: (key: string | null) => void;
  onToggleExpand: (key: string) => void;
  onSelect: (selection: Selection) => void;
  onMoveSubtask: TaskHierarchyTreeProps['onMoveSubtask'];
  onMoveUp: TaskHierarchyTreeProps['onMoveUp'];
  onPromoteSubtask: TaskHierarchyTreeProps['onPromoteSubtask'];
  onAttach: (fromPath: string[], target: AttachTarget) => void;
  dragHandlers: ReturnType<typeof useTreeDragDrop>;
}

function SubtaskTreeNode({
  task,
  subtask,
  path,
  depth,
  expanded,
  selection,
  saving,
  openMoveMenuKey,
  moveTriggerRef,
  onToggleMoveMenu,
  onToggleExpand,
  onSelect,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onAttach,
  dragHandlers,
}: SubtaskTreeNodeProps) {
  const key = nodeKey(task._id, path);
  const rowKey = `row:${key}`;
  const hasChildren = subtask.subtasks.length > 0;
  const isExpanded = expanded.has(key);
  const isActive = isSelectionActive(selection, task._id, path);
  const siblingContext = getSiblingContext(task, path);
  const currentParentPath = path.slice(0, -1);
  const attachTargets = collectAttachTargets(task, path).filter(
    (target) =>
      target.parentPath.length !== currentParentPath.length ||
      !target.parentPath.every((id, index) => id === currentParentPath[index])
  );
  const menuOpen = openMoveMenuKey === rowKey;

  const dropTarget: DropTarget = {
    taskId: task._id,
    path,
    zone: 'before',
    siblingIndex: siblingContext?.index ?? 0,
    parentPath: currentParentPath,
    childCount: subtask.subtasks.length,
  };

  const dragPayload: DragPayload = { kind: 'subtask', taskId: task._id, path };

  return (
    <li className="task-tree-item">
      <div
        className={`task-tree-node${dragHandlers.rowDropClass(rowKey)}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onDragOver={dragHandlers.handleDragOver(dropTarget, rowKey, true)}
        onDragLeave={dragHandlers.handleDragLeave(rowKey)}
        onDrop={dragHandlers.handleDrop(dropTarget, rowKey, true)}
      >
        <div
          className="task-tree-row-body"
          draggable={!saving}
          title="Drag to reorder"
          onDragStart={dragHandlers.handleDragStart(dragPayload)}
          onDragEnd={dragHandlers.handleDragEnd}
        >
          {hasChildren ? (
            <button
              type="button"
              className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              draggable={false}
              onDragStart={stopDragPropagation}
              onClick={() => onToggleExpand(key)}
            >
              ›
            </button>
          ) : (
            <span className="task-tree-chevron-spacer" />
          )}
          <button
            type="button"
            className={`task-tree-label subtask-list-item${isActive ? ' active' : ''}`}
            draggable={false}
            onDragStart={stopDragPropagation}
            onClick={() => onSelect({ kind: 'subtask', taskId: task._id, path })}
          >
            <span className="task-tree-label-header">
              <TaskProgressIndicator status={subtask.status} percentComplete={subtask.percentComplete} />
              <span className="subtask-list-title">{subtask.title}</span>
            </span>
          </button>
        </div>
        {isActive && selection?.kind === 'subtask' && (
          <div className="task-tree-move-wrap">
            <button
              type="button"
              className="task-tree-move-trigger"
              ref={menuOpen ? moveTriggerRef : undefined}
              aria-label="Move task"
              aria-expanded={menuOpen}
              draggable={false}
              onDragStart={stopDragPropagation}
              onClick={() => onToggleMoveMenu(menuOpen ? null : rowKey)}
            >
              ⋮
            </button>
            {menuOpen && (
              <TaskMoveMenu
                anchorRef={moveTriggerRef}
                kind="subtask"
                saving={saving}
                canMoveUp={canMoveUp(task, path)}
                canMoveDown={
                  !!siblingContext && siblingContext.index < siblingContext.siblings.length - 1
                }
                canOutdent={path.length >= 2}
                attachTargets={attachTargets}
                onMoveUp={() => onMoveUp(task._id, path)}
                onMoveDown={() =>
                  siblingContext &&
                  onMoveSubtask(task._id, path, siblingContext.parentPath, siblingContext.index + 1)
                }
                onPromote={() => onPromoteSubtask(task._id, path)}
                onOutdent={() => onMoveSubtask(task._id, path, path.slice(0, -2))}
                onAttach={(target) => onAttach(path, target)}
                onClose={() => onToggleMoveMenu(null)}
              />
            )}
          </div>
        )}
      </div>
      {hasChildren && isExpanded && (
        <ul className="task-tree-children">
          {subtask.subtasks.map((child) => (
            <SubtaskTreeNode
              key={child._id}
              task={task}
              subtask={child}
              path={buildSubtaskPath(path, child._id)}
              depth={depth + 1}
              expanded={expanded}
              selection={selection}
              saving={saving}
              openMoveMenuKey={openMoveMenuKey}
              moveTriggerRef={moveTriggerRef}
              onToggleMoveMenu={onToggleMoveMenu}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onMoveSubtask={onMoveSubtask}
              onMoveUp={onMoveUp}
              onPromoteSubtask={onPromoteSubtask}
              onAttach={onAttach}
              dragHandlers={dragHandlers}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TaskHierarchyTree({
  tasks,
  selection,
  saving,
  onSelect,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onMoveTask,
  onAttachTask,
}: TaskHierarchyTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openMoveMenuKey, setOpenMoveMenuKey] = useState<string | null>(null);
  const moveTriggerRef = useRef<HTMLButtonElement | null>(null);

  const dragHandlers = useTreeDragDrop({ saving, onMoveTask, onMoveSubtask, onAttachTask });

  useEffect(() => {
    if (!selection) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (selection.kind === 'task') {
        for (const ancestorKey of ancestorKeys(selection.taskId, [])) {
          next.add(ancestorKey);
        }
      } else {
        for (const ancestorKey of ancestorKeys(selection.taskId, selection.path)) {
          next.add(ancestorKey);
        }
      }
      return next;
    });
  }, [selection]);

  useEffect(() => {
    setOpenMoveMenuKey(null);
  }, [selection]);

  const toggleExpand = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <ul className="task-tree">
      {tasks.map((task, taskIndex) => {
        const taskKey = nodeKey(task._id, []);
        const rowKey = `row:${taskKey}`;
        const hasChildren = task.subtasks.length > 0;
        const isExpanded = expanded.has(taskKey);
        const isActive = isSelectionActive(selection, task._id, []);
        const menuOpen = openMoveMenuKey === rowKey;
        const attachTargets = collectProjectAttachTargets(tasks, task._id);

        const dropTarget: DropTarget = {
          taskId: task._id,
          path: [],
          zone: 'before',
          siblingIndex: taskIndex,
          parentPath: [],
          childCount: task.subtasks.length,
        };

        const dragPayload: DragPayload = { kind: 'task', taskId: task._id, path: [] };

        return (
          <li key={task._id} className="task-tree-item task-tree-root">
            <div
              className={`task-tree-node${dragHandlers.rowDropClass(rowKey)}`}
              style={{ '--tree-depth': 0 } as CSSProperties}
              onDragOver={dragHandlers.handleDragOver(dropTarget, rowKey, true)}
              onDragLeave={dragHandlers.handleDragLeave(rowKey)}
              onDrop={dragHandlers.handleDrop(dropTarget, rowKey, true)}
            >
              <div
                className="task-tree-row-body"
                draggable={!saving}
                title="Drag to reorder"
                onDragStart={dragHandlers.handleDragStart(dragPayload)}
                onDragEnd={dragHandlers.handleDragEnd}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                    draggable={false}
                    onDragStart={stopDragPropagation}
                    onClick={() => toggleExpand(taskKey)}
                  >
                    ›
                  </button>
                ) : (
                  <span className="task-tree-chevron-spacer" />
                )}
                <button
                  type="button"
                  className={`task-tree-label task-list-item${isActive ? ' active' : ''}`}
                  draggable={false}
                  onDragStart={stopDragPropagation}
                  onClick={() => onSelect({ kind: 'task', taskId: task._id })}
                >
                  <span className="task-tree-label-header">
                    <TaskProgressIndicator status={task.status} percentComplete={task.percentComplete} />
                    <span className="task-list-title">{task.title}</span>
                  </span>
                  {hasChildren && (
                    <span className="task-list-meta">{countNestedSubtasks(task.subtasks)} subtasks</span>
                  )}
                </button>
              </div>
              {isActive && selection?.kind === 'task' && (
                <div className="task-tree-move-wrap">
                  <button
                    type="button"
                    className="task-tree-move-trigger"
                    ref={menuOpen ? moveTriggerRef : undefined}
                    aria-label="Move task"
                    aria-expanded={menuOpen}
                    draggable={false}
                    onDragStart={stopDragPropagation}
                    onClick={() => setOpenMoveMenuKey(menuOpen ? null : rowKey)}
                  >
                    ⋮
                  </button>
                  {menuOpen && (
                    <TaskMoveMenu
                      anchorRef={moveTriggerRef}
                      kind="task"
                      saving={saving}
                      canMoveUp={taskIndex > 0}
                      canMoveDown={taskIndex < tasks.length - 1}
                      canOutdent={false}
                      attachTargets={attachTargets}
                      onMoveUp={() => onMoveTask(task._id, taskIndex - 1)}
                      onMoveDown={() => onMoveTask(task._id, taskIndex + 1)}
                      onPromote={() => {}}
                      onOutdent={() => {}}
                      onAttach={(target) => {
                        const projectTarget = target as ProjectAttachTarget;
                        onAttachTask(task._id, projectTarget.targetTaskId, projectTarget.parentPath);
                      }}
                      onClose={() => setOpenMoveMenuKey(null)}
                    />
                  )}
                </div>
              )}
            </div>
            {hasChildren && isExpanded && (
              <ul className="task-tree-children">
                {task.subtasks.map((subtask) => (
                  <SubtaskTreeNode
                    key={subtask._id}
                    task={task}
                    subtask={subtask}
                    path={[subtask._id]}
                    depth={1}
                    expanded={expanded}
                    selection={selection}
                    saving={saving}
                    openMoveMenuKey={openMoveMenuKey}
                    moveTriggerRef={moveTriggerRef}
                    onToggleMoveMenu={setOpenMoveMenuKey}
                    onToggleExpand={toggleExpand}
                    onSelect={onSelect}
                    onMoveSubtask={onMoveSubtask}
                    onMoveUp={onMoveUp}
                    onPromoteSubtask={onPromoteSubtask}
                    onAttach={(fromPath, target) => onMoveSubtask(task._id, fromPath, target.parentPath)}
                    dragHandlers={dragHandlers}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
