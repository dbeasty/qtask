import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';

export function LoginPage() {
  const { login, authMode } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setSubmitting(false);
    }
  }

  if (authMode === 'mtls') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>QTask Admin</h1>
          <p className="muted">
            This admin console requires a verified mTLS client certificate. Automatic sign-in
            failed — check that your certificate is installed and reload the page.
          </p>
          <button
            type="button"
            className="auth-submit"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>QTask Admin</h1>
        <p className="muted">Sign in with the admin password</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Admin password
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={submitting || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
