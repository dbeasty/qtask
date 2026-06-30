# QTask — Deployment Guide

How to run QTask locally today, and (eventually) on AWS.

---

## Table of Contents

1. [Local stack](#1-local-stack)
2. [Environment variables](#2-environment-variables)
3. [Running services](#3-running-services)
4. [MCP in Cursor](#4-mcp-in-cursor)
5. [Production build (local)](#5-production-build-local)
6. [AWS stack](#6-aws-stack) *(planned)*

---

## 1. Local stack

The local development stack has four parts:

| Component | Role | How it runs |
|-----------|------|-------------|
| **MongoDB** | Primary data store | Docker Compose |
| **Ollama** | Chat SLM + embedding model | Native install (macOS / Linux / Windows) |
| **API** | Node.js backend + MCP server | `npm run dev` |
| **Web client** | React (Vite) dev server | `npm run dev:client` |

### Prerequisites

- **Node.js 20+**
- **Docker** (for MongoDB)
- **[Ollama](https://ollama.com/)** with tool-capable models:

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

### First-time setup

From the repository root:

```bash
# 1. Start MongoDB
docker compose up -d

# 2. Configure environment
cp .env.example .env

# 3. Install dependencies (root + web client)
npm install
npm install --prefix client
```

### Start the full local stack

```bash
npm run dev:all
```

This runs the API and web client together via `concurrently`.

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Health check | http://localhost:3000/health |
| Web client | http://localhost:5173 |

The Vite dev server proxies `/api` and `/health` to the API on port 3000.

### Start services individually

```bash
# API only
npm run dev

# Web client only (API must already be running)
npm run dev:client
```

### Stop the local stack

- **API + web client:** `Ctrl+C` in the terminal running `npm run dev:all`
- **MongoDB:** `docker compose down` (add `-v` to remove the data volume)

---

## 2. Environment variables

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API listen port |
| `NODE_ENV` | `development` | Runtime environment |
| `MONGODB_URI` | `mongodb://localhost:27017/qtask` | MongoDB connection string |
| `DEFAULT_USER_ID` | `local-user` | Stub user ID until auth lands (Phase 1) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `llama3.1` | Chat / tool-calling model |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model for semantic search |
| `LOG_LEVEL` | `debug` | `debug` \| `info` \| `warn` \| `error` |

**Web client (optional):**

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_USER_ID` | `local-user` | Sent as `x-user-id` on API requests |

Phase 1 has no real authentication. The API trusts the `x-user-id` header; the web client sets it from `VITE_USER_ID`.

---

## 3. Running services

### Verify MongoDB

```bash
docker compose ps
```

MongoDB should be listening on `localhost:27017`.

### Verify Ollama

```bash
ollama list
curl http://localhost:11434/api/tags
```

Ensure `llama3.1` and `nomic-embed-text` are available.

### Verify the API

```bash
curl http://localhost:3000/health
```

### Chat / SLM

The web client uses `POST /api/chat` (SSE) with an Ollama agent loop. Ollama must be running and reachable at `OLLAMA_BASE_URL`.

---

## 4. MCP in Cursor

QTask exposes an MCP server for tool use from Cursor (and other MCP clients).

1. Ensure MongoDB is running (`docker compose up -d`).
2. Copy `mcp-config.example.json` into your Cursor MCP settings.
3. Update the `cwd` path to your local clone of this repo.
4. The server starts via `npm run mcp` (stdio transport).

You can also run the MCP server manually:

```bash
npm run mcp
```

---

## 5. Production build (local)

To build and run the API and a static web client locally (no Vite dev server):

```bash
# Build API
npm run build

# Build web client
npm run build --prefix client

# Start API (serves from dist/)
npm start
```

The built client lives in `client/dist/`. Serving it in production requires a static file host or reverse proxy in front of the API — not yet wired into this repo. Use the Vite dev setup for day-to-day development.

---

## 6. AWS stack

> **Status:** Not implemented yet. This section will be filled in during [Delivery Phase 5](QTask_Product_Requirements.md#5-delivery-phases) (AWS migration).

Planned target architecture (from the product requirements):

| Concern | Local (today) | AWS (planned) |
|---------|---------------|---------------|
| Database | MongoDB in Docker | MongoDB Atlas |
| Compute | Node.js on localhost | Containerized deployment (e.g. ECS / App Runner) |
| Object storage | — | S3 |
| Vector search | Local cosine similarity | MongoDB Atlas Vector Search |
| AI / embeddings | Ollama on host | TBD (managed model endpoint or self-hosted) |

When AWS deployment is ready, this section will cover:

- Infrastructure layout and IaC (if any)
- Required secrets and environment configuration
- Build and deploy steps for API + web client
- Atlas connection and vector index setup
- Health checks and rollback

Until then, use the [local stack](#1-local-stack) above.
