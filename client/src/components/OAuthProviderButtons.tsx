import { useState } from 'react';
import { getPendingInviteToken } from '../utils/inviteToken';
import { getReturnToPath } from '../auth/session';

export interface OAuthProviderOption {
  id: string;
  label: string;
}

interface OAuthProviderButtonsProps {
  providers: OAuthProviderOption[];
  registrationEnabled: boolean;
  requireLegalAcceptance?: boolean;
  legalAccepted?: boolean;
  disabled?: boolean;
}

function buildOAuthStartUrl(
  providerId: string,
  options: { acceptLegal?: boolean; returnTo?: string | null; inviteToken?: string | null }
): string {
  const params = new URLSearchParams();
  if (options.acceptLegal) params.set('acceptLegal', 'true');
  if (options.returnTo) params.set('returnTo', options.returnTo);
  if (options.inviteToken) params.set('inviteToken', options.inviteToken);
  const query = params.toString();
  return `/api/auth/oauth/${providerId}${query ? `?${query}` : ''}`;
}

export function OAuthProviderButtons({
  providers,
  registrationEnabled,
  requireLegalAcceptance = false,
  legalAccepted = false,
  disabled = false,
}: OAuthProviderButtonsProps) {
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  if (providers.length === 0) return null;

  const needsLegal = requireLegalAcceptance && registrationEnabled && !legalAccepted;

  function startOAuth(provider: OAuthProviderOption) {
    if (disabled || busyProvider || needsLegal) return;
    setBusyProvider(provider.id);
    const returnTo = getReturnToPath();
    const inviteToken = getPendingInviteToken();
    window.location.href = buildOAuthStartUrl(provider.id, {
      acceptLegal: registrationEnabled ? true : undefined,
      returnTo,
      inviteToken,
    });
  }

  return (
    <div className="oauth-provider-buttons">
      <div className="oauth-provider-divider" role="separator">
        <span>or</span>
      </div>
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={`oauth-provider-button oauth-provider-button--${provider.id}`}
          onClick={() => startOAuth(provider)}
          disabled={disabled || Boolean(busyProvider) || needsLegal}
        >
          {busyProvider === provider.id ? 'Redirecting…' : `Continue with ${provider.label}`}
        </button>
      ))}
    </div>
  );
}
