import { useState, type FormEvent } from 'react';
import { PasswordInput } from '../components/PasswordInput';
import { resetPassword } from '../auth/storage';

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError('Missing reset token.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await resetPassword(token, password);
      setSuccess(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Reset password</h1>
          <p className="auth-error">Missing reset token.</p>
          <a className="auth-link" href="/login">
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Reset password</h1>
        <p className="muted">Choose a new password for your account.</p>

        {success ? (
          <>
            <p className="auth-success">{success}</p>
            <a className="auth-link" href="/login">
              Go to sign in
            </a>
          </>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              New password
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>

            <label>
              Confirm new password
              <PasswordInput
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>

            <p className="auth-hint muted">Password must be at least 10 characters.</p>

            {error && <p className="auth-error">{error}</p>}

            <button type="submit" className="auth-submit" disabled={submitting}>
              {submitting ? 'Please wait…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
