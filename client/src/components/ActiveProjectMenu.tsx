import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../types';

interface ActiveProjectMenuProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenProjectView: () => void;
  onClose: () => void;
}

export function ActiveProjectMenu({
  anchorRef,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenProjectView,
  onClose,
}: ActiveProjectMenuProps) {
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

    let left = anchorRect.left;
    let top = anchorRect.bottom + margin;

    if (left < margin) {
      left = margin;
    }
    if (left + menuRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - menuRect.width - margin);
    }
    if (top + menuRect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorRect.top - menuRect.height - margin);
    }

    setMenuStyle({ top, left, visibility: 'visible' });
  }, [anchorRef, projects.length]);

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

  return createPortal(
    <div
      ref={menuRef}
      className="user-menu active-project-menu"
      role="menu"
      aria-label="Active project"
      style={{ top: menuStyle.top, left: menuStyle.left, visibility: menuStyle.visibility }}
    >
      <button
        type="button"
        className="user-menu-item"
        role="menuitem"
        onClick={() => {
          onOpenProjectView();
          onClose();
        }}
      >
        Select new active project in project view
      </button>

      {projects.length > 0 ? (
        <>
          <div className="user-menu-divider" role="separator" />
          <div className="active-project-menu-list">
            {projects.map((project) => {
              const isActive = project._id === activeProjectId;
              return (
                <button
                  key={project._id}
                  type="button"
                  className={`user-menu-item${isActive ? ' active-project-menu-item-current' : ''}`}
                  role="menuitem"
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => {
                    onSelectProject(project._id);
                    onClose();
                  }}
                >
                  {project.name}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>,
    document.body
  );
}
