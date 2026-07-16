import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { UserMenu } from './components/UserMenu';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { TasksPage } from './pages/TasksPage';
import { TermsPage } from './pages/TermsPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { WelcomePage } from './pages/WelcomePage';
import { checkHealth } from './api/client';
import './styles.css';

type View = 'chat' | 'tasks';

const AUTH_PATHS = new Set(['/login', '/register', '/verify-email', '/reset-password']);

function getAuthPathname(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

export function App() {
  const { user, loading, mustChangePassword, logout, updateProfile, updatePreferences } = useAuth();
  const [view, setView] = useState<View>('chat');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [suggestedProjectName, setSuggestedProjectName] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);

  const refreshHealth = useCallback(() => {
    setHealthy(null);
    checkHealth()
      .then(() => setHealthy(true))
      .catch(() => setHealthy(false));
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  // Keep the address bar in sync once signed in (login never navigated away).
  useEffect(() => {
    if (!user) return;
    if (AUTH_PATHS.has(getAuthPathname())) {
      window.history.replaceState(null, '', '/');
    }
  }, [user]);

  const apiStatusLabel =
    healthy == null ? 'Checking API…' : healthy ? 'API connected' : 'API offline';

  const handleTasksChanged = useCallback(() => {
    setTasksVersion((version) => version + 1);
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
    // Block the entire app until the temporary password has been replaced.
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
                onUpdateDisplayName={updateProfile}
                onUpdatePreferences={updatePreferences}
                onSignOut={logout}
                onClose={() => setUserMenuOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="header-row header-row-bottom">
          <p className="header-tagline muted">AI-native task management</p>
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
              className={view === 'tasks' ? 'nav-active' : ''}
              onClick={() => setView('tasks')}
            >
              Tasks
            </button>
          </nav>
        </div>
      </header>

      <main>
        {view === 'chat' ? (
          <ChatPage
            onTasksChanged={handleTasksChanged}
            onProjectSuggested={setSuggestedProjectName}
          />
        ) : (
          <TasksPage
            externalRefreshKey={tasksVersion}
            suggestedProjectName={suggestedProjectName}
          />
        )}
      </main>

      {changePasswordOpen && <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} />}
    </div>
  );
}
