import { useEffect, useState } from 'react';
import { acceptInviteByToken, getInvitePreviewPublic } from '../api/client';
import { getAuthConfig, type OAuthProviderPublicInfo } from '../auth/storage';
import { OAuthProviderButtons } from '../components/OAuthProviderButtons';
import type { PublicProjectInvite } from '../types';

interface InviteAcceptPageProps {
  token: string;
  authenticated?: boolean;
  onAccepted: (projectId: string) => void;
  onBack: () => void;
}

export function InviteAcceptPage({
  token,
  authenticated = true,
  onAccepted,
  onBack,
}: InviteAcceptPageProps) {
  const [invite, setInvite] = useState<PublicProjectInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderPublicInfo[]>([]);
  const [oauthLegalAccepted, setOauthLegalAccepted] = useState(false);

  useEffect(() => {
    if (!authenticated) {
      let cancelled = false;
      void getAuthConfig().then((config) => {
        if (!cancelled) {
          setRegistrationEnabled(config.registrationEnabled);
          setOauthProviders(config.oauthProviders ?? []);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [authenticated]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getInvitePreviewPublic(token)
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

  const inviterLabel = invite.inviterDisplayName || invite.inviterEmail;

  if (!authenticated) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Project invitation</h1>
          <p>
            <strong>{inviterLabel}</strong> invited you to collaborate on{' '}
            <strong>{invite.projectName}</strong> as <strong>{invite.role}</strong>.
          </p>
          <p className="muted">Invitation for {invite.inviteeEmail}</p>
          <p className="muted">
            Sign in or create an account with this email address, then accept the invite to join the
            project.
          </p>
          {registrationEnabled === false ? (
            <p className="project-toolbar-error">
              Registration is not currently enabled. Contact the person who invited you for help.
            </p>
          ) : (
            <>
              <div className="auth-dialog-actions">
                <a className="primary-button auth-submit" href="/register">
                  Create account
                </a>
                <a className="secondary-button" href="/login">
                  Sign in
                </a>
              </div>
              {oauthProviders.length > 0 ? (
                <>
                  <label className="auth-legal-checkbox">
                    <input
                      type="checkbox"
                      checked={oauthLegalAccepted}
                      onChange={(e) => setOauthLegalAccepted(e.target.checked)}
                    />
                    <span>
                      I accept the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>
                    </span>
                  </label>
                  <OAuthProviderButtons
                    providers={oauthProviders}
                    registrationEnabled={registrationEnabled === true}
                    requireLegalAcceptance
                    legalAccepted={oauthLegalAccepted}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
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
            <strong>{inviterLabel}</strong> invited you to collaborate on{' '}
            <strong>{invite.projectName}</strong> as <strong>{invite.role}</strong>.
          </p>
          <p className="muted">Accepting grants access to this project and its sub-projects.</p>
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

function InviteContextBanner({ invite }: { invite: PublicProjectInvite }) {
  return (
    <p className="auth-hint invite-context-banner">
      You&apos;re joining <strong>{invite.projectName}</strong> as <strong>{invite.role}</strong>.
    </p>
  );
}

export { InviteContextBanner };
