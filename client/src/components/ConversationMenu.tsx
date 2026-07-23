import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface ConversationMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  onReset: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ConversationMenu({
  anchorRef,
  busy,
  onReset,
  onDuplicate,
  onDelete,
  onClose,
}: ConversationMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    visibility: 'hidden' | 'visible';
  }>({
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
  }, [anchorRef]);

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
        disabled={busy}
        onClick={() => run(onReset)}
      >
        Reset session
      </button>
      <button
        type="button"
        className="task-move-menu-item"
        role="menuitem"
        disabled={busy}
        onClick={() => run(onDuplicate)}
      >
        Duplicate
      </button>
      <div className="task-move-menu-divider" role="separator" />
      <button
        type="button"
        className="task-move-menu-item task-move-menu-item-danger"
        role="menuitem"
        disabled={busy}
        onClick={() => run(onDelete)}
      >
        Delete
      </button>
    </div>,
    document.body
  );
}
