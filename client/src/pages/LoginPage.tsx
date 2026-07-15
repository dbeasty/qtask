import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { forgotPassword, getAuthConfig, resendVerification } from '../auth/storage';

type Mode = 'login' | 'forgot-password';

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

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

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setNeedsVerification(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setNeedsVerification(false);
    setSubmitting(true);

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        const result = await forgotPassword(email);
        setInfo(result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      if (message.toLowerCase().includes('verify your email')) {
        setNeedsVerification(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendVerification() {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const result = await resendVerification(email);
      setInfo(result.message);
      setNeedsVerification(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend verification email');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>QTask</h1>
        <p className="muted">
          {mode === 'forgot-password' ? 'Reset your password' : 'Sign in to manage your tasks'}
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
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

          {mode === 'login' && (
            <label>
              Password
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                minLength={1}
                required
              />
            </label>
          )}

          {mode === 'login' && (
            <button type="button" className="auth-link-btn" onClick={() => switchMode('forgot-password')}>
              Forgot password?
            </button>
          )}

          {error && <p className="auth-error">{error}</p>}
          {info && <p className="auth-success">{info}</p>}

          {needsVerification && (
            <button
              type="button"
              className="auth-link-btn"
              onClick={() => void handleResendVerification()}
              disabled={submitting || !email}
            >
              Resend verification email
            </button>
          )}

          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Send reset link'}
          </button>

          {mode === 'forgot-password' && (
            <button type="button" className="auth-link-btn" onClick={() => switchMode('login')}>
              Back to sign in
            </button>
          )}
        </form>

        {mode === 'login' && registrationEnabled && (
          <p className="auth-hint auth-hint--switch muted">
            Need an account? <a href="/register">Get started</a>
          </p>
        )}

        <p className="auth-back-home muted">
          <a href="/">Back to home</a>
        </p>
      </div>
    </div>
  );
}
