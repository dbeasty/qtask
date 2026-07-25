import { useEffect, useState } from 'react';
import { acceptInviteByToken, getInvitePreview } from '../api/client';
import type { ProjectInvite } from '../types';

interface InviteAcceptPageProps {
  token: string;
  onAccepted: (projectId: string) => void;
  onBack: () => void;
}

export function InviteAcceptPage({ token, onAccepted, onBack }: InviteAcceptPageProps) {
  const [invite, setInvite] = useState<ProjectInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getInvitePreview(token)
      .then(({ invite: preview }) => setInvite(preview))
      .catch((err) => setError(err instanceof Error ? err.message : 'Invite not found'))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleAccept() {
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInviteByToken(token);
      setAccepted(true);
      if (result.project?._id) {
        onAccepted(result.project._id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">Loading invite…</p>
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="auth-page">
        <h1>Invite unavailable</h1>
        <p className="muted">{error ?? 'This invite is invalid or has expired.'}</p>
        <button type="button" className="primary-button" onClick={onBack}>
          Continue to QTask
        </button>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h1>Project invitation</h1>
      {accepted ? (
        <>
          <p>
            You joined <strong>{invite.projectName}</strong>. Open the project to view shared tasks.
          </p>
          <button type="button" className="primary-button" onClick={onBack}>
            Continue
          </button>
        </>
      ) : (
        <>
          <p>
            <strong>{invite.inviterDisplayName || invite.inviterEmail}</strong> invited you to collaborate on{' '}
            <strong>{invite.projectName}</strong> as <strong>{invite.role}</strong>.
          </p>
          <p className="muted">
            Accepting grants access to this project and its sub-projects.
          </p>
          {error ? <p className="project-toolbar-error">{error}</p> : null}
          <div className="auth-dialog-actions">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void handleAccept()}>
              Accept invite
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={onBack}>
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
