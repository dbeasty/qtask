import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { getAuthConfig } from '../auth/storage';

export function RegisterPage() {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acceptLegal, setAcceptLegal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAuthConfig().then((config) => {
      if (!cancelled) {
        setRegistrationEnabled(config.registrationEnabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);

    try {
      const result = await register(email, password, displayName || undefined, acceptLegal);
      setInfo(result.message);
      setCheckEmail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (registrationEnabled === null) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>QTask</h1>
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!registrationEnabled) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>QTask</h1>
          <p className="auth-hint muted">Registration is not enabled currently.</p>
          <p className="muted">
            <a href="/login">Sign in</a>
            <span aria-hidden="true"> · </span>
            <a href="/">Back to home</a>
          </p>
        </div>
      </div>
    );
  }

  if (checkEmail) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>QTask</h1>
          <p className="auth-success">{info ?? 'Check your email to verify your account.'}</p>
          <p className="muted">We sent a verification link to {email || 'your email address'}.</p>
          <a className="auth-link" href="/login">
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  const canSubmit = !submitting && acceptLegal;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>QTask</h1>
        <p className="muted">Create an account to get started</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              placeholder="Optional"
            />
          </label>

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label>
            Password
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </label>

          <p className="auth-hint muted">Password must be at least 10 characters.</p>

          <label className="legal-checkbox">
            <input
              type="checkbox"
              checked={acceptLegal}
              onChange={(e) => setAcceptLegal(e.target.checked)}
              required
            />
            <span>
              I agree to the <a href="/terms">Terms &amp; Disclaimer</a> and{' '}
              <a href="/privacy">Privacy Policy</a>
            </span>
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={!canSubmit}>
            {submitting ? 'Please wait…' : 'Create account'}
          </button>
        </form>

        <p className="auth-hint muted">
          Already have an account? <a href="/login">Sign in</a>
        </p>

        <p className="auth-back-home muted">
          <a href="/">Back to home</a>
        </p>
      </div>
    </div>
  );
}
