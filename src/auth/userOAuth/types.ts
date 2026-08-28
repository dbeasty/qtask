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
  /** Mobile app callback URL (must pass isAllowedMobileRedirectUri) to hand the
   * auth code to instead of the web SPA's callback page. */
  mobileRedirectUri?: string;
  exp: number;
}

export function isIdentityProviderId(value: string): value is IdentityProviderId {
  return (IDENTITY_PROVIDER_IDS as readonly string[]).includes(value);
}

// Providers whose email_verified claim isn't a strong enough proof of mailbox
// ownership to silently merge into an existing account. Microsoft's shared
// "common" tenant endpoint can mark an email verified for guest/B2B and
// personal accounts without the same SMTP-ownership proof Google enforces,
// so linking to an existing account by matching email needs an explicit,
// password-confirmed step instead of an automatic merge.
const PROVIDERS_REQUIRING_LINK_CONFIRMATION = new Set<IdentityProviderId>(['microsoft']);

export function providerRequiresLinkConfirmation(provider: IdentityProviderId): boolean {
  return PROVIDERS_REQUIRING_LINK_CONFIRMATION.has(provider);
}
