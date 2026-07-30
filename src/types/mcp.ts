export type McpKeyScope = 'read' | 'read_write';

export interface McpApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scope: McpKeyScope;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface McpSessionSummary {
  id: string;
  activeProjectId?: string;
  pendingProposalCount: number;
  createdAt: string;
  updatedAt: string;
}

export type McpOAuthClientSource = 'registered' | 'dcr' | 'cimd';

export interface McpOAuthClientSummary {
  id: string;
  clientId: string;
  name: string;
  source: McpOAuthClientSource;
  createdAt: string;
  revokedAt?: string;
}

export interface McpOAuthConsentDetails {
  state: string;
  clientName: string;
  scopes: string[];
  resource: string;
}
