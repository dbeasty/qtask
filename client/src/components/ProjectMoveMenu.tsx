import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface ProjectNestTarget {
  id: string;
  label: string;
}

interface ProjectMoveMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  saving: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canMoveToRoot: boolean;
  nestTargets: ProjectNestTarget[];
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToRoot: () => void;
  onNestUnder: (parentId: string) => void;
  onDelete: () => void | Promise<boolean>;
  onClose: () => void;
}

export function ProjectMoveMenu({
  anchorRef,
  saving,
  canMoveUp,
  canMoveDown,
  canMoveToRoot,
  nestTargets,
  onMoveUp,
  onMoveDown,
  onMoveToRoot,
  onNestUnder,
  onDelete,
  onClose,
}: ProjectMoveMenuProps) {
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
  }, [anchorRef, nestTargets.length, canMoveToRoot]);

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

  const handleNest = (parentId: string) => {
    onNestUnder(parentId);
    onClose();
  };

  const handleDelete = async () => {
    const deleted = await onDelete();
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
      {canMoveToRoot && (
        <button
          type="button"
          className="task-move-menu-item"
          role="menuitem"
          disabled={saving}
          onClick={() => run(onMoveToRoot)}
        >
          Move to root
        </button>
      )}
      <div className="task-move-menu-divider" role="separator" />
      <button
        type="button"
        className="task-move-menu-item task-move-menu-item-danger"
        role="menuitem"
        disabled={saving}
        onClick={() => void handleDelete()}
      >
        Delete
      </button>
      {nestTargets.length > 0 && (
        <div className="task-move-menu-attach">
          <div className="task-move-menu-attach-label">Nest under</div>
          <div className="task-move-menu-attach-list">
            {nestTargets.map((target) => (
              <button
                key={target.id}
                type="button"
                className="task-move-menu-item task-move-menu-attach-option"
                role="menuitem"
                disabled={saving}
                onClick={() => handleNest(target.id)}
              >
                {target.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
