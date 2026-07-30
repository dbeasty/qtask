import { useEffect, useState } from 'react';
import {
  denyOAuthConsent,
  fetchOAuthConsent,
  submitOAuthConsent,
  type McpOAuthConsentDetails,
} from '../api/client';

function getConsentState(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('state');
}

export function OAuthConsentPage() {
  const [consent, setConsent] = useState<McpOAuthConsentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const state = getConsentState();
    if (!state) {
      setError('Missing OAuth state.');
      setLoading(false);
      return;
    }

    void fetchOAuthConsent(state)
      .then((result) => {
        setConsent(result.consent);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load authorization request');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  async function handleDecision(action: 'approve' | 'deny') {
    if (!consent) return;
    setSubmitting(true);
    setError(null);
    try {
      const result =
        action === 'approve'
          ? await submitOAuthConsent(consent.state, 'approve')
          : await denyOAuthConsent(consent.state);
      window.location.href = result.redirectUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete authorization');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">Loading authorization request…</p>
      </div>
    );
  }

  if (error && !consent) {
    return (
      <div className="auth-page">
        <h1>Authorization failed</h1>
        <p className="auth-error">{error}</p>
      </div>
    );
  }

  if (!consent) {
    return (
      <div className="auth-page">
        <h1>Authorization failed</h1>
        <p className="auth-error">This authorization request was not found or has expired.</p>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Authorize MCP access</h1>
        <p>
          <strong>{consent.clientName}</strong> is requesting access to your QTask account.
        </p>
        <p className="muted">Resource: <code>{consent.resource}</code></p>
        <ul className="mcp-setup-steps">
          {consent.scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
        </ul>
        {error ? <p className="auth-error">{error}</p> : null}
        <div className="auth-dialog-footer">
          <button
            type="button"
            className="secondary-button"
            disabled={submitting}
            onClick={() => void handleDecision('deny')}
          >
            Deny
          </button>
          <button
            type="button"
            className="auth-submit"
            disabled={submitting}
            onClick={() => void handleDecision('approve')}
          >
            {submitting ? 'Authorizing…' : 'Allow access'}
          </button>
        </div>
      </div>
    </div>
  );
}
