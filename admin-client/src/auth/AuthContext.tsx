import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { exchangeMtls, fetchSession, loginWithPassword, logout as logoutRequest } from '../api/client';
import type { AdminAuthMode } from '../types';

export interface AdminIdentity {
  identity: string;
  authMode: AdminAuthMode;
}

interface AuthContextValue {
  admin: AdminIdentity | null;
  authMode: AdminAuthMode;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  handleSessionExpired: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [authMode, setAuthMode] = useState<AdminAuthMode>('password');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const session = await fetchSession();
      if (cancelled) return;
      setAuthMode(session.authMode);

      if (session.authenticated && session.identity) {
        setAdmin({ identity: session.identity, authMode: session.authMode });
        return;
      }

      if (session.authMode === 'mtls') {
        // The reverse proxy forwards the verified client certificate; this
        // silently issues a session cookie without any prompt.
        const exchanged = await exchangeMtls();
        if (!cancelled && exchanged) {
          setAdmin({ identity: exchanged.identity, authMode: 'mtls' });
        }
      }
    }

    void bootstrap()
      .catch(() => {
        if (!cancelled) setAdmin(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (password: string) => {
    const result = await loginWithPassword(password);
    setAdmin({ identity: result.identity, authMode: 'password' });
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setAdmin(null);
    }
  }, []);

  const handleSessionExpired = useCallback(() => {
    setAdmin(null);
  }, []);

  const value = useMemo(
    () => ({ admin, authMode, loading, login, logout, handleSessionExpired }),
    [admin, authMode, loading, login, logout, handleSessionExpired]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
