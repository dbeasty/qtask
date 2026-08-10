import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  REFRESH_LEAD_MS,
  getTokenExpiryMs,
  isAuthPath,
  msUntilRefresh,
  sessionMessageForReason,
  setSessionMessage,
  type SessionExpiryReason,
} from './session';
import {
  AUTH_TOKEN_KEY,
  changePassword as changePasswordRequest,
  clearStoredToken,
  fetchMe,
  getStoredToken,
  getUserPreferences,
  login as loginRequest,
  refreshSessionRequest,
  register as registerRequest,
  setStoredToken,
  updatePreferences as updatePreferencesRequest,
  updateProfile as updateProfileRequest,
  type AuthUser,
  type ChangePasswordResult,
  type LoginResult,
  type UserPreferences,
} from './storage';
import { setSessionExpiredHandler, setTokenRefreshedHandler } from '../api/client';
import { createLogger } from '../utils/logger';
import { applyTheme, getCachedTheme, resolveTheme } from '../theme';

const logger = createLogger('session');

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  mustChangePassword: boolean;
  login: (email: string, password: string) => Promise<void>;
  applyLoginResult: (result: LoginResult) => void;
  register: (email: string, password: string, displayName?: string, acceptLegal?: boolean) => Promise<{ message: string }>;
  logout: () => void;
  updateProfile: (body: { displayName?: string | null; hourlyRate?: number | null }) => Promise<void>;
  updatePreferences: (preferences: Partial<UserPreferences>) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<ChangePasswordResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutInitiatedRef = useRef(false);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current != null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const applyAuthenticatedUser = useCallback((nextUser: AuthUser) => {
    setUser(nextUser);
    setMustChangePassword(nextUser.mustChangePassword === true);
    applyTheme(resolveTheme(getUserPreferences(nextUser).theme));
  }, []);

  const handleSessionExpired = useCallback(
    (reason: SessionExpiryReason = 'expired', source: 'api' | 'cross_tab' | 'refresh_failed' = 'api') => {
      logger.warn('Session expired', { reason, source, userId: user?.id });
      clearRefreshTimer();
      clearStoredToken();
      setMustChangePassword(false);
      setUser(null);
      if (source !== 'cross_tab') {
        setSessionMessage(sessionMessageForReason(reason));
      }
      if (!isAuthPath()) {
        window.history.replaceState(null, '', '/login');
      }
    },
    [clearRefreshTimer, user?.id]
  );

  const runProactiveRefresh = useCallback(
    async (trigger: 'timer' | 'visibility') => {
      logger.info('Proactive refresh started', { trigger });
      try {
        const result = await refreshSessionRequest();
        setStoredToken(result.token);
        applyAuthenticatedUser(result.user);
        logger.info('Proactive refresh succeeded', {
          trigger,
          newTokenExp: getTokenExpiryMs(result.token) ?? undefined,
        });
      } catch (err) {
        logger.warn('Proactive refresh failed', {
          trigger,
          error: err instanceof Error ? err.message : 'Refresh failed',
        });
        handleSessionExpired('expired', 'refresh_failed');
      }
    },
    [applyAuthenticatedUser, handleSessionExpired]
  );

  const scheduleProactiveRefresh = useCallback(
    (token: string) => {
      clearRefreshTimer();
      const delay = msUntilRefresh(token, REFRESH_LEAD_MS);
      if (delay == null) return;

      logger.debug('Proactive refresh scheduled', {
        refreshInMs: delay,
        tokenExp: getTokenExpiryMs(token) ?? undefined,
      });

      if (delay === 0) {
        void runProactiveRefresh('timer');
        return;
      }

      refreshTimerRef.current = setTimeout(() => {
        void runProactiveRefresh('timer');
      }, delay);
    },
    [clearRefreshTimer, runProactiveRefresh]
  );

  const bootstrapSession = useCallback(
    (token: string, me: AuthUser) => {
      applyAuthenticatedUser(me);
      scheduleProactiveRefresh(token);
    },
    [applyAuthenticatedUser, scheduleProactiveRefresh]
  );

  useEffect(() => {
    const onSessionExpired = (reason: SessionExpiryReason, source: 'api' | 'refresh_failed') => {
      handleSessionExpired(reason, source);
    };

    const onTokenRefreshed = (nextUser: AuthUser, token: string) => {
      applyAuthenticatedUser(nextUser);
      scheduleProactiveRefresh(token);
    };

    setSessionExpiredHandler(onSessionExpired);
    setTokenRefreshedHandler(onTokenRefreshed);

    return () => {
      setSessionExpiredHandler(null);
      setTokenRefreshedHandler(null);
      clearRefreshTimer();
    };
  }, [applyAuthenticatedUser, clearRefreshTimer, handleSessionExpired, scheduleProactiveRefresh]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      applyTheme(getCachedTheme() ?? 'light');
      setLoading(false);
      return;
    }

    fetchMe(token)
      .then((me) => bootstrapSession(token, me))
      .catch(() => clearStoredToken())
      .finally(() => setLoading(false));
  }, [bootstrapSession]);

  useEffect(() => {
    if (!user) {
      applyTheme(getCachedTheme() ?? 'light');
      return;
    }
    applyTheme(resolveTheme(getUserPreferences(user).theme));
  }, [user]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_TOKEN_KEY || event.newValue != null) return;
      if (logoutInitiatedRef.current) return;
      logger.info('Token cleared in another tab', { source: 'storage_event' });
      handleSessionExpired('expired', 'cross_tab');
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [handleSessionExpired]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !user) return;
      const token = getStoredToken();
      if (!token) return;
      const delay = msUntilRefresh(token, REFRESH_LEAD_MS);
      if (delay === 0) {
        void runProactiveRefresh('visibility');
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [runProactiveRefresh, user]);

  const applyLoginResult = useCallback(
    (result: LoginResult) => {
      setStoredToken(result.token);
      applyAuthenticatedUser(result.user);
      scheduleProactiveRefresh(result.token);
    },
    [applyAuthenticatedUser, scheduleProactiveRefresh]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await loginRequest(email, password);
      applyLoginResult(result);
    },
    [applyLoginResult]
  );

  const register = useCallback(async (email: string, password: string, displayName?: string, acceptLegal?: boolean) => {
    return registerRequest(email, password, displayName, acceptLegal);
  }, []);

  const logout = useCallback(() => {
    logoutInitiatedRef.current = true;
    clearRefreshTimer();
    clearStoredToken();
    setMustChangePassword(false);
    setUser(null);
    queueMicrotask(() => {
      logoutInitiatedRef.current = false;
    });
  }, [clearRefreshTimer]);

  const updateProfile = useCallback(async (body: { displayName?: string | null; hourlyRate?: number | null }) => {
    const result = await updateProfileRequest(body);
    setUser(result.user);
  }, []);

  const updatePreferences = useCallback(async (preferences: Partial<UserPreferences>) => {
    if (preferences.theme) {
      applyTheme(preferences.theme);
    }
    const result = await updatePreferencesRequest(preferences);
    setUser(result.user);
    applyTheme(resolveTheme(getUserPreferences(result.user).theme));
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const result = await changePasswordRequest(currentPassword, newPassword);
      if (result.token) {
        setStoredToken(result.token);
        scheduleProactiveRefresh(result.token);
      }
      if (result.user) {
        applyAuthenticatedUser(result.user);
      }
      setMustChangePassword(false);
      return result;
    },
    [applyAuthenticatedUser, scheduleProactiveRefresh]
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      mustChangePassword,
      login,
      applyLoginResult,
      register,
      logout,
      updateProfile,
      updatePreferences,
      changePassword,
    }),
    [
      user,
      loading,
      mustChangePassword,
      login,
      applyLoginResult,
      register,
      logout,
      updateProfile,
      updatePreferences,
      changePassword,
    ]
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
