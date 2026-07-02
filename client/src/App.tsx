import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { TasksPage } from './pages/TasksPage';
import { checkHealth } from './api/client';
import './styles.css';

type View = 'chat' | 'tasks';

export function App() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>('chat');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [suggestedProjectName, setSuggestedProjectName] = useState('');

  useEffect(() => {
    checkHealth()
      .then(() => setHealthy(true))
      .catch(() => setHealthy(false));
  }, []);

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

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>QTask</h1>
          <p className="muted">AI-native task management</p>
        </div>
        <div className="header-actions">
          <span className={`status-pill ${healthy ? 'ok' : healthy === false ? 'bad' : ''}`}>
            {healthy == null ? 'Checking API…' : healthy ? 'API connected' : 'API offline'}
          </span>
          <span className="user-pill muted">{user.displayName ?? user.email}</span>
          <button type="button" className="logout-btn" onClick={logout}>
            Sign out
          </button>
          <nav>
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
    </div>
  );
}
