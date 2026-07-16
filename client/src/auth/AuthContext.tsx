import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  changePassword as changePasswordRequest,
  clearStoredToken,
  fetchMe,
  getStoredToken,
  login as loginRequest,
  register as registerRequest,
  setStoredToken,
  updateProfile as updateProfileRequest,
  type AuthUser,
  type ChangePasswordResult,
} from './storage';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** True when the user signed in with a temporary password and must set a
   * new one before accessing the app. */
  mustChangePassword: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string, acceptLegal?: boolean) => Promise<{ message: string }>;
  logout: () => void;
  updateProfile: (displayName: string | null) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<ChangePasswordResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }

    fetchMe(token)
      .then((me) => {
        setUser(me);
        setMustChangePassword(me.mustChangePassword === true);
      })
      .catch(() => clearStoredToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    setStoredToken(result.token);
    setMustChangePassword(result.mustChangePassword === true);
    setUser(result.user);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName?: string, acceptLegal?: boolean) => {
    return registerRequest(email, password, displayName, acceptLegal);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setMustChangePassword(false);
    setUser(null);
  }, []);

  const updateProfile = useCallback(async (displayName: string | null) => {
    const result = await updateProfileRequest(displayName);
    setUser(result.user);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await changePasswordRequest(currentPassword, newPassword);
    if (result.token) {
      setStoredToken(result.token);
    }
    if (result.user) {
      setUser(result.user);
    }
    setMustChangePassword(false);
    return result;
  }, []);

  const value = useMemo(
    () => ({ user, loading, mustChangePassword, login, register, logout, updateProfile, changePassword }),
    [user, loading, mustChangePassword, login, register, logout, updateProfile, changePassword]
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
