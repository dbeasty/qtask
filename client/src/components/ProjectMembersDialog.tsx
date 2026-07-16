import { useState, type FormEvent } from 'react';
import type { CollaboratorRole, Project } from '../types';

interface ProjectMembersDialogProps {
  project: Project;
  currentUserId: string;
  saving: boolean;
  onClose: () => void;
  onAdd: (email: string, role: CollaboratorRole) => Promise<void>;
  onUpdateRole: (collaboratorUserId: string, role: CollaboratorRole) => Promise<void>;
  onRemove: (collaboratorUserId: string) => Promise<void>;
}

const ROLE_OPTIONS: CollaboratorRole[] = ['editor', 'executor', 'viewer'];

export function ProjectMembersDialog({
  project,
  currentUserId,
  saving,
  onClose,
  onAdd,
  onUpdateRole,
  onRemove,
}: ProjectMembersDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CollaboratorRole>('editor');
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await onAdd(email.trim(), role);
      setEmail('');
      setRole('editor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add collaborator');
    }
  }

  async function handleRoleChange(collaboratorUserId: string, nextRole: CollaboratorRole) {
    setError(null);
    try {
      await onUpdateRole(collaboratorUserId, nextRole);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  async function handleRemove(collaboratorUserId: string) {
    setError(null);
    try {
      await onRemove(collaboratorUserId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove collaborator');
    }
  }

  return (
    <div className="auth-dialog-backdrop" onClick={onClose}>
      <div
        className="auth-dialog project-members-dialog"
        role="dialog"
        aria-labelledby="project-members-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="project-members-title">Members · {project.name}</h2>

        <ul className="project-members-list">
          <li className="project-members-row">
            <div className="project-members-identity">
              <span className="project-members-name">
                {project.userId === currentUserId
                  ? 'You'
                  : project.ownerDisplayName || project.ownerEmail}
              </span>
              <span className="project-members-meta">{project.ownerEmail}</span>
            </div>
            <span className="project-members-role-badge">owner</span>
          </li>
          {project.collaborators.map((collaborator) => (
            <li key={collaborator.userId} className="project-members-row">
              <div className="project-members-identity">
                <span className="project-members-name">
                  {collaborator.displayName || collaborator.email}
                </span>
                <span className="project-members-meta">{collaborator.email}</span>
              </div>
              {project.canManageMembers ? (
                <div className="project-members-controls">
                  <select
                    value={collaborator.role}
                    disabled={saving}
                    onChange={(event) =>
                      handleRoleChange(collaborator.userId, event.target.value as CollaboratorRole)
                    }
                    aria-label={`Role for ${collaborator.email}`}
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={saving}
                    onClick={() => handleRemove(collaborator.userId)}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="project-members-role-badge">{collaborator.role}</span>
              )}
            </li>
          ))}
        </ul>

        {project.canManageMembers && (
          <form className="project-members-add" onSubmit={handleAdd}>
            <label className="task-form-field">
              Add by email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="collaborator@example.com"
                disabled={saving}
                required
              />
            </label>
            <label className="task-form-field">
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as CollaboratorRole)}
                disabled={saving}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="auth-dialog-actions">
              <button type="submit" className="primary-button" disabled={saving || !email.trim()}>
                Add member
              </button>
            </div>
          </form>
        )}

        {!project.canManageMembers && project.role !== 'owner' && (
          <div className="auth-dialog-actions">
            <button
              type="button"
              className="danger-button"
              disabled={saving}
              onClick={() => handleRemove(currentUserId)}
            >
              Leave project
            </button>
          </div>
        )}

        {error && <p className="project-toolbar-error">{error}</p>}

        <div className="auth-dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
