import { useCallback, useEffect, useState } from 'react';
import { ChatPage } from './pages/ChatPage';
import { TasksPage } from './pages/TasksPage';
import { checkHealth } from './api/client';
import './styles.css';

type View = 'chat' | 'tasks';

export function App() {
  const [view, setView] = useState<View>('chat');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);

  useEffect(() => {
    checkHealth()
      .then(() => setHealthy(true))
      .catch(() => setHealthy(false));
  }, []);

  const handleTasksChanged = useCallback(() => {
    setTasksVersion((version) => version + 1);
  }, []);

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
          <ChatPage onTasksChanged={handleTasksChanged} />
        ) : (
          <TasksPage key={tasksVersion} onTasksChanged={handleTasksChanged} />
        )}
      </main>
    </div>
  );
}
