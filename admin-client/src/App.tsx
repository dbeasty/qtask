import { useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { OllamaPage } from './pages/OllamaPage';
import { UsersPage } from './pages/UsersPage';
import './styles.css';

type View = 'users' | 'ollama';

export function App() {
  const { admin, loading, logout } = useAuth();
  const [view, setView] = useState<View>('users');

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
            </nav>
          </div>
          <div className="header-user">
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

      <main>{view === 'users' ? <UsersPage /> : <OllamaPage />}</main>
    </div>
  );
}
