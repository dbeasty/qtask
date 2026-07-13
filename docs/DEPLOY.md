# QTask — Deployment Guide

How to run QTask locally, self-host on your own server, and (eventually) migrate to AWS.

The official production deployment is at **https://qtask.dev**. Source code and contributions: [github.com/dbeasty/qtask](https://github.com/dbeasty/qtask).

---

## Table of Contents

1. [Local development](#1-local-development)
2. [Environment variables](#2-environment-variables)
3. [Authentication](#3-authentication)
4. [Production deployment](#4-production-deployment)
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

**Local development:** put secrets and machine-specific overrides in **`.env.local`** (copy from [`.env.local.example`](../.env.local.example)). The app loads `.env` first, then `.env.local` with override. Never commit `.env` or `.env.local`.

**Production (systemd / Docker):** put all runtime config — including `JWT_SECRET`, Resend keys, and domain URLs — in the server **`.env`** (e.g. `/opt/qtask/.env`). The systemd unit loads that file via `EnvironmentFile`. Do not rely on `.env.local` on the server; keep production secrets in `.env` only.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API listen port |
| `NODE_ENV` | `development` | Runtime environment |
| `MONGODB_URI` | `mongodb://localhost:27017/qtask` | MongoDB connection string |
| `JWT_SECRET` | *(dev fallback)* | **Required in production.** Signs auth tokens |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web client origin |
| `APP_URL` | `http://localhost:5173` | Public web URL for email links |
| `MAIL_RESEND` | `false` | Set `true` to send auth email via Resend HTTP API |
| `RESEND_API_KEY` | — | Resend API key (required when `MAIL_RESEND=true`) |
| `RESEND_FROM` | `noreply@qtask.dev` | From address for Resend (e.g. `QTask <notify@qtask.dev>`; use a verified domain) |
| `MAIL_SMTP` | `false` | Set `true` to send auth email via SMTP (nodemailer) |
| `SMTP_HOST` | — | SMTP host (required when `MAIL_SMTP=true`; also enables SMTP if set with neither flag) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS (`true` for port 465) |
| `SMTP_USER` | — | SMTP username (if required) |
| `SMTP_PASS` | — | SMTP password (if required) |
| `SMTP_FROM` | `noreply@qtask.dev` | From address for SMTP (also fallback for Resend if `RESEND_FROM` unset) |
| `REGISTRATION_ENABLED` | `true` | Set `false` to disable new account creation (capacity). Restart after changing. |
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

QTask uses email/password accounts with signed JWTs. New accounts must verify their email before signing in.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/register` | `{ email, password, displayName?, acceptLegal: true }` → `{ message }` (503 if registration disabled) |
| `GET /api/auth/config` | `{ registrationEnabled }` — public; used by the create-account page |
| `POST /api/auth/verify-email` | `{ token }` → `{ message }` |
| `POST /api/auth/resend-verification` | `{ email }` → `{ message }` |
| `POST /api/auth/login` | `{ email, password }` → `{ token, user }` (403 if email unverified) |
| `POST /api/auth/forgot-password` | `{ email }` → `{ message }` |
| `POST /api/auth/reset-password` | `{ token, password }` → `{ message }` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` → `{ user }` |
| `PATCH /api/auth/me` | `{ displayName? }` → `{ user }` (authenticated) |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` → `{ message }` (authenticated) |

### Email verification

1. User registers → receives a verification link at `/verify-email?token=...`
2. User clicks the link → email is marked verified
3. User signs in normally

In local development without mail configured, verification and reset links are logged to the API console instead of being emailed.

In production without a working mail provider, the app still starts but **registration is disabled**. The create-account page (`/register`) shows “Registration is not enabled currently.” Configure Resend or SMTP to enable new account sign-ups.

#### Resend (recommended)

1. Create an account at [resend.com](https://resend.com) and an API key.
2. Verify your sending domain (SPF/DKIM) in the Resend dashboard.
3. Set in the server `.env` (e.g. `/opt/qtask/.env`):

```bash
MAIL_RESEND=true
RESEND_API_KEY=re_xxxx
RESEND_FROM=QTask <notify@yourdomain.com>
APP_URL=https://qtask.dev
CORS_ORIGIN=https://qtask.dev
```

For local development, the same keys can live in `.env.local` instead.
4. Restart the service and confirm `/health` reports `checks.email: "ok"`.

#### SMTP (alternative)

Set `MAIL_SMTP=true` plus `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`. If both `MAIL_RESEND` and `MAIL_SMTP` are true, Resend is used. Existing deploys that only set `SMTP_HOST` (no flags) still use SMTP.

Operators can also set `REGISTRATION_ENABLED=false` to close signup for capacity even when mail works. Restart the service after changing the flag.

### Password reset

1. User clicks **Forgot password?** on the sign-in page
2. Receives a reset link at `/reset-password?token=...`
3. Sets a new password and signs in

All `/api/tasks`, `/api/projects`, and `/api/chat` routes require a valid JWT.

Each user has isolated projects and tasks. Sharing between users is not yet implemented (PRD Phase 3).

---

## 4. Production deployment

Production runs on **port 3003** (nginx or another reverse proxy forwards HTTPS to `127.0.0.1:3003`). Local development stays on port 3000.

### Network model

One Node process on **3003** serves both the React web UI (static JS/CSS) and the REST API (`/api/*`, `/health`). There is no separate React server in production.

| Layer | Port | Reachable from internet? |
|-------|------|--------------------------|
| nginx (HTTPS) | 443 (+ 80 for cert renewal) | Yes — only public entry |
| QTask (API + web UI) | 3003 on `127.0.0.1` | No — localhost only |
| MongoDB | Docker-internal or `127.0.0.1:27017` | No |
| Ollama (Jetson) | 11434 on LAN | No — LAN only |

Forward only **80** and **443** on your router. Do not forward 3003 or 27017.

**MCP in Cursor** runs locally on your machine via stdio — it does not need a server port opened for remote access. Use the web UI at `https://qtask.dev` for browser-based chat.

### 4.1 Docker (recommended)

For **internet-facing** deployment, always use the production compose override (binds API to localhost, hides MongoDB port):

```bash
cp .env.docker.example .env
# Edit .env — set JWT_SECRET, MONGO_ROOT_PASSWORD, CORS_ORIGIN, OLLAMA_BASE_URL

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --profile app \
  up -d --build
```

For local Docker testing without the prod override:

```bash
docker compose --profile app up -d --build
```

With the Docker `ollama` profile (instead of an external Jetson):

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --profile app \
  --profile ollama \
  up -d --build
```

When Ollama runs on a Jetson Nano (or another LAN host) instead of the Docker `ollama` profile, set in `.env`:

```
OLLAMA_BASE_URL=http://192.168.1.100:11434
```

**Deploy updates via git** on the server:

```bash
cd /opt/qtask
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

| Service | Default port | Notes |
|---------|--------------|-------|
| API + web UI | 3003 (`127.0.0.1` in prod) | Serves API and static client on one port |
| MongoDB | 27017 (dev only) | Not published in prod override |
| Ollama | 11434 | Optional `--profile ollama`, or external LAN host |

### 4.2 Release tar (bootstrap / offline)

Build a deployable archive on your dev machine:

```bash
npm run release
```

This auto-bumps the patch version (e.g. `0.1.0` → `0.1.1`), syncs `client/package.json`, and produces `release/qtask-<version>-linux.tar.gz` with compiled API, built client, and `deploy/` scripts. Commit the bumped `package.json` and lockfiles before deploying.

Copy to your Ubuntu server and install:

```bash
scp release/qtask-<version>-linux.tar.gz user@server:
ssh user@server
tar xzf qtask-<version>-linux.tar.gz
cd qtask-<version>
./deploy/install.sh          # installs to /opt/qtask by default
```

Then edit `/opt/qtask/.env`, start MongoDB, and enable the systemd service (the install script prints exact commands).

#### Updating a release install (systemd + MongoDB Docker)

Use this when the server was bootstrapped from a release tar (e.g. `/opt/qtask`) and is **not** a git checkout.

**On your dev machine** — build a new release:

```bash
npm run release
```

**On the server** — install over the existing deployment (`.env` is preserved):

```bash
# Copy the new archive (adjust version and host)
scp release/qtask-<version>-linux.tar.gz user@server:

ssh user@server
tar xzf qtask-<version>-linux.tar.gz
cd qtask-<version>
./deploy/install.sh              # rsyncs into /opt/qtask, keeps /opt/qtask/.env
sudo systemctl restart qtask
curl http://127.0.0.1:3003/health
```

MongoDB does not need to be restarted for app-only updates. The `install.sh` script runs `npm ci --omit=dev` and replaces `dist/`, `client/dist/`, and `deploy/`.

**Hotfix without a full release** (e.g. a single missing file): copy the fix into `/opt/qtask`, fix ownership, and restart:

```bash
sudo cp path/to/file /opt/qtask/dist/agent/context.md
sudo chown qtask:qtask /opt/qtask/dist/agent/context.md
sudo systemctl restart qtask
```

### 4.3 Bare-metal via git (updates)

After an initial **git clone** to `/opt/qtask` (or any git checkout), update in place:

```bash
cd /opt/qtask
./deploy/update-from-git.sh
```

This runs `git pull`, rebuilds API and client, reinstalls production dependencies, and restarts the `qtask` systemd service if it is running.

**Combo workflow:** use the release tar for first install, then either repeat the release-tar update steps above, or convert to a git checkout (`git clone` into `/opt/qtask` and copy `.env`) and use `update-from-git.sh` for day-to-day updates.

#### Updating a Docker Compose deployment

From the directory with `docker-compose.yml` and `.env`:

```bash
git pull   # if deployed from a clone
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
curl http://127.0.0.1:3003/health
```

### 4.4 MongoDB on the Ubuntu host

For standalone (non-Docker app) deployments, run MongoDB in Docker on the same server:

```bash
docker compose -f deploy/docker-compose.mongodb.yml up -d
```

The API connects via `MONGODB_URI=mongodb://localhost:27017/qtask` (see [`deploy/.env.production.example`](../deploy/.env.production.example)).

### 4.5 Manual production build (no Docker, no tar)

```bash
npm run build
npm run build --prefix client
NODE_ENV=production PORT=3003 npm start
```

The API serves `client/dist/` when `NODE_ENV=production` and `SERVE_CLIENT=true`.

### Health check

```bash
curl http://localhost:3003/health
```

Returns MongoDB connectivity status. Returns `503` if the database is unreachable.

### Validation tests (after install or update)

Run these on the server (or against your public URL via nginx) to confirm the deployment works end-to-end.

#### Automated smoke test

```bash
/opt/qtask/deploy/smoke-test.sh
# or from an extracted tarball before install:
./deploy/smoke-test.sh

# against your public URL (through nginx):
BASE_URL=https://qtask.dev /opt/qtask/deploy/smoke-test.sh

# use your real email to receive the verification message:
TEST_EMAIL=you@example.com /opt/qtask/deploy/smoke-test.sh
```

The script checks health, web UI, registration, and that login is blocked until email verification.

#### Manual validation (step by step)

**1. Health** — already covered above; expect `"mongodb":"ok"`.

**2. Web UI loads**

```bash
curl -sS http://127.0.0.1:3003/ | head -5
```

Expect `<!doctype html>` or `<html`. A JSON `{"error":"Not found"}` means the client build is missing or `SERVE_CLIENT` is disabled.

**3. Register a test account**

```bash
curl -sS -X POST http://127.0.0.1:3003/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-test-password","acceptLegal":true}'
```

Expect a JSON message about email verification. If registration is disabled (`GET /api/auth/config` returns `"registrationEnabled":false`), you will get `503` instead — configure mail (Resend or SMTP) and restart the service.

**4. Verify email**

- If mail is configured: open the link in your inbox.
- If mail is not configured: read the link from logs:

```bash
sudo journalctl -u qtask -n 50 --no-pager | grep -i verify
```

**5. Sign in via browser**

On the server directly:

```bash
# http://127.0.0.1:3003
```

From your laptop without a public URL, use an SSH tunnel:

```bash
ssh -L 3003:127.0.0.1:3003 user@server
# then open http://localhost:3003 in your browser
```

Or use your HTTPS domain once nginx is configured (see §5).

**6. Authenticated API**

After signing in, copy the JWT from the login response or browser devtools, then:

```bash
TOKEN="paste-your-jwt-here"

curl -sS http://127.0.0.1:3003/api/projects \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST http://127.0.0.1:3003/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test project"}'
```

Expect `200` / `201` with JSON project data. Then open the web UI and confirm you can create tasks and use chat.

#### Common failures

| Symptom | Likely cause |
|---------|----------------|
| Connection refused on 3003 | `qtask` systemd service not running — `sudo systemctl status qtask` |
| Crash loop in `journalctl` | Missing `dist/agent/context.md` or invalid `.env` (e.g. missing `JWT_SECRET` in production) |
| `503` on register | Registration disabled — mail not configured/failed verification, or `REGISTRATION_ENABLED=false` |
| Create account page shows disabled message | Mail unavailable or `REGISTRATION_ENABLED=false`; fix Resend/SMTP or set flag to `true` and restart |
| `403` on login before verify | Expected — complete email verification first |
| Browser 404 on `/` | Client not built or `SERVE_CLIENT=false` |
| Browser works on server but not externally | nginx not proxying to `127.0.0.1:3003` yet (see §5) |

---

## 5. Reverse proxy and HTTPS

Do **not** expose the API or MongoDB directly to the internet. Put a reverse proxy in front of the app on port 3003. Only **443** (and **80** for certificate renewal) should be reachable from outside your network.

Set these in your `.env` / Docker environment:

```
TRUST_PROXY=true
CORS_ORIGIN=https://qtask.dev
APP_URL=https://qtask.dev
```

Replace `qtask.dev` with your own domain if self-hosting elsewhere.

### nginx

If you already run nginx, use this — no Caddy required.

```nginx
server {
    listen 443 ssl http2;
    server_name qtask.dev;

    ssl_certificate     /etc/letsencrypt/live/qtask.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qtask.dev/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3003;
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
    server_name qtask.dev;
    return 301 https://$host$request_uri;
}
```

Replace `qtask.dev` with your own domain if self-hosting elsewhere.

Obtain certificates with [certbot](https://certbot.eff.org/):

```bash
sudo certbot certonly --nginx -d qtask.dev
```

### Caddy (alternative)

Skip this section if you already use nginx. Caddy is an alternative reverse proxy with automatic Let's Encrypt:

```caddy
qtask.dev {
    reverse_proxy localhost:3003

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

```bash
caddy run --config Caddyfile
```

### Firewall checklist

- Allow **443** (and **80** for ACME redirects) on your router and host firewall
- Do **not** forward **3003** or **27017** on your router — nginx reaches the app on localhost
- Block **27017** (MongoDB) from the public internet
- With `docker-compose.prod.yml`, the API binds to **127.0.0.1:3003** only

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
- Never commit `.env` or `.env.local` files
- Rotate `JWT_SECRET` periodically (invalidates all sessions)
- Use strong `MONGO_ROOT_PASSWORD` in production

---

## 8. AWS stack

> **Status:** Not implemented yet. See [QTask_Product_Requirements.md](QTask_Product_Requirements.md) Delivery Phase 5.

For self-hosted deployment, use sections 4–7 above. AWS migration will be documented when ready.
