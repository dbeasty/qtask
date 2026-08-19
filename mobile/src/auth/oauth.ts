import type { LoginResult } from '@qtask/shared';
import * as WebBrowser from 'expo-web-browser';
import { exchangeOAuthCode, resolveBaseUrl } from '../api/client';

// The QTask backend only allows redirecting to this exact custom-scheme
// prefix for mobile OAuth (see src/auth/userOAuth/service.ts on the server —
// isAllowedMobileRedirectUri). Matches app.json's "scheme": "qtask".
const MOBILE_REDIRECT_URI = 'qtask://oauth';

export class OAuthCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled');
  }
}

export async function signInWithOAuthProvider(providerId: string): Promise<LoginResult> {
  const baseUrl = await resolveBaseUrl();
  const authUrl = `${baseUrl}/api/auth/oauth/${providerId}?redirectUri=${encodeURIComponent(MOBILE_REDIRECT_URI)}`;

  const result = await WebBrowser.openAuthSessionAsync(authUrl, MOBILE_REDIRECT_URI);

  if (result.type !== 'success' || !result.url) {
    throw new OAuthCancelledError();
  }

  const returnedUrl = new URL(result.url);
  const error = returnedUrl.searchParams.get('error');
  if (error) throw new Error(error);

  const code = returnedUrl.searchParams.get('code');
  if (!code) throw new Error('Sign-in did not return a code');

  return exchangeOAuthCode(code);
}
