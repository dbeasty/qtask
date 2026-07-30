export const MCP_OAUTH_SCOPES = ['mcp:read', 'mcp:read_write'] as const;
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export const MCP_OAUTH_ACCESS_TOKEN_TTL_SEC = 3600;
export const MCP_OAUTH_AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const MCP_OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;

export function oauthScopeToMcpKeyScope(scope: string): 'read' | 'read_write' {
  if (scope.includes('mcp:read_write')) return 'read_write';
  return 'read';
}

export function mcpKeyScopeToOAuthScope(scope: 'read' | 'read_write'): McpOAuthScope {
  return scope === 'read_write' ? 'mcp:read_write' : 'mcp:read';
}

export function normalizeOAuthScopes(scopeParam: string | undefined): McpOAuthScope[] {
  if (!scopeParam?.trim()) {
    return [...MCP_OAUTH_SCOPES];
  }
  const requested = scopeParam.split(/\s+/).filter(Boolean);
  const valid = requested.filter((s): s is McpOAuthScope =>
    (MCP_OAUTH_SCOPES as readonly string[]).includes(s)
  );
  return valid.length > 0 ? valid : [...MCP_OAUTH_SCOPES];
}

export function scopesToString(scopes: McpOAuthScope[]): string {
  return scopes.join(' ');
}
