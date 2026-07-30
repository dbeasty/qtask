# MCP (Model Context Protocol)

Connect external AI clients (Claude web, macOS Claude app, Cursor, etc.) to your QTask account.

## Overview

- **Endpoint:** The MCP settings dialog shows the correct URL for your environment. In general:
  - **Local dev:** `http://localhost:3000/api/mcp` (API port, not the Vite web port)
  - **Production / Claude web:** `https://qtask.dev/api/mcp` (or your self-hosted origin + `/api/mcp`)
- **Claude connector auth:** OAuth 2.1 (sign in to QTask when connecting — no manual headers)
- **Bridge / scripts auth:** MCP API keys (`qtk_…`) from **Account menu → External AI (MCP)** → **Cursor & scripts** tab
- **Ports:** Uses the same HTTPS entry as the web app (443). No extra firewall ports.
- **Prompts:** Enable **`qtask-system`** (or **`qtask-system-with-project`**) at session start.
- **Writes:** Write tools **stage** changes. Confirm in the LLM chat, then call **`approve_proposal`** or **`reject_proposal`**.

Public config: `GET /api/auth/config` → `mcp.url`, `mcp.cloudUrl`, `mcp.oauth`.

## Claude connector (web, macOS app, mobile) — OAuth

Claude discovers QTask’s OAuth server automatically when you add the connector URL. This applies to **Claude web**, the **macOS Claude app**, and **mobile** — use **Settings → Connectors**, not the developer config file.

**Requirements:**

- URL must be **`https://…`** — Claude rejects `http://` URLs (including `http://localhost:3000`).
- In local dev, use **`https://qtask.dev/api/mcp`** for the cloud connector, not your local API URL.

**Steps:**

1. Claude **Settings → Connectors → Add custom connector**
2. **Name:** `qtask` (or any label)
3. **Remote MCP server URL:** `https://qtask.dev/api/mcp` (or your HTTPS origin + `/api/mcp`)
4. **Advanced settings — OAuth Client ID / OAuth Client Secret:** leave both **empty** for normal use. Claude registers via OAuth (CIMD/DCR).
5. Click **Add** → sign in to QTask in the browser → **Allow access**
6. Enable per chat via **+ → Connectors**
7. Use the **`qtask-system`** prompt at session start

### Optional: pre-registered OAuth client

If your org requires static credentials in Claude Advanced settings:

1. QTask **Account menu → External AI (MCP)** → **Create OAuth client**
2. Copy **OAuth Client ID** and **OAuth Client Secret** into Claude Advanced settings
3. Do **not** paste `qtk_` API keys into OAuth fields

## Cursor / scripts (stdio bridge)

For Cursor, automation, and local dev — **not** Claude’s in-chat connector UI (that uses OAuth above).

Desktop apps and scripts use API keys + the local bridge:

1. Create an API key in **Account menu → External AI (MCP)** → **Cursor & scripts** tab
2. Edit Cursor MCP config, or copy the snippet from MCP settings:

```json
{
  "mcpServers": {
    "qtask": {
      "command": "npm",
      "args": ["run", "mcp:bridge"],
      "cwd": "/path/to/qtask",
      "env": {
        "QTASK_MCP_URL": "https://qtask.dev/api/mcp",
        "QTASK_MCP_KEY": "qtk_your_key_here"
      }
    }
  }
}
```

Use `http://localhost:3000/api/mcp` for `QTASK_MCP_URL` when testing against a local API.

3. Restart the client that loads the config.
4. Use the **qtask-system** prompt.

The bridge (`scripts/mcp-bridge.ts`) proxies stdio MCP to the HTTP endpoint with your API key.

### Legacy: Claude Desktop developer config

If you use local stdio MCP via `claude_desktop_config.json` instead of the Connectors UI, use the bridge config above in **Settings → Developer → Edit Config**.

## Cursor / local self-host (direct stdio)

For a local QTask stack with MongoDB on your machine, use stdio MCP without HTTP:

```bash
npm run mcp
```

Set `MCP_JWT` to a JWT from login and `JWT_SECRET` / `MONGODB_URI` to match your server. See `mcp-config.example.json`.

## OAuth endpoints (same origin as API)

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-protected-resource/api/mcp` | MCP resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata |
| `GET /oauth/authorize` | Authorization code + PKCE |
| `POST /oauth/token` | Token exchange |
| `POST /oauth/register` | Dynamic client registration |

## Key scopes (API keys and OAuth)

| Scope | Can do |
|-------|--------|
| `read` / `mcp:read` | Search, list, get tasks/projects |
| `read_write` / `mcp:read_write` | Stage writes + approve/reject proposals |

## Write workflow (LLM as UI)

1. LLM calls a write tool (e.g. `create_task`).
2. Tool returns a **`proposalId`** and summary.
3. LLM asks you to confirm in chat.
4. On yes → `approve_proposal` · on no → `reject_proposal`.

## Security

- Revoke OAuth clients and API keys you no longer use.
- Rotate any credential exposed in chat or screenshots.
- Keys and secrets are hashed at rest.
- During deploy freezes (`READ_ONLY_MODE`), write and approve tools are blocked.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_OAUTH_ENABLED` | `true` | Enable OAuth for Claude web connectors |
| `MCP_OAUTH_JWT_SECRET` | dev fallback | Required in production; signs OAuth access tokens |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SEC` | `3600` | OAuth access token lifetime |

See also [DEPLOY.md](DEPLOY.md) §6 and the [user guide](USER_GUIDE.md).
