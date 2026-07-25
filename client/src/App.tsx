import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { getAuthPathname, isAuthPath } from './auth/session';
import { getUserPreferences } from './auth/storage';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { DemoTourPrompt, useDemoTour } from './components/DemoTour';
import { UserMenu } from './components/UserMenu';
import { AboutPage } from './pages/AboutPage';
import { AgentPage } from './pages/AgentPage';
import { HelpPage } from './pages/HelpPage';
import { LoginPage } from './pages/LoginPage';
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

export function App() {
  const { user, loading, mustChangePassword, logout, updateProfile, updatePreferences } = useAuth();
  const [view, setView] = useState<View>('projects');
  const [healthy, setHealthy] = useState<boolean | null>(null);
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
  const [inviteAcceptToken, setInviteAcceptToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return getAuthPathname() === '/invites/accept' ? params.get('token') : null;
  });
  const defaultViewSetRef = useRef(false);
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

  const refreshHealth = useCallback(() => {
    setHealthy(null);
    checkHealth()
      .then((result) => {
        setHealthy(true);
        if (result.version) setApiVersion(result.version);
        setAiVersion(result.aiVersion ?? null);
      })
      .catch(() => setHealthy(false));
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    if (!user) return;
    refreshPendingInvites();
  }, [user, projectsVersion, refreshPendingInvites]);

  useEffect(() => {
    if (!user) return;
    if (isAuthPath(getAuthPathname())) {
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
    return <WelcomePage />;
  }

  if (mustChangePassword) {
    return (
      <div className="auth-page">
        <ChangePasswordDialog forced />
      </div>
    );
  }

  if (inviteAcceptToken) {
    return (
      <InviteAcceptPage
        token={inviteAcceptToken}
        onAccepted={(projectId) => {
          setActiveProjectId(projectId);
          setInviteAcceptToken(null);
          window.history.replaceState(null, '', '/');
          setAppView('projects');
          handleProjectsChanged();
          refreshPendingInvites();
        }}
        onBack={() => {
          setInviteAcceptToken(null);
          window.history.replaceState(null, '', '/');
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
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
                onOpenHelp={() => setView('help')}
                onStartTour={handleStartTour}
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
          <p className="header-tagline muted">AI-native task management</p>
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

      <main>
        <div className={view === 'agent' ? 'view-panel' : 'view-panel view-panel--hidden'}>
          <AgentPage
            activeProjectId={activeProjectId}
            onTasksChanged={handleTasksChanged}
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
          <HelpPage onBack={() => setAppView('projects')} onStartTour={handleStartTour} />
        ) : view === 'about' ? (
          <AboutPage apiVersion={apiVersion} aiVersion={aiVersion} onBack={() => setAppView('projects')} />
        ) : view === 'tasks' ? (
          <TasksPage
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
      {showTourPrompt ? (
        <DemoTourPrompt onStart={handleStartTour} onDismiss={handleDismissTourPrompt} />
      ) : null}
    </div>
  );
}
