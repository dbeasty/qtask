import { config } from '../config/index.js';
import { getApiOrigin, getMcpCloudResourceUri, getMcpResourceUri } from '../config/urls.js';
import { MCP_OAUTH_SCOPES } from './constants.js';

export function getMcpOAuthIssuer(): string {
  return getApiOrigin();
}

export function getProtectedResourceMetadataPath(): string {
  return '/.well-known/oauth-protected-resource/api/mcp';
}

export function getProtectedResourceMetadataUrl(): string {
  return `${getApiOrigin()}${getProtectedResourceMetadataPath()}`;
}

export function buildProtectedResourceMetadata(resourceUri?: string) {
  const resource = resourceUri ?? getMcpResourceUri();
  return {
    resource,
    authorization_servers: [getMcpOAuthIssuer()],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function buildAuthorizationServerMetadata() {
  const issuer = getMcpOAuthIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
  };
}

export function buildMcpAuthChallengeHeader(): string {
  const metadataUrl = getProtectedResourceMetadataUrl();
  const scope = MCP_OAUTH_SCOPES.join(' ');
  return `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`;
}

export function getMcpPublicOAuthConfig() {
  return {
    enabled: config.mcpOAuth.enabled,
    resource: getMcpCloudResourceUri(),
    issuer: getMcpOAuthIssuer(),
    scopes: [...MCP_OAUTH_SCOPES],
    authorizationEndpoint: `${getMcpOAuthIssuer()}/oauth/authorize`,
    tokenEndpoint: `${getMcpOAuthIssuer()}/oauth/token`,
    protectedResourceMetadataUrl: getProtectedResourceMetadataUrl(),
  };
}
