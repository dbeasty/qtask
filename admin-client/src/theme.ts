export type ThemePreference = 'dark' | 'light';

export const THEME_CACHE_KEY = 'qtask_admin_theme';

export function applyTheme(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  setCachedTheme(theme);
}

export function getCachedTheme(): ThemePreference | null {
  try {
    const value = localStorage.getItem(THEME_CACHE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function setCachedTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // ignore storage failures
  }
}

export function resolveTheme(preference?: ThemePreference | null): ThemePreference {
  return preference === 'light' ? 'light' : 'dark';
}
