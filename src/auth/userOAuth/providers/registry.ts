import { createOidcProviderAdapter } from './oidcAdapter.js';
import type { IdentityProviderId, OAuthProviderAdapter } from '../types.js';
import { getOAuthProviderConfig } from '../../../config/oauthProviders.js';

const adapters: Record<IdentityProviderId, OAuthProviderAdapter> = {
  google: createOidcProviderAdapter('google', 'Google'),
  microsoft: createOidcProviderAdapter('microsoft', 'Microsoft'),
};

export function getOAuthProviderAdapter(provider: IdentityProviderId): OAuthProviderAdapter | null {
  const cfg = getOAuthProviderConfig(provider);
  if (!cfg.enabled) return null;
  return adapters[provider];
}

export function listEnabledOAuthProviderAdapters(): OAuthProviderAdapter[] {
  return (Object.keys(adapters) as IdentityProviderId[])
    .map((id) => getOAuthProviderAdapter(id))
    .filter((adapter): adapter is OAuthProviderAdapter => adapter !== null);
}

export function getOAuthProviderPublicInfo(): Array<{ id: IdentityProviderId; label: string }> {
  return listEnabledOAuthProviderAdapters().map(({ id, label }) => ({ id, label }));
}
