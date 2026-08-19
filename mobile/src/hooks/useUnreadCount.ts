import { useQuery } from '@tanstack/react-query';
import { unreadNotificationCount } from '../api/client';

// Polled instead of pushed — the backend has no WebSocket/live-push layer
// (see docs/Mobile_Client_Plan.md §4.1), so this is the "ship v1 on polling"
// approach the plan calls for.
const POLL_INTERVAL_MS = 30_000;

export function useUnreadCount(): number {
  const { data } = useQuery({
    queryKey: ['unread-count'],
    queryFn: unreadNotificationCount,
    refetchInterval: POLL_INTERVAL_MS,
  });
  return data ?? 0;
}
