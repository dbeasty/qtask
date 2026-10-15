import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './auth/AuthContext';
import { App } from './App';
import { initRuntime } from './runtime';

// In the Mac app this resolves the mode and starts the local session first, so the
// first render already knows whether to show sign-in at all. On the web it returns at once.
void initRuntime().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  );
});
