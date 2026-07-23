import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { getUserPreferences, type AuthUser, type UserPreferences } from '../auth/storage';

interface UserMenuProps {
  user: AuthUser;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onChangePassword: () => void;
  onOpenHelp: () => void;
  onOpenAbout: () => void;
  onUpdateDisplayName: (displayName: string | null) => Promise<void>;
  onUpdatePreferences: (preferences: Partial<UserPreferences>) => Promise<void>;
  onSignOut: () => void;
  onClose: () => void;
}

export function UserMenu({
  user,
  anchorRef,
  onChangePassword,
  onOpenHelp,
  onOpenAbout,
  onUpdateDisplayName,
  onUpdatePreferences,
  onSignOut,
  onClose,
}: UserMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; visibility: 'hidden' | 'visible' }>({
    top: 0,
    left: 0,
    visibility: 'hidden',
  });
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preferences = getUserPreferences(user);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;

    let left = anchorRect.right - menuRect.width;
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
  }, [anchorRef, editingName]);

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

  async function handleSaveDisplayName() {
    setSaving(true);
    setError(null);
    try {
      const trimmed = displayName.trim();
      await onUpdateDisplayName(trimmed || null);
      setEditingName(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update display name');
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePreference(key: keyof UserPreferences, value: boolean) {
    setPrefSaving(true);
    setError(null);
    try {
      await onUpdatePreferences({ [key]: value });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update preferences');
    } finally {
      setPrefSaving(false);
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="user-menu"
      role="menu"
      style={{ top: menuStyle.top, left: menuStyle.left, visibility: menuStyle.visibility }}
    >
      <div className="user-menu-header">
        <div className="user-menu-email">{user.email}</div>
        {user.displayName && !editingName && (
          <div className="user-menu-display-name">{user.displayName}</div>
        )}
      </div>

      {editingName ? (
        <div className="user-menu-edit">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name"
            autoFocus
          />
          <div className="user-menu-edit-actions">
            <button type="button" className="user-menu-item" disabled={saving} onClick={() => void handleSaveDisplayName()}>
              Save
            </button>
            <button
              type="button"
              className="user-menu-item"
              disabled={saving}
              onClick={() => {
                setEditingName(false);
                setDisplayName(user.displayName ?? '');
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="user-menu-item"
          role="menuitem"
          onClick={() => setEditingName(true)}
        >
          Edit display name
        </button>
      )}

      {error && <p className="user-menu-error">{error}</p>}

      <div className="user-menu-section-label">Preferences</div>
      <label className="user-menu-toggle">
        <input
          type="checkbox"
          checked={preferences.autoApproveProposals}
          disabled={prefSaving || saving}
          onChange={(event) =>
            void handleTogglePreference('autoApproveProposals', event.target.checked)
          }
        />
        <span>Auto-approve agent actions</span>
      </label>
      <label className="user-menu-toggle">
        <input
          type="checkbox"
          checked={preferences.skipConfirmations}
          disabled={prefSaving || saving}
          onChange={(event) =>
            void handleTogglePreference('skipConfirmations', event.target.checked)
          }
        />
        <span>Skip delete confirmations</span>
      </label>
      <label className="user-menu-toggle">
        <input
          type="checkbox"
          checked={preferences.trackExpenses}
          disabled={prefSaving || saving}
          onChange={(event) =>
            void handleTogglePreference('trackExpenses', event.target.checked)
          }
        />
        <span>Track expenses</span>
      </label>

      <div className="user-menu-divider" role="separator" />

      <button
        type="button"
        className="user-menu-item"
        role="menuitem"
        onClick={() => {
          onOpenAbout();
          onClose();
        }}
      >
        About
      </button>

      <button
        type="button"
        className="user-menu-item"
        role="menuitem"
        onClick={() => {
          onOpenHelp();
          onClose();
        }}
      >
        Help
      </button>

      <button
        type="button"
        className="user-menu-item"
        role="menuitem"
        onClick={() => {
          onChangePassword();
          onClose();
        }}
      >
        Change password
      </button>

      <a className="user-menu-item" role="menuitem" href="/privacy" onClick={onClose}>
        Privacy Policy
      </a>

      <a className="user-menu-item" role="menuitem" href="/terms" onClick={onClose}>
        Terms &amp; Disclaimer
      </a>

      <div className="user-menu-divider" role="separator" />

      <button
        type="button"
        className="user-menu-item user-menu-item-danger"
        role="menuitem"
        onClick={() => {
          onSignOut();
          onClose();
        }}
      >
        Sign out
      </button>
    </div>,
    document.body
  );
}
