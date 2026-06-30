# QTask

AI-native, MCP-powered task management.

## Prerequisites

- Node.js 20+
- Docker (for MongoDB)
- [Ollama](https://ollama.com/) with tool-capable models:

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

## Quick start

```bash
docker compose up -d
cp .env.example .env
npm install
npm install --prefix client
npm run dev:all
```

- API: http://localhost:3000
- Web client: http://localhost:5173

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for full local stack setup, environment variables, MCP configuration, and the planned AWS deployment path.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Backend API only |
| `npm run dev:client` | React web client only |
| `npm run dev:all` | Backend + web client |
| `npm run mcp` | MCP stdio server (for Cursor) |

## Chat / SLM

The web client uses `POST /api/chat` (SSE) with an Ollama agent loop. Set `OLLAMA_MODEL` to a tool-capable model (default: `llama3.1`).

Phase 1 auth is a stub: requests use `x-user-id: local-user` (or `DEFAULT_USER_ID` / `VITE_USER_ID`).

## MCP in Cursor

Copy `mcp-config.example.json` into your Cursor MCP settings and run MongoDB locally.
