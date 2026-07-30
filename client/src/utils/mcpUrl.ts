import { SITE_URL } from '../constants/brand';

export interface McpPublicOAuthConfig {
  enabled: boolean;
  resource: string;
  issuer: string;
  scopes: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  protectedResourceMetadataUrl: string;
}

export interface McpPublicConfig {
  url: string;
  cloudUrl: string;
  authHeader: 'Authorization';
  authScheme: 'Bearer';
  isLocalhost: boolean;
  oauth?: McpPublicOAuthConfig;
}

export interface AuthConfigResponse {
  registrationEnabled: boolean;
  mcp?: McpPublicConfig;
}

export function fallbackMcpConfig(): McpPublicConfig {
  const isLocalhost = import.meta.env.DEV || window.location.hostname === 'localhost';
  const url = isLocalhost
    ? 'http://localhost:3000/api/mcp'
    : `${window.location.origin}/api/mcp`;
  return {
    url,
    cloudUrl: isLocalhost ? `${SITE_URL}/api/mcp` : url,
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    isLocalhost,
  };
}

export function formatBearerKey(secret: string): string {
  return `Bearer ${secret}`;
}

export function desktopBridgeConfig(mcpUrl: string, secret: string, repoCwd = '/path/to/qtask'): string {
  return JSON.stringify(
    {
      mcpServers: {
        qtask: {
          command: 'npm',
          args: ['run', 'mcp:bridge'],
          cwd: repoCwd,
          env: {
            QTASK_MCP_URL: mcpUrl,
            QTASK_MCP_KEY: secret,
          },
        },
      },
    },
    null,
    2
  );
}
