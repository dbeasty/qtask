import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AttachTarget } from '../utils/taskTree';

interface TaskMoveMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  kind: 'task' | 'subtask';
  saving: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canOutdent: boolean;
  attachTargets: AttachTarget[];
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPromote: () => void;
  onOutdent: () => void;
  onAttach: (target: AttachTarget) => void;
  onClose: () => void;
}

export function TaskMoveMenu({
  anchorRef,
  kind,
  saving,
  canMoveUp,
  canMoveDown,
  canOutdent,
  attachTargets,
  onMoveUp,
  onMoveDown,
  onPromote,
  onOutdent,
  onAttach,
  onClose,
}: TaskMoveMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [attachLabel, setAttachLabel] = useState('');
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
  }, [anchorRef, attachTargets.length, kind]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
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

  const handleAttach = () => {
    const target = attachTargets.find((item) => item.label === attachLabel);
    if (!target) return;
    onAttach(target);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="task-move-menu"
      role="menu"
      style={{ top: menuStyle.top, left: menuStyle.left, visibility: menuStyle.visibility }}
    >
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
          {attachTargets.length > 0 && (
            <div className="task-move-menu-attach">
              <label className="task-move-menu-attach-label">
                Attach under
                <select
                  className="task-move-menu-attach-select"
                  value={attachLabel}
                  onChange={(event) => setAttachLabel(event.target.value)}
                  disabled={saving}
                >
                  <option value="">Choose parent…</option>
                  {attachTargets.map((target) => (
                    <option key={target.label} value={target.label}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button task-move-menu-attach-apply"
                disabled={saving || !attachLabel}
                onClick={handleAttach}
              >
                Apply
              </button>
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
}
