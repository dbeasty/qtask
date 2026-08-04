import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { getAuthPathname, isAuthPath } from './auth/session';
import { getUserPreferences } from './auth/storage';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { McpSettingsDialog } from './components/McpSettingsDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { DemoTourPrompt, useDemoTour } from './components/DemoTour';
import { UserMenu } from './components/UserMenu';
import { AboutPage } from './pages/AboutPage';
import { AgentPage } from './pages/AgentPage';
import { HelpPage } from './pages/HelpPage';
import { LoginPage } from './pages/LoginPage';
import { OAuthConsentPage } from './pages/OAuthConsentPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { TasksPage } from './pages/TasksPage';
import { SearchPage } from './pages/SearchPage';
import type { Selection } from './components/TaskHierarchyTree';
import { TermsPage } from './pages/TermsPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { WelcomePage } from './pages/WelcomePage';
import { NotificationBell } from './components/NotificationBell';
import { InviteAcceptPage } from './pages/InviteAcceptPage';
import { checkHealth, listInvites, listProjects } from './api/client';
import {
  captureInviteTokenFromUrl,
  clearPendingInviteToken,
  getPendingInviteToken,
} from './utils/inviteToken';
import {
  getStoredActiveProjectId,
  setStoredActiveProjectId,
} from './utils/projectTree';
import { getDefaultProject } from './utils/project';
import {
  getAppSessionState,
  mergeAppSessionState,
  resolveStartupView,
  setSessionPersistEnabled,
  type MainView,
} from './utils/appSessionState';
import '../../shared/theme-tokens.css';
import './styles.css';

type View = 'projects' | 'agent' | 'tasks' | 'search' | 'help' | 'about';

interface SessionRestore {
  tasks?: {
    selection: Selection | null;
    taskListExpanded?: boolean;
  };
  projects?: {
    listExpanded?: boolean;
  };
  agent?: {
    conversationId?: string;
  };
}

function isMainView(value: View): value is MainView {
  return value === 'agent' || value === 'projects' || value === 'tasks';
}

function captureTaskLinkFromUrl(): {
  taskId: string;
  projectId?: string;
  subtaskPath?: string[];
} | null {
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get('taskId');
  if (!taskId) return null;

  const projectId = params.get('projectId') ?? undefined;
  const subtaskPathRaw = params.get('subtaskPath');
  const subtaskPath = subtaskPathRaw ? subtaskPathRaw.split(',').filter(Boolean) : undefined;

  params.delete('taskId');
  params.delete('projectId');
  params.delete('subtaskPath');
  if (params.get('view') === 'tasks') params.delete('view');
  const remaining = params.toString();
  window.history.replaceState(null, '', remaining ? `?${remaining}` : window.location.pathname);

  return { taskId, projectId, subtaskPath };
}

