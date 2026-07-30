import { createHash, randomBytes } from 'node:crypto';
import {
  McpOAuthAuthorizationCodeModel,
  McpOAuthPendingConsentModel,
  McpOAuthRefreshTokenModel,
} from '../models/index.js';
import { config } from '../config/index.js';
import { getMcpCloudResourceUri, getMcpResourceUri } from '../config/urls.js';
import type { McpOAuthConsentDetails } from '../types/mcp.js';
import { HttpError } from '../utils/httpError.js';
import { signMcpOAuthAccessToken } from '../oauth/jwt.js';
import { verifyPkce } from '../oauth/pkce.js';
import {
  MCP_OAUTH_AUTH_CODE_TTL_MS,
  MCP_OAUTH_PENDING_TTL_MS,
  normalizeOAuthScopes,
  oauthScopeToMcpKeyScope,
  scopesToString,
  type McpOAuthScope,
} from '../oauth/constants.js';
import { mcpOAuthClientService, type ResolvedOAuthClient } from './mcpOAuthClientService.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isValidResource(resource: string | undefined): boolean {
  if (!resource) return false;
  const allowed = new Set([getMcpResourceUri(), getMcpCloudResourceUri()]);
  return allowed.has(resource);
}

function buildRedirectUrl(
  redirectUri: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export class McpOAuthService {
  async beginAuthorization(params: {
    responseType: string | undefined;
    clientId: string | undefined;
    redirectUri: string | undefined;
    scope: string | undefined;
    state: string | undefined;
    codeChallenge: string | undefined;
    codeChallengeMethod: string | undefined;
    resource: string | undefined;
  }): Promise<{ consentUrl: string; state: string }> {
    if (params.responseType !== 'code') {
      throw new HttpError(400, 'Unsupported response_type');
    }
    if (!params.clientId || !params.redirectUri || !params.codeChallenge) {
      throw new HttpError(400, 'Missing required OAuth parameters');
    }
    if (params.codeChallengeMethod && params.codeChallengeMethod !== 'S256') {
      throw new HttpError(400, 'Unsupported code_challenge_method');
    }
    if (!isValidResource(params.resource)) {
      throw new HttpError(400, 'Invalid resource parameter');
    }

    const client = await mcpOAuthClientService.resolveClient(params.clientId);
    if (!client) {
      throw new HttpError(400, 'Unknown OAuth client');
    }
    if (!mcpOAuthClientService.validateRedirectUri(client, params.redirectUri)) {
      throw new HttpError(400, 'Invalid redirect_uri');
    }

    const scopes = normalizeOAuthScopes(params.scope);
    const state = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + MCP_OAUTH_PENDING_TTL_MS);

    await McpOAuthPendingConsentModel.create({
      state,
      clientId: client.clientId,
      clientName: client.name,
      redirectUri: params.redirectUri,
      scope: scopesToString(scopes),
      stateParam: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod ?? 'S256',
      resource: params.resource!,
      expiresAt,
    });

    const consentPath = `/oauth/consent?state=${encodeURIComponent(state)}`;
    const consentUrl = `${config.corsOrigin}${consentPath}`;
    return { consentUrl, state };
  }

  async getConsentDetails(state: string): Promise<McpOAuthConsentDetails | null> {
    const pending = await McpOAuthPendingConsentModel.findOne({
      state,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!pending) return null;
    return {
      state: pending.state,
      clientName: pending.clientName,
      scopes: pending.scope.split(/\s+/).filter(Boolean),
      resource: pending.resource,
    };
  }

  async approveConsent(userId: string, state: string): Promise<string> {
    const pending = await McpOAuthPendingConsentModel.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!pending) {
      throw new HttpError(400, 'Consent request expired or not found');
    }

    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + MCP_OAUTH_AUTH_CODE_TTL_MS);

    await McpOAuthAuthorizationCodeModel.create({
      codeHash: hashValue(code),
      clientId: pending.clientId,
      userId,
      scope: pending.scope,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      expiresAt,
    });

    return buildRedirectUrl(pending.redirectUri, {
      code,
      state: pending.stateParam ?? undefined,
    });
  }

  async denyConsent(state: string): Promise<string> {
    const pending = await McpOAuthPendingConsentModel.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!pending) {
      throw new HttpError(400, 'Consent request expired or not found');
    }

    return buildRedirectUrl(pending.redirectUri, {
      error: 'access_denied',
      error_description: 'User denied access',
      state: pending.stateParam ?? undefined,
    });
  }

  async exchangeToken(params: {
    grantType: string | undefined;
    code?: string;
    redirectUri?: string;
    clientId?: string;
    clientSecret?: string;
    codeVerifier?: string;
    resource?: string;
    refreshToken?: string;
  }): Promise<{
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token?: string;
    scope: string;
  }> {
    if (params.grantType === 'authorization_code') {
      return this.exchangeAuthorizationCode(params);
    }
    if (params.grantType === 'refresh_token') {
      return this.exchangeRefreshToken(params);
    }
    throw new HttpError(400, 'Unsupported grant_type');
  }

  private async exchangeAuthorizationCode(params: {
    code?: string;
    redirectUri?: string;
    clientId?: string;
    clientSecret?: string;
    codeVerifier?: string;
    resource?: string;
  }) {
    if (!params.code || !params.redirectUri || !params.clientId || !params.codeVerifier) {
      throw new HttpError(400, 'Missing token request parameters');
    }
    if (!isValidResource(params.resource)) {
      throw new HttpError(400, 'Invalid resource parameter');
    }

    const client = await mcpOAuthClientService.resolveClient(params.clientId);
    if (!client) {
      throw new HttpError(401, 'Invalid client');
    }
    if (!mcpOAuthClientService.verifyClientSecret(client, params.clientSecret)) {
      throw new HttpError(401, 'Invalid client credentials');
    }

    const codeDoc = await McpOAuthAuthorizationCodeModel.findOneAndDelete({
      codeHash: hashValue(params.code),
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      resource: params.resource,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (!codeDoc) {
      throw new HttpError(400, 'Invalid authorization code');
    }

    if (
      !verifyPkce(params.codeVerifier, codeDoc.codeChallenge, codeDoc.codeChallengeMethod)
    ) {
      throw new HttpError(400, 'Invalid PKCE code_verifier');
    }

    return this.issueTokens(
      client,
      codeDoc.userId,
      codeDoc.scope,
      codeDoc.resource
    );
  }

  private async exchangeRefreshToken(params: {
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string;
  }) {
    if (!params.refreshToken || !params.clientId) {
      throw new HttpError(400, 'Missing refresh token parameters');
    }
    if (!isValidResource(params.resource)) {
      throw new HttpError(400, 'Invalid resource parameter');
    }

    const client = await mcpOAuthClientService.resolveClient(params.clientId);
    if (!client) {
      throw new HttpError(401, 'Invalid client');
    }
    if (!mcpOAuthClientService.verifyClientSecret(client, params.clientSecret)) {
      throw new HttpError(401, 'Invalid client credentials');
    }

    const refreshDoc = await McpOAuthRefreshTokenModel.findOneAndUpdate(
      {
        tokenHash: hashValue(params.refreshToken),
        clientId: params.clientId,
        resource: params.resource,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      { $set: { revokedAt: new Date() } },
      { new: false }
    ).lean();

    if (!refreshDoc) {
      throw new HttpError(400, 'Invalid refresh token');
    }

    return this.issueTokens(client, refreshDoc.userId, refreshDoc.scope, refreshDoc.resource, {
      skipRefreshRotation: false,
    });
  }

  private async issueTokens(
    client: ResolvedOAuthClient,
    userId: string,
    scope: string,
    resource: string,
    options?: { skipRefreshRotation?: boolean }
  ) {
    const scopes = normalizeOAuthScopes(scope);
    const accessToken = signMcpOAuthAccessToken({
      userId,
      scopes,
      clientId: client.clientId,
      resource,
    });

    let refreshToken: string | undefined;
    if (options?.skipRefreshRotation !== true) {
      refreshToken = randomBytes(32).toString('base64url');
      await McpOAuthRefreshTokenModel.create({
        tokenHash: hashValue(refreshToken),
        clientId: client.clientId,
        userId,
        scope: scopesToString(scopes),
        resource,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.mcpOAuth.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopesToString(scopes),
    };
  }

  mapAccessTokenScope(scope: string): 'read' | 'read_write' {
    return oauthScopeToMcpKeyScope(scope);
  }
}

export const mcpOAuthService = new McpOAuthService();
