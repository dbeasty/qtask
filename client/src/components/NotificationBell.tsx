import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptInvite,
  declineInvite,
  getUnreadNotificationCount,
  listInvites,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/client';
import type { AppNotification, ProjectInvite } from '../types';

interface NotificationBellProps {
  onInvitesChanged?: () => void;
}

function notificationLabel(notification: AppNotification): string {
  const name = notification.payload.projectName ?? 'a project';
  switch (notification.type) {
    case 'project_invite':
      return `${notification.payload.inviterDisplayName || notification.payload.inviterEmail || 'Someone'} invited you to ${name}`;
    case 'project_share_accepted':
      return `${notification.payload.inviteeDisplayName || notification.payload.inviteeEmail || 'Someone'} joined ${name}`;
    case 'project_share_declined':
      return `${notification.payload.inviteeDisplayName || notification.payload.inviteeEmail || 'Someone'} declined ${name}`;
    default:
      return name;
  }
}

export function NotificationBell({ onInvitesChanged }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [{ count }, { notifications: nextNotifications }, { invites: pendingInvites }] =
      await Promise.all([
        getUnreadNotificationCount(),
        listNotifications(),
        listInvites('pending'),
      ]);
    setUnreadCount(count);
    setNotifications(nextNotifications);
    setInvites(pendingInvites);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      // optional shell chrome
    });
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  async function handleOpen() {
    setOpen((value) => !value);
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    }
  }

  async function handleAccept(inviteId: string) {
    setBusyId(inviteId);
    setError(null);
    try {
      await acceptInvite(inviteId);
      await refresh();
      onInvitesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDecline(inviteId: string) {
    setBusyId(inviteId);
    setError(null);
    try {
      await declineInvite(inviteId);
      await refresh();
      onInvitesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decline invite');
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkRead(notificationId: string) {
    try {
      await markNotificationRead(notificationId);
      await refresh();
    } catch {
      // ignore
    }
  }

  async function handleMarkAllRead() {
    try {
      await markAllNotificationsRead();
      await refresh();
    } catch {
      // ignore
    }
  }

  const badgeCount = unreadCount + invites.length;

  return (
    <div className="notification-bell" ref={panelRef} data-demo-step="notification-bell">
      <button
        type="button"
        className="notification-bell-button"
        aria-expanded={open}
        aria-label={`Notifications${badgeCount > 0 ? ` (${badgeCount} unread)` : ''}`}
        onClick={() => void handleOpen()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {badgeCount > 0 ? <span className="notification-bell-badge">{badgeCount}</span> : null}
      </button>

      {open && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-header">
            <strong>Notifications</strong>
            {notifications.some((n) => !n.read) ? (
              <button type="button" className="link-button" onClick={() => void handleMarkAllRead()}>
                Mark all read
              </button>
            ) : null}
          </div>

          {invites.length > 0 && (
            <section className="notification-section">
              <h3>Pending invites</h3>
              <ul className="notification-list">
                {invites.map((invite) => (
                  <li key={invite._id} className="notification-item">
                    <p>
                      <strong>{invite.projectName}</strong>
                      <span className="muted">
                        {' '}
                        · {invite.inviterDisplayName || invite.inviterEmail} · {invite.role}
                      </span>
                    </p>
                    <div className="notification-item-actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busyId === invite._id}
                        onClick={() => void handleAccept(invite._id)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busyId === invite._id}
                        onClick={() => void handleDecline(invite._id)}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="notification-section">
            <h3>Recent</h3>
            {notifications.length === 0 ? (
              <p className="muted">No notifications yet.</p>
            ) : (
              <ul className="notification-list">
                {notifications.map((notification) => (
                  <li
                    key={notification._id}
                    className={`notification-item${notification.read ? '' : ' notification-item-unread'}`}
                  >
                    <button
                      type="button"
                      className="notification-item-button"
                      onClick={() => {
                        if (!notification.read) {
                          void handleMarkRead(notification._id);
                        }
                      }}
                    >
                      {notificationLabel(notification)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error ? <p className="project-toolbar-error">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
