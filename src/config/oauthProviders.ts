import type { IdentityProviderId } from '../auth/userOAuth/types.js';
import { config } from './index.js';

export interface OAuthProviderConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
  /** Microsoft Azure AD tenant; default `common` (any Microsoft account). */
  tenantId?: string;
}

function getApiPublicOrigin(): string {
  const explicit = process.env.API_PUBLIC_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  if (config.nodeEnv === 'production') {
    return new URL(config.appUrl).origin;
  }
  return `http://localhost:${config.port}`;
}

export function getOAuthCallbackUrl(provider: IdentityProviderId): string {
  return `${getApiPublicOrigin()}/api/auth/oauth/${provider}/callback`;
}

function resolveProviderConfig(
  provider: IdentityProviderId,
  envPrefix: string,
  enabledFlag: string | undefined
): OAuthProviderConfig {
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]?.trim() || undefined;
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]?.trim() || undefined;
  const explicitlyEnabled = enabledFlag === 'true';
  const enabled = explicitlyEnabled && Boolean(clientId && clientSecret);

  const base: OAuthProviderConfig = {
    enabled,
    clientId,
    clientSecret,
    callbackUrl: getOAuthCallbackUrl(provider),
  };

  if (provider === 'microsoft') {
    base.tenantId = process.env.OAUTH_MICROSOFT_TENANT_ID?.trim() || 'common';
  }

  return base;
}

export function getOAuthProviderConfigs(): Record<IdentityProviderId, OAuthProviderConfig> {
  return {
    google: resolveProviderConfig('google', 'OAUTH_GOOGLE', process.env.OAUTH_GOOGLE_ENABLED),
    microsoft: resolveProviderConfig('microsoft', 'OAUTH_MICROSOFT', process.env.OAUTH_MICROSOFT_ENABLED),
  };
}

export function getEnabledOAuthProviders(): IdentityProviderId[] {
  const configs = getOAuthProviderConfigs();
  return (Object.keys(configs) as IdentityProviderId[]).filter((id) => configs[id].enabled);
}

export function getOAuthProviderConfig(provider: IdentityProviderId): OAuthProviderConfig {
  return getOAuthProviderConfigs()[provider];
}
