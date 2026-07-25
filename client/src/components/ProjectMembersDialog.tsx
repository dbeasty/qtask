import { useEffect, useState, type FormEvent } from 'react';
import {
  cancelProjectInvite,
  getProjectShareSummary,
  listProjectInvites,
} from '../api/client';
import type { CollaboratorRole, Project, ProjectInvite, ProjectShareSummary } from '../types';

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
const ADD_EMAIL_HINT_ID = 'project-members-add-email-hint';
const ADD_EMAIL_HELPER =
  'Send an invite to an existing qtask user. They must accept before gaining access.';

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
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<ProjectInvite[]>([]);
  const [shareSummary, setShareSummary] = useState<ProjectShareSummary | null>(null);
  const trimmedEmail = email.trim();
  const addMemberDisabled = saving || !trimmedEmail;
  const addMemberDisabledHint =
    !trimmedEmail && !saving ? 'Enter an email address first' : undefined;

  useEffect(() => {
    if (!project.canManageMembers) return;
    Promise.all([listProjectInvites(project._id), getProjectShareSummary(project._id)])
      .then(([{ invites }, { summary }]) => {
        setPendingInvites(invites);
        setShareSummary(summary);
      })
      .catch(() => {
        // optional enrichment
      });
  }, [project._id, project.canManageMembers]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      await onAdd(email.trim(), role);
      setSuccess(`Invite sent to ${email.trim()}. They will be notified by email.`);
      setEmail('');
      setRole('editor');
      const { invites } = await listProjectInvites(project._id);
      setPendingInvites(invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    }
  }

  async function handleCancelInvite(inviteId: string) {
    setError(null);
    try {
      await cancelProjectInvite(project._id, inviteId);
      setPendingInvites((current) => current.filter((invite) => invite._id !== inviteId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel invite');
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

  const shareHint =
    shareSummary && project.canManageMembers
      ? shareSummary.descendantProjectCount > 0
        ? `This project has ${shareSummary.directTaskCount} task${shareSummary.directTaskCount === 1 ? '' : 's'}; sub-projects add ${shareSummary.descendantTaskCount} more that will also be shared.`
        : shareSummary.totalTaskCount === 0
          ? 'This project has no tasks yet. Tasks in sub-projects will be included when added.'
          : `This project has ${shareSummary.totalTaskCount} task${shareSummary.totalTaskCount === 1 ? '' : 's'} to share.`
      : null;

  return (
    <div className="auth-dialog-backdrop" onClick={onClose}>
      <div
        className="auth-dialog project-members-dialog"
        role="dialog"
        aria-labelledby="project-members-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="project-members-title">Members · {project.name}</h2>

        {shareHint ? <p className="muted project-members-share-hint">{shareHint}</p> : null}

        {project.canManageMembers && pendingInvites.length > 0 && (
          <>
            <h3 className="project-members-subheading">Pending invites</h3>
            <ul className="project-members-list">
              {pendingInvites.map((invite) => (
                <li key={invite._id} className="project-members-row">
                  <div className="project-members-identity">
                    <span className="project-members-name">{invite.inviteeEmail}</span>
                    <span className="project-members-meta">Awaiting acceptance · {invite.role}</span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => void handleCancelInvite(invite._id)}
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="project-members-subheading">Members</h3>
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
              Invite by email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="collaborator@example.com"
                disabled={saving}
                autoFocus
                aria-describedby={ADD_EMAIL_HINT_ID}
                required
              />
              <span id={ADD_EMAIL_HINT_ID} className="muted project-members-add-hint">
                {ADD_EMAIL_HELPER}
              </span>
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
              <span
                className="project-members-add-button-wrap"
                title={addMemberDisabledHint}
              >
                <button
                  type="submit"
                  className="primary-button"
                  disabled={addMemberDisabled}
                  aria-describedby={addMemberDisabledHint ? ADD_EMAIL_HINT_ID : undefined}
                >
                  Send invite
                </button>
              </span>
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

        {success ? <p className="project-members-success">{success}</p> : null}
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
