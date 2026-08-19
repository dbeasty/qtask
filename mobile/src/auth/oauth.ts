import type { LoginResult } from '@qtask/shared';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { exchangeOAuthCode, resolveBaseUrl } from '../api/client';

// Linking.createURL resolves to the right redirect for whatever environment
// this is actually running in: qtask://oauth in a standalone/dev-client
// build (app.json's "scheme": "qtask"), or Expo Go's own exp://host:port/--/
// oauth when running inside Expo Go during development. The backend only
// accepts the latter outside production (see isAllowedMobileRedirectUri in
// src/auth/userOAuth/service.ts) — a real production build always gets the
// qtask:// form, so this doesn't weaken anything in production.
const MOBILE_REDIRECT_URI = Linking.createURL('oauth');

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
