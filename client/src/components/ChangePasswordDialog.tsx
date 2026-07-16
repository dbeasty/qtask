import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { PasswordInput } from './PasswordInput';
import { useAuth } from '../auth/AuthContext';

interface ChangePasswordDialogProps {
  onClose?: () => void;
  /** When true the dialog cannot be dismissed: the user signed in with a
   * temporary password and must set a new one before using the app. */
  forced?: boolean;
}

export function ChangePasswordDialog({ onClose, forced = false }: ChangePasswordDialogProps) {
  const { changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (!forced) {
        setSuccess(result.message ?? 'Password updated.');
      }
      // In forced mode the dialog unmounts automatically once the auth
      // context clears the must-change-password flag.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  return createPortal(
    <div className="auth-dialog-backdrop" onClick={forced ? undefined : onClose}>
      <div
        className="auth-dialog"
        role="dialog"
        aria-labelledby="change-password-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="change-password-title">
          {forced ? 'Set a new password' : 'Change password'}
        </h2>

        {forced && (
          <p className="muted">
            You signed in with a temporary password. Choose a new password to continue.
          </p>
        )}

        {success ? (
          <>
            <p className="auth-success">{success}</p>
            <button type="button" className="auth-submit" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              {forced ? 'Temporary password' : 'Current password'}
              <PasswordInput
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
                required
              />
            </label>

            <label>
              New password
              <PasswordInput
                value={newPassword}
                onChange={setNewPassword}
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

            <div className="auth-dialog-actions">
              {forced ? (
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={logout}
                  disabled={submitting}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancel
                </button>
              )}
              <button type="submit" className="auth-submit" disabled={submitting}>
                {submitting ? 'Please wait…' : 'Update password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
