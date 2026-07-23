import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { ActiveProjectMenu } from './components/ActiveProjectMenu';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { UserMenu } from './components/UserMenu';
import { AboutPage } from './pages/AboutPage';
import { ChatPage } from './pages/ChatPage';
import { HelpPage } from './pages/HelpPage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { TasksPage } from './pages/TasksPage';
import { TermsPage } from './pages/TermsPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { WelcomePage } from './pages/WelcomePage';
import { checkHealth, listProjects, listTasks } from './api/client';
import type { Project } from './types';
import {
  getStoredActiveProjectId,
  setStoredActiveProjectId,
} from './utils/projectTree';
import { getDefaultProject, taskBelongsToProject } from './utils/project';
import './styles.css';

type View = 'projects' | 'chat' | 'tasks' | 'help' | 'about';

const AUTH_PATHS = new Set(['/login', '/register', '/verify-email', '/reset-password']);

function getAuthPathname(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

export function App() {
  const { user, loading, mustChangePassword, logout, updateProfile, updatePreferences } = useAuth();
  const [view, setView] = useState<View>('projects');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [suggestedProjectName, setSuggestedProjectName] = useState('');
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() =>
    getStoredActiveProjectId()
  );
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [headerProjects, setHeaderProjects] = useState<Project[]>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [activeProjectMenuOpen, setActiveProjectMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const activeProjectMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const defaultViewSetRef = useRef(false);

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
      })
      .catch(() => setHealthy(false));
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    if (!user) return;
    if (AUTH_PATHS.has(getAuthPathname())) {
      window.history.replaceState(null, '', '/');
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      defaultViewSetRef.current = false;
      return;
    }
    if (defaultViewSetRef.current) return;

    Promise.all([listProjects(), listTasks()])
      .then(([{ projects }, { tasks }]) => {
        if (defaultViewSetRef.current) return;
        defaultViewSetRef.current = true;

        if (projects.length === 0) {
          setView('projects');
          return;
        }

        const storedId = getStoredActiveProjectId();
        const matched = storedId ? projects.find((project) => project._id === storedId) : undefined;
        const activeProject = matched ?? getDefaultProject(projects) ?? projects[0]!;
        const taskCount = tasks.filter((task) => taskBelongsToProject(task, activeProject._id)).length;

        setView(taskCount > 0 ? 'tasks' : 'chat');
      })
      .catch(() => {
        defaultViewSetRef.current = true;
      });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    listProjects()
      .then(({ projects }) => {
        setHeaderProjects(projects);
        if (projects.length === 0) {
          setActiveProjectId(null);
          setActiveProjectName(null);
          return;
        }
        const matched = activeProjectId
          ? projects.find((project) => project._id === activeProjectId)
          : undefined;
        const next = matched ?? getDefaultProject(projects) ?? projects[0]!;
        if (next._id !== activeProjectId) {
          setActiveProjectId(next._id);
        }
        setActiveProjectName(next.name);
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
          <div className="header-user">
            <button
              ref={userMenuTriggerRef}
              type="button"
              className="user-menu-trigger"
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
                onOpenAbout={() => setView('about')}
                onUpdateDisplayName={updateProfile}
                onUpdatePreferences={updatePreferences}
                onSignOut={logout}
                onClose={() => setUserMenuOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="header-row header-row-bottom">
          <p className="header-tagline muted">
            AI-native task management
            {activeProjectName ? (
              <>
                {' '}
                ·{' '}
                <button
                  ref={activeProjectMenuTriggerRef}
                  type="button"
                  className="header-active-project"
                  aria-expanded={activeProjectMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setActiveProjectMenuOpen((open) => !open)}
                >
                  {activeProjectName}
                  <span className="header-active-project-chevron" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {activeProjectMenuOpen && (
                  <ActiveProjectMenu
                    anchorRef={activeProjectMenuTriggerRef}
                    projects={headerProjects}
                    activeProjectId={activeProjectId}
                    onSelectProject={(projectId) => {
                      const project = headerProjects.find((p) => p._id === projectId);
                      setActiveProjectId(projectId);
                      if (project) setActiveProjectName(project.name);
                    }}
                    onOpenProjectView={() => setView('projects')}
                    onClose={() => setActiveProjectMenuOpen(false)}
                  />
                )}
              </>
            ) : null}
          </p>
          <nav className="header-views-nav" aria-label="Views">
            <span className="header-views-label">Views</span>
            <button
              type="button"
              className={view === 'chat' ? 'nav-active' : ''}
              onClick={() => setView('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className={view === 'projects' ? 'nav-active' : ''}
              onClick={() => setView('projects')}
            >
              Projects
            </button>
            <button
              type="button"
              className={view === 'tasks' ? 'nav-active' : ''}
              onClick={() => setView('tasks')}
            >
              Tasks
            </button>
          </nav>
        </div>
      </header>

      <main>
        {view === 'projects' ? (
          <ProjectsPage
            activeProjectId={activeProjectId}
            onActiveProjectChange={(projectId) => {
              setActiveProjectId(projectId);
              handleProjectsChanged();
            }}
            onOpenTasks={() => setView('tasks')}
            externalRefreshKey={projectsVersion}
          />
        ) : view === 'chat' ? (
          <ChatPage
            activeProjectId={activeProjectId}
            onTasksChanged={handleTasksChanged}
            onProjectSuggested={setSuggestedProjectName}
            onNeedProject={() => setView('projects')}
          />
        ) : view === 'help' ? (
          <HelpPage onBack={() => setView('projects')} />
        ) : view === 'about' ? (
          <AboutPage apiVersion={apiVersion} onBack={() => setView('projects')} />
        ) : (
          <TasksPage
            activeProjectId={activeProjectId}
            onActiveProjectChange={setActiveProjectId}
            externalRefreshKey={tasksVersion}
            suggestedProjectName={suggestedProjectName}
            onNeedProject={() => setView('projects')}
          />
        )}
      </main>

      {changePasswordOpen && <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} />}
    </div>
  );
}
