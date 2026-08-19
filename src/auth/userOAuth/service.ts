import { randomPKCECodeVerifier } from 'openid-client';
import { config } from '../../config/index.js';
import { HttpError } from '../../utils/httpError.js';
import { authService } from '../../services/authService.js';
import { createLogger } from '../../utils/logger.js';
import { issueUserOAuthAuthCode } from './exchange.js';
import { getOAuthProviderAdapter } from './providers/registry.js';
import { createOAuthState, verifyOAuthState } from './state.js';
import type { IdentityProviderId } from './types.js';
import { isIdentityProviderId } from './types.js';

const log = createLogger('userOAuth');

// Only the QTask mobile app's own custom URL scheme is allowed as an OAuth
// redirect target, to prevent this becoming an open redirect. Widen this if
// the mobile app ever ships under a different scheme/deep link.
const MOBILE_REDIRECT_SCHEME = 'qtask://';

export function isAllowedMobileRedirectUri(uri: string): boolean {
  return uri.startsWith(MOBILE_REDIRECT_SCHEME);
}

function buildSpaRedirectUrl(params: {
  code?: string;
  error?: string;
  returnTo?: string;
  mobileRedirectUri?: string;
}): string {
  const url = params.mobileRedirectUri
    ? new URL(params.mobileRedirectUri)
    : new URL('/auth/oauth/callback', config.appUrl);
  if (params.code) url.searchParams.set('code', params.code);
  if (params.error) url.searchParams.set('error', params.error);
  if (params.returnTo && !params.mobileRedirectUri) url.searchParams.set('returnTo', params.returnTo);
  return url.toString();
}

export class UserOAuthService {
  async beginAuthorization(input: {
    provider: string;
    returnTo?: string;
    inviteToken?: string;
    acceptLegal?: boolean;
    mobileRedirectUri?: string;
  }): Promise<string> {
    if (!isIdentityProviderId(input.provider)) {
      throw new HttpError(404, 'Unknown sign-in provider');
    }

    const adapter = getOAuthProviderAdapter(input.provider);
    if (!adapter) {
      throw new HttpError(404, 'Sign-in provider is not enabled');
    }

    if (input.mobileRedirectUri && !isAllowedMobileRedirectUri(input.mobileRedirectUri)) {
      throw new HttpError(400, 'Invalid mobile redirect URI');
    }

    const pkceCodeVerifier = randomPKCECodeVerifier();
    const state = createOAuthState({
      provider: input.provider,
      pkceCodeVerifier,
      returnTo: input.returnTo,
      inviteToken: input.inviteToken,
      acceptLegal: input.acceptLegal,
      mobileRedirectUri: input.mobileRedirectUri,
    });

    return adapter.getAuthorizationUrl(state, pkceCodeVerifier);
  }

  async handleCallback(providerParam: string, callbackUrl: URL): Promise<string> {
    if (!isIdentityProviderId(providerParam)) {
      throw new HttpError(400, 'Unknown sign-in provider');
    }

    const adapter = getOAuthProviderAdapter(providerParam);
    if (!adapter) {
      throw new HttpError(404, 'Sign-in provider is not enabled');
    }

    const oauthError = callbackUrl.searchParams.get('error');
    if (oauthError) {
      throw new HttpError(400, oauthError === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in failed');
    }

    const stateParam = callbackUrl.searchParams.get('state');
    if (!stateParam) {
      throw new HttpError(400, 'Invalid sign-in state');
    }

    const state = verifyOAuthState(stateParam);
    if (!state || state.provider !== providerParam) {
      throw new HttpError(400, 'Invalid or expired sign-in state');
    }

    const profile = await adapter.exchangeCode(callbackUrl, state.pkceCodeVerifier, stateParam);

    const session = await authService.loginWithOAuthProvider(profile, {
      acceptLegal: state.acceptLegal,
      inviteToken: state.inviteToken,
    });

    const code = await issueUserOAuthAuthCode(session.userId);
    log.info('OAuth sign-in succeeded', { provider: profile.provider, userId: session.userId });

    return buildSpaRedirectUrl({ code, returnTo: state.returnTo, mobileRedirectUri: state.mobileRedirectUri });
  }

  async exchangeAuthCode(code: string) {
    const { exchangeUserOAuthAuthCode } = await import('./exchange.js');
    const userId = await exchangeUserOAuthAuthCode(code);
    return authService.createSessionForUserId(userId);
  }

  buildErrorRedirect(message: string, returnTo?: string, mobileRedirectUri?: string): string {
    return buildSpaRedirectUrl({ error: message, returnTo, mobileRedirectUri });
  }
}

export const userOAuthService = new UserOAuthService();
