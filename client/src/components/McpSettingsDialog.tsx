import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAuthConfig } from '../auth/storage';
import {
  createMcpKey,
  createMcpOAuthClient,
  listMcpKeys,
  listMcpOAuthClients,
  revokeMcpKey,
  revokeMcpOAuthClient,
  type McpApiKey,
  type McpKeyScope,
  type McpOAuthClient,
} from '../api/client';
import {
  desktopBridgeConfig,
  fallbackMcpConfig,
  formatBearerKey,
  type McpPublicConfig,
} from '../utils/mcpUrl';

type McpSettingsTab = 'claude' | 'bridge';

interface McpSettingsDialogProps {
  onClose: () => void;
}

export function McpSettingsDialog({ onClose }: McpSettingsDialogProps) {
  const [tab, setTab] = useState<McpSettingsTab>('claude');
  const [keys, setKeys] = useState<McpApiKey[]>([]);
  const [oauthClients, setOauthClients] = useState<McpOAuthClient[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpPublicConfig>(() => fallbackMcpConfig());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [oauthClientName, setOauthClientName] = useState('');
  const [scope, setScope] = useState<McpKeyScope>('read_write');
  const [creating, setCreating] = useState(false);
  const [creatingOAuthClient, setCreatingOAuthClient] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [newOAuthCredentials, setNewOAuthCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const activeSecret = newSecret;
  const oauthEnabled = Boolean(mcpConfig.oauth?.enabled);

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      const [keyResult, clientResult] = await Promise.all([
        listMcpKeys(),
        listMcpOAuthClients().catch(() => ({ clients: [] as McpOAuthClient[] })),
      ]);
      setKeys(keyResult.keys);
      setOauthClients(clientResult.clients);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load MCP settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void getAuthConfig().then((config) => {
      if (config.mcp) {
        setMcpConfig(config.mcp);
      }
    });
    void refreshAll();
  }, []);

  async function handleCreateKey() {
    if (!name.trim()) {
      setError('Key name is required');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await createMcpKey(name.trim(), scope);
      setNewSecret(result.secret);
      setName('');
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create key');
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateOAuthClient() {
    if (!oauthClientName.trim()) {
      setError('OAuth client name is required');
      return;
    }
    setCreatingOAuthClient(true);
    setError(null);
    try {
      const result = await createMcpOAuthClient(oauthClientName.trim());
      setNewOAuthCredentials({
        clientId: result.clientId,
        clientSecret: result.clientSecret,
      });
      setOauthClientName('');
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create OAuth client');
    } finally {
      setCreatingOAuthClient(false);
    }
  }

  async function handleRevokeKey(keyId: string) {
    setError(null);
    try {
      await revokeMcpKey(keyId);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke key');
    }
  }

  async function handleRevokeOAuthClient(clientId: string) {
    setError(null);
    try {
      await revokeMcpOAuthClient(clientId);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke OAuth client');
    }
  }

  async function copyText(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  const authHeaderValue = activeSecret ? formatBearerKey(activeSecret) : null;

  return createPortal(
    <div className="auth-dialog-backdrop" onClick={onClose}>
      <div
        className="auth-dialog auth-dialog-wide mcp-settings-dialog"
        role="dialog"
        aria-labelledby="mcp-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="mcp-settings-title">External AI (MCP)</h2>
        <p className="muted">
          Use the <strong>qtask-system</strong> prompt at session start. Write tools stage changes;
          confirm in chat, then call <code>approve_proposal</code>.
        </p>

        {error && <p className="auth-error">{error}</p>}

        <div className="mcp-settings-tabs" role="tablist" aria-label="MCP setup">
          <button
            type="button"
            role="tab"
            id="mcp-tab-claude"
            aria-selected={tab === 'claude'}
            aria-controls="mcp-panel-claude"
            className={`mcp-settings-tab${tab === 'claude' ? ' mcp-settings-tab-active' : ''}`}
            onClick={() => setTab('claude')}
          >
            Claude connector
          </button>
          <button
            type="button"
            role="tab"
            id="mcp-tab-bridge"
            aria-selected={tab === 'bridge'}
            aria-controls="mcp-panel-bridge"
            className={`mcp-settings-tab${tab === 'bridge' ? ' mcp-settings-tab-active' : ''}`}
            onClick={() => setTab('bridge')}
          >
            Cursor &amp; scripts
          </button>
        </div>

        {tab === 'claude' ? (
          <div
            id="mcp-panel-claude"
            role="tabpanel"
            aria-labelledby="mcp-tab-claude"
            className="mcp-settings-panel"
          >
            <p className="muted">
              For Claude web, the macOS Claude app, and mobile — remote MCP via OAuth.
            </p>

            <section className="mcp-settings-section">
              <h3>Connector URL</h3>
              <p>
                <code>{mcpConfig.cloudUrl}</code>
                <button
                  type="button"
                  className="secondary-button mcp-inline-copy"
                  onClick={() => void copyText('url', mcpConfig.cloudUrl)}
                >
                  {copied === 'url' ? 'Copied' : 'Copy URL'}
                </button>
              </p>
              {mcpConfig.isLocalhost ? (
                <p className="mcp-localhost-note">
                  Claude&apos;s remote MCP connector requires a public <strong>HTTPS</strong> URL. Use{' '}
                  <code>{mcpConfig.cloudUrl}</code> (not <code>http://localhost</code>).
                </p>
              ) : null}
            </section>

            <section className="mcp-settings-section">
              <h3>Setup</h3>
              <ol className="mcp-setup-steps">
                <li>
                  In Claude, open <strong>Settings → Connectors → Add custom connector</strong>.
                </li>
                <li>
                  Paste the connector URL above. In <strong>Advanced settings</strong>, leave OAuth
                  Client ID and Secret <strong>empty</strong> for normal use.
                </li>
                <li>
                  Click <strong>Add</strong> or <strong>Connect</strong>. Sign in to QTask in the
                  browser and click <strong>Allow access</strong>.
                </li>
                <li>Enable the connector per chat via <strong>+ → Connectors</strong>.</li>
                <li>
                  Use the MCP prompt <strong>qtask-system</strong> (or{' '}
                  <strong>qtask-system-with-project</strong>) at session start.
                </li>
              </ol>
            </section>

            {oauthEnabled ? (
              <section className="mcp-settings-section">
                <h3>Pre-registered OAuth client (optional)</h3>
                <p className="muted">
                  Only if your org requires static OAuth credentials in Claude Advanced settings.
                </p>
                <div className="mcp-settings-create">
                  <input
                    type="text"
                    value={oauthClientName}
                    placeholder="Client name (e.g. Claude org connector)"
                    onChange={(e) => setOauthClientName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={creatingOAuthClient}
                    onClick={() => void handleCreateOAuthClient()}
                  >
                    {creatingOAuthClient ? 'Creating…' : 'Create OAuth client'}
                  </button>
                </div>
                {newOAuthCredentials ? (
                  <div className="mcp-settings-secret">
                    <p className="muted">Copy these into Claude Advanced settings. Shown once.</p>
                    <p>
                      <strong>OAuth Client ID:</strong>{' '}
                      <code>{newOAuthCredentials.clientId}</code>
                    </p>
                    <p>
                      <strong>OAuth Client Secret:</strong>{' '}
                      <code>{newOAuthCredentials.clientSecret}</code>
                    </p>
                    <div className="mcp-settings-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void copyText('oauth-id', newOAuthCredentials.clientId)}
                      >
                        {copied === 'oauth-id' ? 'Copied' : 'Copy Client ID'}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void copyText('oauth-secret', newOAuthCredentials.clientSecret)
                        }
                      >
                        {copied === 'oauth-secret' ? 'Copied' : 'Copy Client Secret'}
                      </button>
                    </div>
                  </div>
                ) : null}
                {oauthClients.length > 0 ? (
                  <ul className="mcp-key-list">
                    {oauthClients.map((client) => (
                      <li key={client.id} className={client.revokedAt ? 'mcp-key-revoked' : undefined}>
                        <div>
                          <strong>{client.name}</strong>{' '}
                          <span className="muted">
                            {client.clientId.slice(0, 16)}…
                            {client.revokedAt ? ' · revoked' : ''}
                          </span>
                        </div>
                        {!client.revokedAt && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleRevokeOAuthClient(client.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : (
          <div
            id="mcp-panel-bridge"
            role="tabpanel"
            aria-labelledby="mcp-tab-bridge"
            className="mcp-settings-panel"
          >
            <p className="muted">
              For Cursor, automation, and local dev — not Claude&apos;s connector UI in chat.
            </p>

            <section className="mcp-settings-section">
              <h3>Bridge endpoint</h3>
              <p>
                <code>{mcpConfig.url}</code>
                <button
                  type="button"
                  className="secondary-button mcp-inline-copy"
                  onClick={() => void copyText('bridge-url', mcpConfig.url)}
                >
                  {copied === 'bridge-url' ? 'Copied' : 'Copy URL'}
                </button>
              </p>
              <p className="muted">
                Runs <code>npm run mcp:bridge</code> locally and forwards to this endpoint. Edit{' '}
                <code>cwd</code> in the copied config to your QTask checkout path.
              </p>
            </section>

            <section className="mcp-settings-section">
              <h3>Create API key</h3>
              <div className="mcp-settings-create">
                <input
                  type="text"
                  value={name}
                  placeholder="Key name (e.g. Cursor)"
                  onChange={(e) => setName(e.target.value)}
                />
                <select value={scope} onChange={(e) => setScope(e.target.value as McpKeyScope)}>
                  <option value="read_write">Read &amp; write</option>
                  <option value="read">Read only</option>
                </select>
                <button
                  type="button"
                  className="primary-button"
                  disabled={creating}
                  onClick={() => void handleCreateKey()}
                >
                  {creating ? 'Creating…' : 'Create key'}
                </button>
              </div>
            </section>

            {newSecret ? (
              <section className="mcp-settings-section mcp-settings-secret">
                <h3>Copy your new API key</h3>
                <p className="muted">
                  This secret is shown once. Store it securely and revoke if exposed.
                </p>
                <code className="mcp-secret-block">{newSecret}</code>
                <div className="mcp-settings-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void copyText('secret', newSecret)}
                  >
                    {copied === 'secret' ? 'Copied' : 'Copy key'}
                  </button>
                  {authHeaderValue ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void copyText('auth', authHeaderValue)}
                    >
                      {copied === 'auth' ? 'Copied' : 'Copy Authorization header'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      void copyText('desktop', desktopBridgeConfig(mcpConfig.url, newSecret))
                    }
                  >
                    {copied === 'desktop' ? 'Copied' : 'Copy bridge config'}
                  </button>
                </div>
              </section>
            ) : null}

            <section className="mcp-settings-section">
              <h3>Your API keys</h3>
              {loading ? (
                <p className="muted">Loading…</p>
              ) : keys.length === 0 ? (
                <p className="muted">No API keys yet.</p>
              ) : (
                <ul className="mcp-key-list">
                  {keys.map((key) => (
                    <li key={key.id} className={key.revokedAt ? 'mcp-key-revoked' : undefined}>
                      <div>
                        <strong>{key.name}</strong>{' '}
                        <span className="muted">
                          {key.prefix}… · {key.scope}
                          {key.revokedAt ? ' · revoked' : ''}
                        </span>
                      </div>
                      {!key.revokedAt && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void handleRevokeKey(key.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <div className="auth-dialog-footer">
          <button type="button" className="auth-submit" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
