import { useEffect, useState, type FormEvent } from 'react';
import {
  cancelProjectInvite,
  getProjectShareSummary,
  listProjectInvites,
  listShareContacts,
} from '../api/client';
import type {
  CollaboratorRole,
  Project,
  ProjectInvite,
  ProjectShareSummary,
  ShareContact,
  UserSummary,
} from '../types';
import { UserIdentity } from './UserIdentity';

interface ProjectMembersDialogProps {
  project: Project;
  currentUserId: string;
  saving: boolean;
  onClose: () => void;
  onAdd: (input: { email?: string; userId?: string }, role: CollaboratorRole) => Promise<void>;
  onUpdateRole: (collaboratorUserId: string, role: CollaboratorRole) => Promise<void>;
  onRemove: (collaboratorUserId: string) => Promise<void>;
}

const ROLE_OPTIONS: CollaboratorRole[] = ['manager', 'editor', 'executor', 'viewer'];
const ADD_EMAIL_HINT_ID = 'project-members-add-email-hint';
const ADD_EMAIL_HELPER =
  'Send an invite to an existing qtask user. They must accept before gaining access.';

function inviteUserSummary(invite: ProjectInvite): UserSummary {
  return {
    userId: invite.inviteeUserId ?? invite.inviteeEmail,
    email: invite.inviteeEmail,
    displayName: invite.inviteeDisplayName,
  };
}

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
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [showEmailInvite, setShowEmailInvite] = useState(false);
  const [shareContacts, setShareContacts] = useState<ShareContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<ProjectInvite[]>([]);
  const [shareSummary, setShareSummary] = useState<ProjectShareSummary | null>(null);
  const trimmedEmail = email.trim();
  const selectedContact = shareContacts.find((c) => c.userId === selectedContactId) ?? null;
  const canSendToContact = Boolean(selectedContact && !saving);
  const canSendToEmail = Boolean(trimmedEmail && !saving);
  const addMemberDisabled = showEmailInvite ? !canSendToEmail : !canSendToContact;
  const addMemberDisabledHint = addMemberDisabled
    ? showEmailInvite
      ? 'Enter an email address first'
      : 'Select someone to invite'
    : undefined;

  useEffect(() => {
    if (!project.canManageMembers) return;
    Promise.all([
      listProjectInvites(project._id),
      getProjectShareSummary(project._id),
      listShareContacts(project._id),
    ])
      .then(([{ invites }, { summary }, { contacts }]) => {
        setPendingInvites(invites);
        setShareSummary(summary);
        setShareContacts(contacts);
        if (contacts.length === 0) {
          setShowEmailInvite(true);
        }
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
      if (showEmailInvite) {
        await onAdd({ email: trimmedEmail }, role);
        setSuccess(`Invite sent to ${trimmedEmail}. They will be notified by email.`);
        setEmail('');
      } else if (selectedContact) {
        await onAdd({ userId: selectedContact.userId }, role);
        const label = selectedContact.displayName || selectedContact.email;
        setSuccess(`Invite sent to ${label}. They will be notified by email.`);
        setSelectedContactId(null);
      } else {
        return;
      }
      setRole('editor');
      const [{ invites }, { contacts }] = await Promise.all([
        listProjectInvites(project._id),
        listShareContacts(project._id),
      ]);
      setPendingInvites(invites);
      setShareContacts(contacts);
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
                  <UserIdentity user={inviteUserSummary(invite)} size="sm" />
                  <span className="project-members-meta-inline muted">
                    Awaiting acceptance · {invite.role}
                  </span>
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
            <UserIdentity
              user={{
                userId: project.userId,
                email: project.ownerEmail,
                displayName: project.ownerDisplayName,
              }}
              you={project.userId === currentUserId}
              size="sm"
            />
            <span className="project-members-role-badge">owner</span>
          </li>
          {project.collaborators.map((collaborator) => (
            <li key={collaborator.userId} className="project-members-row">
              <UserIdentity user={collaborator} size="sm" />
              {project.canManageMembers ? (
                <div className="project-members-controls">
                  <select
                    value={collaborator.role}
                    disabled={saving}
                    onChange={(event) =>
                      handleRoleChange(collaborator.userId, event.target.value as CollaboratorRole)
                    }
                    aria-label={`Role for ${collaborator.displayName || collaborator.email}`}
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
            {!showEmailInvite && (
              <>
                <h3 className="project-members-subheading">Recent collaborators</h3>
                {shareContacts.length > 0 ? (
                  <ul className="project-members-contact-list" role="listbox" aria-label="Recent collaborators">
                    {shareContacts.map((contact) => {
                      const selected = selectedContactId === contact.userId;
                      return (
                        <li key={contact.userId}>
                          <button
                            type="button"
                            className={`project-members-contact${selected ? ' selected' : ''}`}
                            role="option"
                            aria-selected={selected}
                            disabled={saving}
                            onClick={() =>
                              setSelectedContactId(selected ? null : contact.userId)
                            }
                          >
                            <UserIdentity user={contact} size="sm" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted project-members-empty-contacts">
                    No recent collaborators yet. Invite someone by email below.
                  </p>
                )}
              </>
            )}

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
              <span className="project-members-add-button-wrap" title={addMemberDisabledHint}>
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

            {!showEmailInvite && shareContacts.length > 0 ? (
              <button
                type="button"
                className="link-button project-members-email-toggle"
                disabled={saving}
                onClick={() => setShowEmailInvite(true)}
              >
                Invite someone new by email
              </button>
            ) : null}

            {showEmailInvite ? (
              <>
                {shareContacts.length > 0 ? (
                  <button
                    type="button"
                    className="link-button project-members-email-toggle"
                    disabled={saving}
                    onClick={() => {
                      setShowEmailInvite(false);
                      setEmail('');
                    }}
                  >
                    Back to recent collaborators
                  </button>
                ) : null}
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
                    required={showEmailInvite}
                  />
                  <span id={ADD_EMAIL_HINT_ID} className="muted project-members-add-hint">
                    {ADD_EMAIL_HELPER}
                  </span>
                </label>
              </>
            ) : null}
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