export function App() {
  const { user, loading, mustChangePassword, logout, updateProfile, updatePreferences } = useAuth();
  const [view, setView] = useState<View>('projects');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [deploymentReadOnly, setDeploymentReadOnly] = useState(false);
  const [deploymentMessage, setDeploymentMessage] = useState<string | null>(null);
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  const [feedbackImagesEnabled, setFeedbackImagesEnabled] = useState(true);
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const [aiVersion, setAiVersion] = useState<string | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [shellRefreshKey, setShellRefreshKey] = useState(0);
  const [suggestedProjectName, setSuggestedProjectName] = useState('');
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() =>
    getStoredActiveProjectId()
  );
  const [pendingTaskSelection, setPendingTaskSelection] = useState<Selection | null>(null);
  const [pendingCreateForProjectId, setPendingCreateForProjectId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [mcpSettingsOpen, setMcpSettingsOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [demoPrompt, setDemoPrompt] = useState<string | null>(null);
  const [demoPromptGeneration, setDemoPromptGeneration] = useState(0);
  const [showTourPrompt, setShowTourPrompt] = useState(false);
  const tourPromptCheckedRef = useRef(false);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previousViewRef = useRef<View>('projects');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [pendingInviteCount, setPendingInviteCount] = useState(0);
  const [inviteAcceptToken, setInviteAcceptToken] = useState<string | null>(() =>
    captureInviteTokenFromUrl()
  );
  const defaultViewSetRef = useRef(false);
  const taskLinkCapturedRef = useRef(false);
  const [sessionRestore, setSessionRestore] = useState<SessionRestore | null>(null);
  const [agentWorking, setAgentWorking] = useState(false);

  const preferences = getUserPreferences(user);

  const setAppView = useCallback((next: View) => {
    setView(next);
    if (isMainView(next)) {
      mergeAppSessionState({ view: next });
    }
  }, []);

  const handleSessionRestoreConsumed = useCallback(() => {
    setSessionRestore(null);
  }, []);

  const refreshPendingInvites = useCallback(() => {
    listInvites('pending')
      .then(({ invites }) => setPendingInviteCount(invites.length))
      .catch(() => {
        // optional shell chrome
      });
  }, []);

  const handleTourComplete = useCallback(async () => {
    setShowTourPrompt(false);
    setDemoPrompt(null);
    await updatePreferences({ completedDemoTour: true });
  }, [updatePreferences]);

  const { startTour } = useDemoTour({
    setView: setAppView,
    onSetDemoPrompt: (prompt) => {
      setDemoPrompt(prompt);
      if (prompt) {
        setDemoPromptGeneration((value) => value + 1);
      }
    },
    onComplete: () => {
      void handleTourComplete();
    },
    autoApproveProposals: preferences.autoApproveProposals,
    onPrepareStep: async (stepId) => {
      if (stepId === 'share-members') {
        setAppView('projects');
        const { projects } = await listProjects();
        if (projects.length > 0) {
          const next = projects[0]!;
          setActiveProjectId(next._id);
        }
      }
    },
  });

  const handleStartTour = useCallback(() => {
    setShowTourPrompt(false);
    void startTour();
  }, [startTour]);

  const handleDismissTourPrompt = useCallback(() => {
    setShowTourPrompt(false);
    void updatePreferences({ completedDemoTour: true });
  }, [updatePreferences]);

  const setActiveProjectId = useCallback((projectId: string | null) => {
    setActiveProjectIdState(projectId);
    setStoredActiveProjectId(projectId);
  }, []);

  const openTaskFromShell = useCallback(
    (taskId: string, projectId?: string, subtaskPath?: string[]) => {
      if (projectId) {
        setActiveProjectId(projectId);
      }
      setPendingTaskSelection(
        subtaskPath && subtaskPath.length > 0
          ? { kind: 'subtask', taskId, path: subtaskPath }
          : { kind: 'task', taskId }
      );
      setAppView('tasks');
    },
    [setActiveProjectId, setAppView]
  );

  const refreshHealth = useCallback(() => {
    setHealthy(null);
    checkHealth()
      .then((result) => {
        setHealthy(true);
        if (result.version) setApiVersion(result.version);
        setAiVersion(result.aiVersion ?? null);
        setDeploymentReadOnly(result.deployment?.readOnly === true);
        setDeploymentMessage(result.deployment?.readOnly ? result.deployment.message : null);
        setFeedbackEnabled(result.features?.feedback !== false);
        setFeedbackImagesEnabled(result.features?.feedbackImages !== false);
      })
      .catch(() => {
        setHealthy(false);
        setDeploymentReadOnly(false);
        setDeploymentMessage(null);
        setFeedbackEnabled(true);
        setFeedbackImagesEnabled(true);
      });
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    const token = captureInviteTokenFromUrl();
    if (token) {
      setInviteAcceptToken(token);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const pending = getPendingInviteToken();
    if (pending) {
      setInviteAcceptToken(pending);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    refreshPendingInvites();
  }, [user, projectsVersion, refreshPendingInvites]);

  useEffect(() => {
    if (!user || taskLinkCapturedRef.current) return;
    const link = captureTaskLinkFromUrl();
    if (!link) return;
    taskLinkCapturedRef.current = true;
    openTaskFromShell(link.taskId, link.projectId, link.subtaskPath);
  }, [user, openTaskFromShell]);

  useEffect(() => {
    if (!user) return;
    const pathname = getAuthPathname();
    // OAuth consent must stay on this page so the user can approve and return to the MCP client.
    if (pathname === '/oauth/consent') return;
    if (isAuthPath(pathname)) {
      window.history.replaceState(null, '', '/');
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      defaultViewSetRef.current = false;
      setSessionPersistEnabled(false);
      setSessionRestore(null);
      return;
    }
    if (defaultViewSetRef.current) return;

    const prefs = getUserPreferences(user);
    const session = getAppSessionState();
    const startupView = resolveStartupView(prefs.startupView, session);

    defaultViewSetRef.current = true;
    setView(startupView);

    if (prefs.startupView === 'last' && session) {
      setSessionRestore({
        tasks: session.tasks,
        projects: session.projects,
        agent: session.agent,
      });
    } else {
      setSessionRestore(null);
    }

    setSessionPersistEnabled(true);
  }, [user]);

  useEffect(() => {
    if (!user) {
      tourPromptCheckedRef.current = false;
      setShowTourPrompt(false);
      return;
    }
    if (!defaultViewSetRef.current || tourPromptCheckedRef.current) return;
    tourPromptCheckedRef.current = true;
    if (!getUserPreferences(user).completedDemoTour) {
      setShowTourPrompt(true);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    listProjects()
      .then(({ projects }) => {
        if (projects.length === 0) {
          setActiveProjectId(null);
          return;
        }
        const matched = activeProjectId
          ? projects.find((project) => project._id === activeProjectId)
          : undefined;
        const next = matched ?? getDefaultProject(projects) ?? projects[0]!;
        if (next._id !== activeProjectId) {
          setActiveProjectId(next._id);
        }
      })
      .catch(() => {
        // project list is optional for shell chrome
      });
  }, [user, activeProjectId, setActiveProjectId, projectsVersion, tasksVersion]);

  const apiStatusLabel =
    healthy == null ? 'Checking API…' : healthy ? 'API connected' : 'API offline';

  const handleTasksChanged = useCallback(() => {
    setTasksVersion((version) => version + 1);
  }, []);

  const handleProjectsChanged = useCallback(() => {
    setProjectsVersion((version) => version + 1);
  }, []);

  const handleShellRefresh = useCallback(() => {
    refreshHealth();
    setTasksVersion((version) => version + 1);
    setProjectsVersion((version) => version + 1);
    setShellRefreshKey((version) => version + 1);
  }, [refreshHealth]);

  useEffect(() => {
    if (!user) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        if (searchQuery.trim()) {
          setView('search');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, searchQuery]);

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const pathname = getAuthPathname();
  if (pathname === '/terms') {
    return <TermsPage />;
  }
  if (pathname === '/privacy') {
    return <PrivacyPage />;
  }

  if (!user) {
    if (pathname === '/oauth/consent') {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(
        null,
        '',
        `/login?returnTo=${encodeURIComponent(returnTo)}`
      );
      return <LoginPage />;
    }
    if (pathname === '/verify-email') {
      return <VerifyEmailPage />;
    }
    if (pathname === '/reset-password') {
      return <ResetPasswordPage />;
    }
    if (pathname === '/login') {
      return <LoginPage />;
    }
    if (pathname === '/register') {
      return <RegisterPage />;
    }
    if (pathname === '/invites/accept') {
      const token = inviteAcceptToken ?? getPendingInviteToken();
      if (token) {
        return (
          <InviteAcceptPage
            token={token}
            authenticated={false}
            onAccepted={() => {}}
            onBack={() => {
              window.history.replaceState(null, '', '/');
            }}
          />
        );
      }
    }
    return <WelcomePage />;
  }

  if (mustChangePassword) {
    return (
      <div className="auth-page">
        <ChangePasswordDialog forced />
      </div>
    );
  }

  if (pathname === '/oauth/consent') {
    return <OAuthConsentPage />;
  }

  if (inviteAcceptToken) {
    return (
      <InviteAcceptPage
        token={inviteAcceptToken}
        onAccepted={(projectId) => {
          clearPendingInviteToken();
          setActiveProjectId(projectId);
          setInviteAcceptToken(null);
          window.history.replaceState(null, '', '/');
          setAppView('projects');
          handleProjectsChanged();
          refreshPendingInvites();
        }}
        onBack={() => {
          clearPendingInviteToken();
          setInviteAcceptToken(null);
          window.history.replaceState(null, '', '/');
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header floating-bar">
        <div className="header-row header-row-top">
          <div className="header-title-group">
            <h1>QTask</h1>
            <button
              type="button"
              className={`api-status-dot ${healthy === true ? 'ok' : healthy === false ? 'bad' : 'checking'}`}
              title={apiStatusLabel}
              aria-label={apiStatusLabel}
              onClick={() => refreshHealth()}
            />
          </div>
        </div>

        <div className="header-row header-row-search">
          <div className="header-search-group">
            <button
              type="button"
              className="header-refresh-button"
              title="Refresh data and API status"
              aria-label="Refresh data and API status"
              onClick={handleShellRefresh}
            >
              <svg
                className="header-refresh-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            <input
              ref={searchInputRef}
              type="search"
              className="header-search-input"
              data-demo-step="header-search"
              value={searchQuery}
              onChange={(event) => {
                const value = event.target.value;
                setSearchQuery(value);
                if (value.trim()) {
                  if (viewRef.current !== 'search') {
                    previousViewRef.current = viewRef.current;
                  }
                  setView('search');
                } else if (viewRef.current === 'search') {
                  setView(previousViewRef.current);
                }
              }}
              placeholder="Search projects and tasks, try task title, project name or step"
              aria-label="Search projects and tasks"
              title="Search (⌘K)"
              autoComplete="off"
            />
          </div>
          <div className="header-user">
            <NotificationBell
              onInvitesChanged={() => {
                refreshPendingInvites();
                handleProjectsChanged();
              }}
              onOpenTask={openTaskFromShell}
            />
            <button
              ref={userMenuTriggerRef}
              type="button"
              className="user-menu-trigger"
              data-demo-step="user-menu"
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              {user.displayName ?? user.email}
              <span className="user-menu-chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            {userMenuOpen && (
              <UserMenu
                user={user}
                anchorRef={userMenuTriggerRef}
                onChangePassword={() => setChangePasswordOpen(true)}
                onOpenMcpSettings={() => setMcpSettingsOpen(true)}
                onOpenHelp={() => setView('help')}
                onStartTour={handleStartTour}
                onOpenFeedback={() => {
                  setFeedbackDialogOpen(true);
                  setUserMenuOpen(false);
                }}
                feedbackEnabled={feedbackEnabled}
                onOpenAbout={() => setView('about')}
                onUpdateDisplayName={(displayName) => updateProfile({ displayName })}
                onUpdatePreferences={updatePreferences}
                onSignOut={logout}
                onClose={() => setUserMenuOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="header-row header-row-bottom">
          <p className="header-tagline muted">AI-native task management · MCP server</p>
          <nav className="header-views-nav" aria-label="Views" data-demo-step="header-views">
            <span className="header-views-label">Views</span>
            <button
              type="button"
              className={`${view === 'agent' ? 'nav-active' : ''}${agentWorking ? ' nav-working' : ''}`}
              onClick={() => setAppView('agent')}
            >
              Agent{agentWorking ? '…' : ''}
            </button>
            <button
              type="button"
              className={view === 'projects' ? 'nav-active' : ''}
              onClick={() => setAppView('projects')}
            >
              Projects
            </button>
            <button
              type="button"
              className={view === 'tasks' ? 'nav-active' : ''}
              onClick={() => setAppView('tasks')}
            >
              Tasks
            </button>
          </nav>
        </div>
      </header>

      {pendingInviteCount > 0 ? (
        <div className="invite-banner" role="status">
          You have {pendingInviteCount} pending project invite{pendingInviteCount === 1 ? '' : 's'}.
          Open notifications to accept or decline.
        </div>
      ) : null}

      {deploymentReadOnly && deploymentMessage ? (
        <div className="warning-banner deployment-banner" role="status">
          {deploymentMessage}
        </div>
      ) : null}

      <main>
        <div className={view === 'agent' ? 'view-panel' : 'view-panel view-panel--hidden'}>
          <AgentPage
            editsDisabled={deploymentReadOnly}
            activeProjectId={activeProjectId}
            onActiveProjectChange={setActiveProjectId}
            onTasksChanged={handleTasksChanged}
            onProjectsChanged={handleProjectsChanged}
            onProjectSuggested={setSuggestedProjectName}
            onOpenTask={(taskId, projectId) => {
              if (projectId) setActiveProjectId(projectId);
              setPendingTaskSelection({ kind: 'task', taskId });
              setAppView('tasks');
            }}
            onOpenProject={(projectId) => {
              setActiveProjectId(projectId);
              setAppView('projects');
            }}
            onNeedProject={() => setAppView('projects')}
            externalRefreshKey={shellRefreshKey}
            projectsRefreshKey={projectsVersion}
            demoPrompt={demoPrompt}
            onDemoPromptConsumed={() => setDemoPrompt(null)}
            demoPromptGeneration={demoPromptGeneration}
            restoredConversationId={sessionRestore?.agent?.conversationId}
            onSessionRestoreConsumed={sessionRestore ? handleSessionRestoreConsumed : undefined}
            isActive={view === 'agent'}
            onAgentWorkingChange={setAgentWorking}
          />
        </div>
        {view === 'projects' ? (
          <ProjectsPage
            editsDisabled={deploymentReadOnly}
            activeProjectId={activeProjectId}
            onActiveProjectChange={(projectId) => {
              setActiveProjectId(projectId);
              handleProjectsChanged();
            }}
            onOpenTask={(taskId, path, projectId) => {
              setActiveProjectId(projectId);
              setPendingTaskSelection(
                path.length === 0
                  ? { kind: 'task', taskId }
                  : { kind: 'subtask', taskId, path }
              );
              setAppView('tasks');
            }}
            onAddTask={(projectId) => {
              setActiveProjectId(projectId);
              setPendingCreateForProjectId(projectId);
              setAppView('tasks');
            }}
            externalRefreshKey={projectsVersion}
            restoredListExpanded={sessionRestore?.projects?.listExpanded}
            onSessionRestoreConsumed={sessionRestore ? handleSessionRestoreConsumed : undefined}
          />
        ) : view === 'search' ? (
          <SearchPage
            query={searchQuery}
            refreshKey={shellRefreshKey}
            onOpenProject={(projectId) => {
              setActiveProjectId(projectId);
              setAppView('projects');
            }}
            onOpenTask={(taskId) => {
              setPendingTaskSelection({ kind: 'task', taskId });
              setAppView('tasks');
            }}
          />
        ) : view === 'help' ? (
          <HelpPage
            onBack={() => setAppView('projects')}
            onStartTour={handleStartTour}
            onOpenFeedback={feedbackEnabled ? () => setFeedbackDialogOpen(true) : undefined}
            feedbackEnabled={feedbackEnabled}
          />
        ) : view === 'about' ? (
          <AboutPage apiVersion={apiVersion} aiVersion={aiVersion} onBack={() => setAppView('projects')} />
        ) : view === 'tasks' ? (
          <TasksPage
            editsDisabled={deploymentReadOnly}
            activeProjectId={activeProjectId}
            onActiveProjectChange={setActiveProjectId}
            externalRefreshKey={tasksVersion}
            suggestedProjectName={suggestedProjectName}
            onNeedProject={() => setAppView('projects')}
            pendingSelection={pendingTaskSelection}
            onPendingSelectionApplied={() => setPendingTaskSelection(null)}
            pendingCreateForProjectId={pendingCreateForProjectId}
            onPendingCreateApplied={() => setPendingCreateForProjectId(null)}
            restoredSelection={sessionRestore?.tasks?.selection ?? undefined}
            restoredTaskListExpanded={sessionRestore?.tasks?.taskListExpanded}
            onSessionRestoreConsumed={sessionRestore ? handleSessionRestoreConsumed : undefined}
          />
        ) : null}
      </main>

      {changePasswordOpen && <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} />}
      {mcpSettingsOpen && <McpSettingsDialog onClose={() => setMcpSettingsOpen(false)} />}
      {feedbackDialogOpen ? (
        <FeedbackDialog
          onClose={() => setFeedbackDialogOpen(false)}
          disabled={deploymentReadOnly}
          contextUrl={window.location.href}
          imagesEnabled={feedbackImagesEnabled}
        />
      ) : null}
      {showTourPrompt ? (
        <DemoTourPrompt onStart={handleStartTour} onDismiss={handleDismissTourPrompt} />
      ) : null}
    </div>
  );
}
