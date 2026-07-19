import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addProjectCollaborator,
  createProject,
  deleteProject,
  listProjects,
  moveProject,
  removeProjectCollaborator,
  updateProject,
  updateProjectCollaborator,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ProjectMembersDialog } from '../components/ProjectMembersDialog';
import { ProjectHierarchyTree } from '../components/ProjectHierarchyTree';
import { TaskSplitInput } from '../components/TaskSplitInput';
import type { CollaboratorRole, Project, TaskStatus } from '../types';
import { getDefaultProject } from '../utils/project';
import { buildProjectTree } from '../utils/projectTree';

interface ProjectsPageProps {
  activeProjectId: string | null;
  onActiveProjectChange: (projectId: string | null) => void;
  onOpenTasks?: () => void;
  externalRefreshKey?: number;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

function progressShareToFormValue(share: number | undefined): string {
  return share === undefined || share === null ? '' : String(share);
}

export function ProjectsPage({
  activeProjectId,
  onActiveProjectChange,
  onOpenTasks,
  externalRefreshKey = 0,
}: ProjectsPageProps) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [listExpanded, setListExpanded] = useState(true);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [creatingChildOf, setCreatingChildOf] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [detailName, setDetailName] = useState('');
  const [detailDescription, setDetailDescription] = useState('');
  const [detailProgressShare, setDetailProgressShare] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const lastSavedRef = useRef({ name: '', description: '' });
  const saveGenerationRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef(false);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearSavedFade = useCallback(() => {
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { projects: items } = await listProjects();
      setProjects(items);
      if (items.length > 0) {
        const stillValid = activeProjectId && items.some((p) => p._id === activeProjectId);
        if (!stillValid) {
          const fallback = getDefaultProject(items)?._id ?? items[0]!._id;
          onActiveProjectChange(fallback);
        }
      } else {
        onActiveProjectChange(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, onActiveProjectChange]);

  useEffect(() => {
    void refresh();
  }, [refresh, externalRefreshKey]);

  useEffect(() => {
    return () => {
      clearDebounce();
      clearSavedFade();
    };
  }, [clearDebounce, clearSavedFade]);

  const activeProject = useMemo(
    () => projects.find((project) => project._id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const pendingDeleteProject = useMemo(
    () => projects.find((project) => project._id === pendingDeleteId) ?? null,
    [projects, pendingDeleteId]
  );

  useEffect(() => {
    clearDebounce();
    saveGenerationRef.current += 1;
    isDirtyRef.current = false;
    setDetailName(activeProject?.name ?? '');
    setDetailDescription(activeProject?.description ?? '');
    setDetailProgressShare(progressShareToFormValue(activeProject?.progressShare));
    lastSavedRef.current = {
      name: activeProject?.name ?? '',
      description: activeProject?.description ?? '',
    };
    setSaveStatus('idle');
    setSaveError(null);
  }, [activeProject?._id, activeProject?.progressShare, clearDebounce]);

  const tree = useMemo(() => buildProjectTree(projects), [projects]);

  const replaceProject = (project: Project) => {
    setProjects((current) => current.map((item) => (item._id === project._id ? project : item)));
  };

  const handleSelect = (projectId: string) => {
    isDirtyRef.current = false;
    onActiveProjectChange(projectId);
    setCreatingRoot(false);
    setCreatingChildOf(null);
    setActionError(null);
  };

  const handleCreate = async (parentId: string | null) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setActionError('Project name is required');
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const { project } = await createProject({
        name: trimmed,
        description: newDescription.trim() || undefined,
        parentId,
      });
      setProjects((current) => [...current, project]);
      onActiveProjectChange(project._id);
      setNewName('');
      setNewDescription('');
      setCreatingRoot(false);
      setCreatingChildOf(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  const performAutoSave = useCallback(
    async (name: string, description: string) => {
      if (!activeProject || !activeProject.canManageMembers) return;

      const trimmed = name.trim();
      if (!trimmed) {
        setSaveStatus('error');
        setSaveError('Project name cannot be empty');
        return;
      }

      const next = { name: trimmed, description: description.trim() };
      const last = lastSavedRef.current;
      if (next.name === last.name && next.description === last.description) {
        return;
      }

      const generation = saveGenerationRef.current;
      setSaveError(null);
      setSaveStatus('saving');

      try {
        const { project } = await updateProject(activeProject._id, {
          name: next.name,
          description: next.description || null,
        });

        if (generation !== saveGenerationRef.current) return;

        replaceProject(project);
        lastSavedRef.current = {
          name: project.name,
          description: project.description ?? '',
        };
        isDirtyRef.current = false;
        setSaveStatus('saved');
        clearSavedFade();
        savedFadeTimerRef.current = setTimeout(() => {
          setSaveStatus('idle');
        }, 2000);
      } catch (err) {
        if (generation !== saveGenerationRef.current) return;
        setSaveStatus('error');
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      }
    },
    [activeProject, clearSavedFade]
  );

  const scheduleAutoSave = useCallback(
    (name: string, description: string) => {
      if (!activeProject?.canManageMembers) return;
      clearDebounce();
      debounceTimerRef.current = setTimeout(() => {
        void performAutoSave(name, description);
      }, 500);
    },
    [activeProject?.canManageMembers, clearDebounce, performAutoSave]
  );

  const updateDetailName = (value: string) => {
    setDetailName(value);
    isDirtyRef.current =
      value.trim() !== lastSavedRef.current.name ||
      detailDescription.trim() !== lastSavedRef.current.description;
    scheduleAutoSave(value, detailDescription);
  };

  const updateDetailDescription = (value: string) => {
    setDetailDescription(value);
    isDirtyRef.current =
      detailName.trim() !== lastSavedRef.current.name ||
      value.trim() !== lastSavedRef.current.description;
    scheduleAutoSave(detailName, value);
  };

  const handleProgressShareChange = async (value: string) => {
    setDetailProgressShare(value);
    if (!activeProject?.canEdit) return;

    const trimmed = value.trim();
    const nextShare =
      trimmed === '' ? null : Math.max(0, Math.min(100, Math.round(Number(trimmed))));
    if (trimmed !== '' && !Number.isFinite(nextShare)) return;

    const current = activeProject.progressShare;
    const currentNormalized = current === undefined || current === null ? null : current;
    if (nextShare === currentNormalized) return;

    setSaving(true);
    setActionError(null);
    try {
      await updateProject(activeProject._id, { progressShare: nextShare });
      // Parent rollups change; refresh the full tree.
      const { projects: items } = await listProjects();
      setProjects(items);
      setSaveStatus('saved');
      clearSavedFade();
      savedFadeTimerRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, 2000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update project split');
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async (projectId: string, parentId: string | null, index?: number) => {
    setSaving(true);
    setActionError(null);
    try {
      await moveProject(projectId, { parentId, index });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to move project');
    } finally {
      setSaving(false);
    }
  };

  const handleRequestDelete = (projectId: string): void => {
    setPendingDeleteId(projectId);
  };

  const handleDelete = async () => {
    if (!pendingDeleteId) return;
    setSaving(true);
    setActionError(null);
    try {
      const result = await deleteProject(pendingDeleteId);
      setPendingDeleteId(null);
      setMembersOpen(false);
      await refresh();
      if (result.nextProjectId) {
        onActiveProjectChange(result.nextProjectId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setSaving(false);
    }
  };

  const handleAddCollaborator = async (email: string, role: CollaboratorRole) => {
    if (!activeProject) return;
    setSaving(true);
    try {
      const { project } = await addProjectCollaborator(activeProject._id, { email, role });
      replaceProject(project);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateCollaboratorRole = async (
    collaboratorUserId: string,
    role: CollaboratorRole
  ) => {
    if (!activeProject) return;
    setSaving(true);
    try {
      const { project } = await updateProjectCollaborator(activeProject._id, collaboratorUserId, {
        role,
      });
      replaceProject(project);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveCollaborator = async (collaboratorUserId: string) => {
    if (!activeProject) return;
    setSaving(true);
    try {
      const result = await removeProjectCollaborator(activeProject._id, collaboratorUserId);
      if (result.project) replaceProject(result.project);
    } finally {
      setSaving(false);
    }
  };

  const isCreating = creatingRoot || Boolean(creatingChildOf);
  const addProjectLabel = creatingRoot ? 'Cancel' : '+ Add project';
  const addChildLabel = creatingChildOf ? 'Cancel' : '+ Add child';

  return (
    <section className="tasks-page">
      {error && <p className="error-banner">{error}</p>}
      {actionError && <p className="error-banner">{actionError}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && (
        <>
          <div className="project-toolbar-wrap">
            <div className="context-bar-row">
              <button
                type="button"
                className={`project-toolbar-collapsed context-bar-tasks-toggle${listExpanded ? ' expanded' : ''}`}
                aria-expanded={listExpanded}
                onClick={() => setListExpanded((value) => !value)}
              >
                <span
                  className={`project-toolbar-chevron${listExpanded ? ' expanded' : ''}`}
                  aria-hidden="true"
                />
                <span className="project-toolbar-collapsed-label">Projects</span>
              </button>
              <div className="project-toolbar-actions">
                <button
                  type="button"
                  onClick={() => {
                    setCreatingRoot(true);
                    setCreatingChildOf(null);
                    setNewName('');
                    setNewDescription('');
                  }}
                  disabled={saving}
                >
                  New project
                </button>
                <button type="button" onClick={() => void refresh()} disabled={loading || saving}>
                  Refresh
                </button>
              </div>
            </div>
          </div>

          <div className={`tasks-layout${listExpanded ? '' : ' tasks-layout-task-list-collapsed'}`}>
            {listExpanded && (
              <aside className="task-list-panel">
                <header className="task-list-panel-header">
                  <div className="task-list-panel-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={saving}
                      onClick={() => {
                        if (creatingRoot) {
                          setCreatingRoot(false);
                          return;
                        }
                        setCreatingRoot(true);
                        setCreatingChildOf(null);
                        setNewName('');
                        setNewDescription('');
                      }}
                    >
                      {addProjectLabel}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!activeProject || saving || !activeProject.canManageMembers}
                      onClick={() => {
                        if (creatingChildOf) {
                          setCreatingChildOf(null);
                          return;
                        }
                        if (!activeProject) return;
                        setCreatingChildOf(activeProject._id);
                        setCreatingRoot(false);
                        setNewName('');
                        setNewDescription('');
                      }}
                    >
                      {addChildLabel}
                    </button>
                  </div>
                </header>
                <div className="project-sections">
                  <ProjectHierarchyTree
                    projects={projects}
                    tree={tree}
                    selectionId={activeProjectId}
                    saving={saving}
                    onSelect={handleSelect}
                    onMove={handleMove}
                    onDelete={handleRequestDelete}
                  />
                </div>
              </aside>
            )}

            {isCreating && (
              <article className="task-detail-panel">
                <h3 className="panel-title">
                  {creatingChildOf ? 'New child project' : 'New project'}
                </h3>
                <form
                  className="task-form task-detail-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleCreate(creatingChildOf);
                  }}
                >
                  <label className="task-form-field task-form-field-title">
                    <span>Name</span>
                    <input
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      disabled={saving}
                      autoFocus
                    />
                  </label>
                  <label className="task-form-field">
                    <span>Description</span>
                    <textarea
                      value={newDescription}
                      onChange={(event) => setNewDescription(event.target.value)}
                      disabled={saving}
                      rows={4}
                    />
                  </label>
                  <div className="task-form-actions">
                    <button type="submit" className="primary-button" disabled={saving}>
                      Create project
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setCreatingRoot(false);
                        setCreatingChildOf(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </article>
            )}

            {!isCreating && activeProject && (
              <article className="task-detail-panel">
                <h3 className="panel-title">Project details</h3>
                <form className="task-form task-detail-form" onSubmit={(event) => event.preventDefault()}>
                  {saveStatus !== 'idle' && (
                    <p
                      className={`task-save-status task-save-status-${saveStatus}`}
                      role="status"
                      aria-live="polite"
                    >
                      {saveStatus === 'saving' && 'Saving…'}
                      {saveStatus === 'saved' && 'Saved'}
                      {saveStatus === 'error' && (saveError ?? 'Save failed')}
                    </p>
                  )}
                  <label className="task-form-field task-form-field-title">
                    <span>Name</span>
                    <input
                      value={detailName}
                      onChange={(event) => updateDetailName(event.target.value)}
                      disabled={saving || !activeProject.canManageMembers}
                    />
                  </label>
                  <label className="task-form-field">
                    <span>Description</span>
                    <textarea
                      value={detailDescription}
                      onChange={(event) => updateDetailDescription(event.target.value)}
                      disabled={saving || !activeProject.canManageMembers}
                      rows={5}
                    />
                  </label>
                  <div className="task-form-field">
                    <span>Status</span>
                    <input
                      value={STATUS_LABELS[activeProject.status ?? 'todo']}
                      disabled
                      readOnly
                    />
                  </div>
                  <div className="task-form-field">
                    <span>Progress</span>
                    <input
                      value={`${activeProject.percentComplete ?? 0}%`}
                      disabled
                      readOnly
                    />
                  </div>
                  {activeProject.parentId && (
                    <div className="task-form-field">
                      <span>Project split</span>
                      <TaskSplitInput
                        value={detailProgressShare}
                        onChange={(value) => {
                          void handleProgressShareChange(value);
                        }}
                        disabled={saving || !activeProject.canEdit}
                      />
                    </div>
                  )}
                  <p className="muted">
                    Role: {activeProject.role}
                    {activeProject.parentId
                      ? ` · Nested under ${projects.find((p) => p._id === activeProject.parentId)?.name ?? 'parent'}`
                      : ' · Root project'}
                  </p>
                  <div className="task-form-actions">
                    <button type="button" disabled={saving} onClick={() => setMembersOpen(true)}>
                      Members
                    </button>
                    {onOpenTasks && (
                      <button type="button" disabled={saving} onClick={onOpenTasks}>
                        Open tasks
                      </button>
                    )}
                  </div>
                </form>
              </article>
            )}

            {!isCreating && !activeProject && (
              <article className="task-detail-panel task-detail-panel-empty">
                <p className="muted">Select or create a project to get started.</p>
              </article>
            )}
          </div>
        </>
      )}

      {membersOpen && activeProject && user && (
        <ProjectMembersDialog
          project={activeProject}
          currentUserId={user.id}
          saving={saving}
          onClose={() => setMembersOpen(false)}
          onAdd={handleAddCollaborator}
          onUpdateRole={handleUpdateCollaboratorRole}
          onRemove={handleRemoveCollaborator}
        />
      )}

      {pendingDeleteProject && (
        <ConfirmDialog
          title="Delete project?"
          message={`Delete "${pendingDeleteProject.name}"? Child projects move up. Shared tasks are unlinked; tasks only in this project (and its chats) are deleted.`}
          confirmLabel="Delete project"
          busy={saving}
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </section>
  );
}
