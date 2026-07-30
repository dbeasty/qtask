import { useEffect, useState } from 'react';
import { getInvitePreviewPublic } from '../api/client';
import type { PublicProjectInvite } from '../types';
import { getPendingInviteToken } from '../utils/inviteToken';

export function usePendingInvitePreview() {
  const token = getPendingInviteToken();
  const [invite, setInvite] = useState<PublicProjectInvite | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void getInvitePreviewPublic(token)
      .then(({ invite: preview }) => {
        if (!cancelled) {
          setInvite(preview);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setInvite(null);
          setError(err instanceof Error ? err.message : 'Invite not found');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return { invite, loading, error, token };
}
