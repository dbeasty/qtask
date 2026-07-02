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
# Set JWT_SECRET in .env

npm install
npm install --prefix client
npm run dev:all
```

- API: http://localhost:3000
- Web client: http://localhost:5173

Create an account on first visit. See **[docs/DEPLOY.md](docs/DEPLOY.md)** for production self-hosting, HTTPS, backups, and MCP configuration.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Backend API only |
| `npm run dev:client` | React web client only |
| `npm run dev:all` | Backend + web client |
| `npm run mcp` | MCP stdio server (for Cursor) |
| `npm test` | Run integration tests |
| `npm run build` | Build API |
| `npm start` | Start production API (serves web client) |

## Authentication

Email/password accounts with JWT. All API routes except `/health` and `/api/auth/*` require `Authorization: Bearer <token>`.

## MCP in Cursor

Log in via the web client, copy your JWT, and set `MCP_JWT` in your Cursor MCP config. See `mcp-config.example.json`.
