import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AttachTarget, ProjectAttachTarget } from '../utils/taskTree';

type MoveAttachTarget = AttachTarget | ProjectAttachTarget;

function attachTargetLabel(target: MoveAttachTarget): string {
  return target.label;
}

interface TaskMoveMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  kind: 'task' | 'subtask';
  saving: boolean;
  hasChildren: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canOutdent: boolean;
  attachTargets: MoveAttachTarget[];
  showMarkDone: boolean;
  isDone: boolean;
  onToggleDone: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPromote: () => void;
  onOutdent: () => void;
  onAttach: (target: MoveAttachTarget) => void;
  onDelete: (keepChildren?: boolean) => void | Promise<boolean>;
  onClose: () => void;
}

export function TaskMoveMenu({
  anchorRef,
  kind,
  saving,
  hasChildren,
  canMoveUp,
  canMoveDown,
  canOutdent,
  attachTargets,
  showMarkDone,
  isDone,
  onToggleDone,
  onMoveUp,
  onMoveDown,
  onPromote,
  onOutdent,
  onAttach,
  onDelete,
  onClose,
}: TaskMoveMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; visibility: 'hidden' | 'visible' }>({
    top: 0,
    left: 0,
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;

    let left = anchorRect.right + margin;
    let top = anchorRect.top;

    if (left + menuRect.width > window.innerWidth - margin) {
      left = anchorRect.left - menuRect.width - margin;
    }

    if (top + menuRect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - menuRect.height - margin);
    }

    setMenuStyle({ top, left, visibility: 'visible' });
  }, [anchorRef, attachTargets.length, kind, hasChildren]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [anchorRef, onClose]);

  useEffect(() => {
    const handleDismiss = () => onClose();
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [onClose]);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  const handleAttach = (target: MoveAttachTarget) => {
    onAttach(target);
    onClose();
  };

  const handleDelete = async (keepChildren = false) => {
    const deleted = await onDelete(keepChildren);
    if (deleted) {
      onClose();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="task-move-menu"
      role="menu"
      style={{ top: menuStyle.top, left: menuStyle.left, visibility: menuStyle.visibility }}
    >
      {showMarkDone && (
        <>
          <button
            type="button"
            className="task-move-menu-item"
            role="menuitem"
            disabled={saving}
            onClick={() => run(onToggleDone)}
          >
            {isDone ? 'Mark as not done' : 'Mark as done'}
          </button>
          <div className="task-move-menu-divider" role="separator" />
        </>
      )}
      <button
        type="button"
        className="task-move-menu-item"
        role="menuitem"
        disabled={saving || !canMoveUp}
        onClick={() => run(onMoveUp)}
      >
        Move up
      </button>
      <button
        type="button"
        className="task-move-menu-item"
        role="menuitem"
        disabled={saving || !canMoveDown}
        onClick={() => run(onMoveDown)}
      >
        Move down
      </button>
      <div className="task-move-menu-divider" role="separator" />
      <button
        type="button"
        className="task-move-menu-item task-move-menu-item-danger"
        role="menuitem"
        disabled={saving}
        onClick={() => void handleDelete(false)}
      >
        Delete
      </button>
      {hasChildren && (
        <button
          type="button"
          className="task-move-menu-item task-move-menu-item-danger"
          role="menuitem"
          disabled={saving}
          onClick={() => void handleDelete(true)}
        >
          Delete, keep subtasks
        </button>
      )}
      {kind === 'subtask' && (
        <>
          <button
            type="button"
            className="task-move-menu-item"
            role="menuitem"
            disabled={saving}
            onClick={() => run(onPromote)}
          >
            Move to project
          </button>
          <button
            type="button"
            className="task-move-menu-item"
            role="menuitem"
            disabled={saving || !canOutdent}
            onClick={() => run(onOutdent)}
            title="Attach to parent level"
          >
            Move up one level
          </button>
        </>
      )}
      {attachTargets.length > 0 && (
        <div className="task-move-menu-attach">
          <div className="task-move-menu-attach-label">Attach under</div>
          <div className="task-move-menu-attach-list">
            {attachTargets.map((target, index) => (
              <button
                key={index}
                type="button"
                className="task-move-menu-item task-move-menu-attach-option"
                role="menuitem"
                disabled={saving}
                onClick={() => handleAttach(target)}
              >
                {attachTargetLabel(target)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
