import { useEffect, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { FeedbackPage } from './pages/FeedbackPage';
import { LoginPage } from './pages/LoginPage';
import { OllamaPage } from './pages/OllamaPage';
import { UsersPage } from './pages/UsersPage';
import { applyTheme, getCachedTheme, type ThemePreference } from './theme';
import '../../shared/theme-tokens.css';
import './styles.css';

type View = 'users' | 'ollama' | 'feedback';

export function App() {
  const { admin, loading, logout } = useAuth();
  const [view, setView] = useState<View>('users');
  const [theme, setTheme] = useState<ThemePreference>(() => getCachedTheme() ?? 'light');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function handleThemeChange(next: ThemePreference) {
    setTheme(next);
    applyTheme(next);
  }

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">Checking session…</p>
      </div>
    );
  }

  if (!admin) {
    return <LoginPage />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-row">
          <div className="header-title-group">
            <h1>QTask Admin</h1>
            <nav className="header-nav" aria-label="Sections">
              <button
                type="button"
                className={view === 'users' ? 'nav-active' : ''}
                onClick={() => setView('users')}
              >
                Users
              </button>
              <button
                type="button"
                className={view === 'ollama' ? 'nav-active' : ''}
                onClick={() => setView('ollama')}
              >
                Ollama
              </button>
              <button
                type="button"
                className={view === 'feedback' ? 'nav-active' : ''}
                onClick={() => setView('feedback')}
              >
                Feedback
              </button>
            </nav>
          </div>
          <div className="header-user">
            <div className="theme-toggle" role="group" aria-label="Theme">
              <button
                type="button"
                className={theme === 'dark' ? 'theme-toggle-option active' : 'theme-toggle-option'}
                onClick={() => handleThemeChange('dark')}
              >
                Dark
              </button>
              <button
                type="button"
                className={theme === 'light' ? 'theme-toggle-option active' : 'theme-toggle-option'}
                onClick={() => handleThemeChange('light')}
              >
                Light
              </button>
            </div>
            <span className="muted">
              {admin.identity}
              {admin.authMode === 'mtls' ? ' (mTLS)' : ''}
            </span>
            <button type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main>
        {view === 'users' ? <UsersPage /> : view === 'ollama' ? <OllamaPage /> : <FeedbackPage />}
      </main>
    </div>
  );
}
