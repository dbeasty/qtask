# QTask — Deployment Guide

How to run QTask locally, self-host on your own server, and (eventually) migrate to AWS.

---

## Table of Contents

1. [Local development](#1-local-development)
2. [Environment variables](#2-environment-variables)
3. [Authentication](#3-authentication)
4. [Production Docker stack](#4-production-docker-stack)
5. [Reverse proxy and HTTPS](#5-reverse-proxy-and-https)
6. [MCP in Cursor](#6-mcp-in-cursor)
7. [Backups and MongoDB hardening](#7-backups-and-mongodb-hardening)
8. [AWS stack](#8-aws-stack) *(planned)*

---

## 1. Local development

### Stack

| Component | Role | How it runs |
|-----------|------|-------------|
| **MongoDB** | Primary data store | Docker Compose |
| **Ollama** | Chat SLM + embedding model | Native install or Docker profile |
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

```bash
docker compose up -d
cp .env.example .env
# Edit .env — set JWT_SECRET to a long random string

npm install
npm install --prefix client
```

### Start the full local stack

```bash
npm run dev:all
```

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Health check | http://localhost:3000/health |
| Web client | http://localhost:5173 |

The Vite dev server proxies `/api` and `/health` to the API on port 3000.

On first visit, create an account via the web client's sign-in page.

---

## 2. Environment variables

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API listen port |
| `NODE_ENV` | `development` | Runtime environment |
| `MONGODB_URI` | `mongodb://localhost:27017/qtask` | MongoDB connection string |
| `JWT_SECRET` | *(dev fallback)* | **Required in production.** Signs auth tokens |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web client origin |
| `TRUST_PROXY` | `false` | Set `true` behind reverse proxy |
| `SERVE_CLIENT` | `true` | Serve `client/dist` from API in production |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `llama3.1` | Chat / tool-calling model |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `LOG_LEVEL` | `debug` | `debug` \| `info` \| `warn` \| `error` |
| `MCP_JWT` | — | JWT for MCP stdio server (see §6) |

For Docker production, also see [`.env.docker.example`](.env.docker.example).

---

## 3. Authentication

QTask uses email/password accounts with signed JWTs.

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/register` | `{ email, password, displayName? }` → `{ token, user }` |
| `POST /api/auth/login` | `{ email, password }` → `{ token, user }` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` → `{ user }` |

All `/api/tasks`, `/api/projects`, and `/api/chat` routes require a valid JWT.

Each user has isolated projects and tasks. Sharing between users is not yet implemented (PRD Phase 3).

---

## 4. Production Docker stack

Build and run the API with the embedded web client:

```bash
cp .env.docker.example .env
# Edit .env — set JWT_SECRET, MONGO_ROOT_PASSWORD, CORS_ORIGIN

docker compose --profile app --profile ollama up -d --build
```

For internet-facing deployment, also apply production overrides (hides MongoDB port, routes Ollama internally):

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --profile app \
  --profile ollama \
  up -d --build
```

| Service | Default port | Notes |
|---------|--------------|-------|
| API + web UI | 3000 | Serves API and static client |
| MongoDB | 27017 (dev only) | Not published in prod override |
| Ollama | 11434 | Optional `--profile ollama` |

### Manual production build (no Docker)

```bash
npm run build
npm run build --prefix client
NODE_ENV=production npm start
```

The API serves `client/dist/` when `NODE_ENV=production` and `SERVE_CLIENT=true`.

### Health check

```bash
curl http://localhost:3000/health
```

Returns MongoDB connectivity status. Returns `503` if the database is unreachable.

---

## 5. Reverse proxy and HTTPS

Do **not** expose the API or MongoDB directly to the internet. Put a reverse proxy in front of the API container.

Set these in your `.env` / Docker environment:

```
TRUST_PROXY=true
CORS_ORIGIN=https://qtask.yourdomain.com
```

### Caddy (recommended)

`Caddyfile`:

```caddy
qtask.yourdomain.com {
    reverse_proxy localhost:3000

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

Caddy obtains and renews Let's Encrypt certificates automatically.

```bash
caddy run --config Caddyfile
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name qtask.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/qtask.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qtask.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE (chat streaming)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name qtask.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

Obtain certificates with [certbot](https://certbot.eff.org/):

```bash
sudo certbot certonly --nginx -d qtask.yourdomain.com
```

### Firewall checklist

- Allow **443** (and **80** for ACME redirects) to your server
- Block **27017** (MongoDB) from the public internet
- Block **3000** from the public internet if the proxy handles TLS locally

---

## 6. MCP in Cursor

1. Ensure MongoDB is running.
2. Log in via the web client or `POST /api/auth/login`.
3. Copy the `token` from the response.
4. Copy `mcp-config.example.json` into your Cursor MCP settings.
5. Set `MCP_JWT` to your token and `JWT_SECRET` to match your server.

```json
{
  "mcpServers": {
    "qtask": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/qtask",
      "env": {
        "MONGODB_URI": "mongodb://localhost:27017/qtask",
        "JWT_SECRET": "your-jwt-secret",
        "MCP_JWT": "eyJ..."
      }
    }
  }
}
```

Tokens expire after `JWT_EXPIRES_IN` (default 7 days). Refresh by logging in again.

---

## 7. Backups and MongoDB hardening

### MongoDB authentication (production)

The Docker production stack enables MongoDB root auth via `MONGO_ROOT_USER` and `MONGO_ROOT_PASSWORD` in `.env.docker.example`. The API connects with:

```
mongodb://qtask:<password>@mongodb:27017/qtask?authSource=admin
```

Use `docker-compose.prod.yml` to avoid publishing MongoDB to the host network.

### Backup

With Docker Compose running:

```bash
# Create backup
docker compose exec mongodb mongodump \
  --uri="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@localhost:27017/qtask?authSource=admin" \
  --out=/data/backup/$(date +%Y%m%d)

# Copy backup off the container
docker compose cp mongodb:/data/backup ./backups
```

Without auth (local dev):

```bash
docker compose exec mongodb mongodump --db=qtask --out=/data/backup
docker compose cp mongodb:/data/backup ./backups
```

### Restore

```bash
docker compose cp ./backups/20260702 mongodb:/data/restore
docker compose exec mongodb mongorestore \
  --uri="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@localhost:27017/qtask?authSource=admin" \
  --drop /data/restore/qtask
```

### Recommended schedule

- Daily `mongodump` to a directory outside the container
- Copy backups to off-site storage (S3, another machine, etc.)
- Test restore quarterly

### Secrets hygiene

- Generate `JWT_SECRET` with at least 32 random bytes: `openssl rand -base64 32`
- Never commit `.env` files
- Rotate `JWT_SECRET` periodically (invalidates all sessions)
- Use strong `MONGO_ROOT_PASSWORD` in production

---

## 8. AWS stack

> **Status:** Not implemented yet. See [QTask_Product_Requirements.md](QTask_Product_Requirements.md) Delivery Phase 5.

For self-hosted deployment, use sections 4–7 above. AWS migration will be documented when ready.
