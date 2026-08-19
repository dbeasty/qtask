export type ThemePreference = 'dark' | 'light';
export type StartupViewPreference = 'auto' | 'agent' | 'projects' | 'tasks' | 'last';

export interface UserPreferences {
  autoApproveProposals: boolean;
  skipConfirmations: boolean;
  trackExpenses: boolean;
  agentEnterToSend: boolean;
  completedDemoTour: boolean;
  theme: ThemePreference;
  startupView: StartupViewPreference;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  emailVerified?: boolean;
  mustChangePassword?: boolean;
  hasPassword?: boolean;
  hourlyRate?: number;
  preferences?: UserPreferences;
}

export interface OAuthProviderPublicInfo {
  id: string;
  label: string;
}

export interface LoginResult {
  token: string;
  user: AuthUser;
  /** True when the user signed in with a temporary password and the token is
   * only valid for POST /api/auth/change-password. */
  mustChangePassword?: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  autoApproveProposals: false,
  skipConfirmations: false,
  trackExpenses: true,
  agentEnterToSend: true,
  completedDemoTour: false,
  theme: 'light',
  startupView: 'last',
};
