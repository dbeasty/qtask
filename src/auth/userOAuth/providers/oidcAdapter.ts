import type { IDToken } from 'openid-client';
import * as client from 'openid-client';
import { getOAuthProviderConfig } from '../../../config/oauthProviders.js';
import type { IdentityProviderId, OAuthProfile, OAuthProviderAdapter } from '../types.js';

const SCOPES = ['openid', 'email', 'profile'];

const configCache = new Map<IdentityProviderId, Promise<client.Configuration>>();

function getIssuerUrl(provider: IdentityProviderId): URL {
  if (provider === 'google') {
    return new URL('https://accounts.google.com');
  }
  const cfg = getOAuthProviderConfig('microsoft');
  const tenant = cfg.tenantId ?? 'common';
  return new URL(`https://login.microsoftonline.com/${tenant}/v2.0`);
}

async function getOidcConfiguration(provider: IdentityProviderId): Promise<client.Configuration> {
  let pending = configCache.get(provider);
  if (!pending) {
    pending = (async () => {
      const cfg = getOAuthProviderConfig(provider);
      if (!cfg.clientId || !cfg.clientSecret) {
        throw new Error(`OAuth provider ${provider} is not configured`);
      }
      return client.discovery(
        getIssuerUrl(provider),
        cfg.clientId,
        cfg.clientSecret,
        client.ClientSecretPost(cfg.clientSecret)
      );
    })();
    configCache.set(provider, pending);
  }
  return pending;
}

export function clearOidcConfigurationCache(): void {
  configCache.clear();
}

function profileFromClaims(provider: IdentityProviderId, claims: IDToken | undefined): OAuthProfile {
  if (!claims?.sub) {
    throw new Error('OIDC ID token missing subject');
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) {
    throw new Error('OIDC ID token missing email');
  }
  const emailVerified =
    claims.email_verified === true ||
    claims.email_verified === 'true' ||
    (provider === 'google' && claims.email_verified !== false);

  let displayName: string | undefined;
  if (typeof claims.name === 'string' && claims.name.trim()) {
    displayName = claims.name.trim();
  } else if (typeof claims.given_name === 'string' && claims.given_name.trim()) {
    displayName = claims.given_name.trim();
  }

  return {
    provider,
    providerUserId: String(claims.sub),
    email,
    emailVerified,
    displayName,
  };
}

export function createOidcProviderAdapter(
  provider: IdentityProviderId,
  label: string
): OAuthProviderAdapter {
  return {
    id: provider,
    label,
    scopes: SCOPES,
    async getAuthorizationUrl(state, pkceCodeVerifier) {
      const oidcConfig = await getOidcConfiguration(provider);
      const cfg = getOAuthProviderConfig(provider);
      const codeChallenge = await client.calculatePKCECodeChallenge(pkceCodeVerifier);
      const redirectTo = client.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: cfg.callbackUrl,
        scope: SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return redirectTo.href;
    },
    async exchangeCode(callbackUrl, pkceCodeVerifier, expectedState) {
      const oidcConfig = await getOidcConfiguration(provider);
      const tokens = await client.authorizationCodeGrant(oidcConfig, callbackUrl, {
        pkceCodeVerifier,
        expectedState,
      });
      return profileFromClaims(provider, tokens.claims());
    },
  };
}
