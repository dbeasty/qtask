import { useState, type FormEvent } from 'react';
import { resetUserPassword } from '../api/client';
import { generateStrongPassword } from '../utils/password';
import { PasswordInput } from './PasswordInput';
import type { AdminUser } from '../types';

interface ResetPasswordDialogProps {
  user: AdminUser;
  onClose: () => void;
}

export function ResetPasswordDialog({ user, onClose }: ResetPasswordDialogProps) {
  const [password, setPassword] = useState(() => generateStrongPassword());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetUserPassword(user.id, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Reset password for ${user.email}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Reset password</h2>
        <p className="muted">
          Set a temporary password for <strong>{user.email}</strong>. Share it with the user over a
          secure channel; they should change it after signing in.
        </p>

        {done ? (
          <>
            <p className="dialog-success">Password has been reset.</p>
            <div className="dialog-copy-row">
              <code className="dialog-password">{password}</code>
              <button type="button" onClick={() => void copyPassword()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              Temporary password
              <div className="dialog-copy-row">
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  minLength={10}
                  required
                  autoComplete="off"
                />
                <button type="button" onClick={() => void copyPassword()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </label>
            <button
              type="button"
              className="link-btn"
              onClick={() => setPassword(generateStrongPassword())}
            >
              Generate another suggestion
            </button>

            {error && <p className="dialog-error">{error}</p>}

            <div className="dialog-actions">
              <button type="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? 'Resetting…' : 'Reset password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
