# QTask

Open-source task management with a built-in **MCP server** — connect Claude Desktop, Cursor, or any MCP client.

**Works with:** Claude Desktop · Cursor · Ollama (local agent)

Production: **https://qtask.dev** · [MCP setup guide](docs/MCP.md) · [User guide](docs/USER_GUIDE.md) · [Contribute on GitHub](https://github.com/dbeasty/qtask)

- **MCP server** — list, create, and update tasks and projects from Claude Desktop, Cursor, or other MCP clients
- **Staged writes** — external AI proposes changes; you approve before they apply
- **Semantic search** — find tasks by meaning, not just keywords
- **Self-hosted** — your data stays on your infrastructure, with swappable AI backends (Ollama, MCP-compatible models)

## Prerequisites

- Node.js 20+
- Docker (for MongoDB)
- [Ollama](https://ollama.com/) with tool-capable models:

```bash
ollama pull qwen3.5:2b
ollama pull nomic-embed-text
```

If upgrading an existing install, set `OLLAMA_MODEL=qwen3.5:2b` in `.env` and pull the model above.

## Quick start

```bash
docker compose up -d
cp .env.example .env
# Set JWT_SECRET in .env
# Optional: cp .env.local.example .env.local  # secrets / overrides (gitignored)

npm install
npm install --prefix client
npm run dev:all
```

- API: http://localhost:3000
- Web client: http://localhost:5173

Create an account on first visit. For local secrets (e.g. Resend API key), use **`.env.local`** — it overrides `.env` and is not committed. On the production server, put those values in **`.env`** instead (see **[docs/DEPLOY.md](docs/DEPLOY.md)**).

## Documentation

| Doc | Audience |
|-----|----------|
| [docs/MCP.md](docs/MCP.md) | External AI clients — **start here for Claude Desktop & Cursor** (API keys, OAuth, staging) |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | End users — projects, tasks, agent, sharing |
| [docs/QTask_Product_Requirements.md](docs/QTask_Product_Requirements.md) | Product specification |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Operators — local and production deployment |

In the web app, signed-in users can open **Help** from the account menu.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Backend API only |
| `npm run dev:client` | React web client only |
| `npm run dev:all` | Backend + web client |
| `npm run mcp` | MCP stdio server (local dev / Cursor) |
| `npm run mcp:bridge` | Stdio bridge to hosted `/api/mcp` |
| `npm test` | Run integration tests |
| `npm run build` | Build API |
| `npm start` | Start production API (serves web client) |

## Authentication

Email/password accounts with JWT. All API routes except `/health` and `/api/auth/*` require `Authorization: Bearer <token>`.

## MCP in Cursor

Log in via the web client, copy your JWT, and set `MCP_JWT` in your Cursor MCP config. See `mcp-config.example.json`.

For **hosted qtask.dev**, create an MCP API key in **Account menu → External AI (MCP)** and use `npm run mcp:bridge`. See [docs/MCP.md](docs/MCP.md).
