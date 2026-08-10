export const IDENTITY_PROVIDER_IDS = ['google', 'microsoft'] as const;

export type IdentityProviderId = (typeof IDENTITY_PROVIDER_IDS)[number];

export interface OAuthProfile {
  provider: IdentityProviderId;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
}

export interface OAuthProviderPublicInfo {
  id: IdentityProviderId;
  label: string;
}

export interface OAuthProviderAdapter {
  id: IdentityProviderId;
  label: string;
  scopes: string[];
  getAuthorizationUrl(state: string, pkceCodeVerifier: string): Promise<string>;
  exchangeCode(callbackUrl: URL, pkceCodeVerifier: string, expectedState: string): Promise<OAuthProfile>;
}

export interface OAuthStatePayload {
  provider: IdentityProviderId;
  nonce: string;
  pkceCodeVerifier: string;
  returnTo?: string;
  inviteToken?: string;
  acceptLegal?: boolean;
  exp: number;
}

export function isIdentityProviderId(value: string): value is IdentityProviderId {
  return (IDENTITY_PROVIDER_IDS as readonly string[]).includes(value);
}
