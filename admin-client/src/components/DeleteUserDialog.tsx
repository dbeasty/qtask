import { useState, type FormEvent } from 'react';
import { deleteUser } from '../api/client';
import type { AdminUser } from '../types';

interface DeleteUserDialogProps {
  user: AdminUser;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteUserDialog({ user, onClose, onDeleted }: DeleteUserDialogProps) {
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const matches = confirmation.trim() === user.email;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setError(null);
    setSubmitting(true);
    try {
      await deleteUser(user.id, confirmation.trim());
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${user.email}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Delete user</h2>
        <p className="muted">
          This permanently deletes <strong>{user.email}</strong> and all of their projects, tasks,
          and conversations. This cannot be undone.
        </p>

        <form onSubmit={handleSubmit}>
          <label>
            Type the user's email to confirm
            <input
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={user.email}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>

          {error && <p className="dialog-error">{error}</p>}

          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn-danger" disabled={!matches || submitting}>
              {submitting ? 'Deleting…' : 'Delete user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
