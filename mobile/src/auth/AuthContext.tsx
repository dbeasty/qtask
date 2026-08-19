import type { AuthUser } from '@qtask/shared';
import { isTokenExpired } from '@qtask/shared';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../api/client';
import { signInWithOAuthProvider } from './oauth';
import {
  clearServerUrl,
  clearStoredToken,
  getStoredToken,
  setServerUrl as persistServerUrl,
} from '../config/storage';

interface AuthContextValue {
  status: 'loading' | 'needs-server' | 'needs-login' | 'authenticated';
  user: AuthUser | null;
  serverUrl: string | null;
  setServerUrl: (url: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginWithOAuthProvider: (providerId: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// QTask's official hosted instance — used to skip the server-setup screen on
// first launch. Self-hosters can still point elsewhere via "Change server".
const DEFAULT_SERVER_URL = 'https://qtask.dev';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    // Hardcoded for now rather than trusting whatever's left over in
    // SecureStore from earlier testing/dev sessions -- every launch starts
    // pointed at the real server, deterministically. "Change server" below
    // can still override it for the current session.
    const url = DEFAULT_SERVER_URL;
    await persistServerUrl(url);
    api.setCachedBaseUrl(url);
    setServerUrlState(url);

    const token = await getStoredToken();
    if (!token || isTokenExpired(token)) {
      setStatus('needs-login');
      return;
    }
    try {
      const me = await api.fetchMe();
      setUser(me);
      setStatus('authenticated');
    } catch {
      await clearStoredToken();
      setStatus('needs-login');
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const handleSetServerUrl = useCallback(async (url: string) => {
    const normalized = url.trim().replace(/\/+$/, '');
    if (!normalized) {
      await clearServerUrl();
      await clearStoredToken();
      api.setCachedBaseUrl(null);
      setServerUrlState(null);
      setUser(null);
      setStatus('needs-server');
      return;
    }
    await persistServerUrl(normalized);
    api.setCachedBaseUrl(normalized);
    setServerUrlState(normalized);
    setStatus('needs-login');
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const loginWithOAuthProvider = useCallback(async (providerId: string) => {
    const result = await signInWithOAuthProvider(providerId);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus('needs-login');
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await api.fetchMe();
    setUser(me);
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      serverUrl,
      setServerUrl: handleSetServerUrl,
      login,
      loginWithOAuthProvider,
      logout,
      refreshUser,
    }),
    [status, user, serverUrl, handleSetServerUrl, login, loginWithOAuthProvider, logout, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
