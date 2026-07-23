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
8. [HashiCorp Vault (optional)](#8-hashicorp-vault-optional)
9. [AWS stack](#9-aws-stack) *(planned)*

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

**Production (systemd / Docker):** put runtime config in the server **`.env`** (e.g. `/opt/qtask/.env`). By default (`SECRETS_BACKEND=env`), secrets such as `JWT_SECRET` live in that file and systemd loads it via `EnvironmentFile`. Optionally set `SECRETS_BACKEND=vault` to load secrets from HashiCorp Vault instead (see [§8](#8-hashicorp-vault-optional)). Do not rely on `.env.local` on the server.

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRETS_BACKEND` | `env` | `env` = secrets from `.env`; `vault` = fetch from HashiCorp Vault |
| `VAULT_ADDR` | `http://127.0.0.1:8200` | Vault API address (vault mode) |
| `VAULT_SECRET_PATH` | `secret/data/qtask/production` | KV v2 API path (vault mode) |
| `VAULT_ROLE_ID` / `VAULT_SECRET_ID` | — | AppRole credentials (prefer systemd credentials over env) |
| `PORT` | `3000` | API listen port |
| `NODE_ENV` | `development` | Runtime environment |
| `MONGODB_URI` | `mongodb://localhost:27017/qtask` | MongoDB connection string |
| `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD` | — | Optional Mongo root auth for Compose / `start-mongodb.sh` |
| `MONGO_ENCRYPT_AT_REST` | `false` | `true` = LUKS-backed bind mount for Mongo data (see §7) |
| `MONGO_ENCRYPT_MOUNT` | `/var/lib/qtask/mongo-data` | Host mount path when encryption is enabled |
| `JWT_SECRET` | *(dev fallback)* | **Required in production** (from `.env` or Vault). Signs auth tokens |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web client origin |
| `APP_URL` | `http://localhost:5173` | Public web URL for email links |
| `MAIL_RESEND` | `false` | Set `true` to send auth email via Resend HTTP API |
| `RESEND_API_KEY` | — | Resend API key (required when `MAIL_RESEND=true`) |
| `RESEND_FROM` | `noreply@qtask.dev` | From address for Resend (e.g. `"QTask <notify@qtask.dev>"` — **quote** if the value contains spaces or `<>`; systemd and `start-mongodb.sh` source `.env` as shell) |
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
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL (Jetson LAN IP in production; see §4.1.1) |
| `OLLAMA_MODEL` | `llama3.1` | Chat / tool-calling model (`llama3.2:3b` recommended on Jetson 8GB) |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `OLLAMA_KEEP_ALIVE` | `-1` | Chat/generate keep-alive passed to Ollama (`-1` = keep chat loaded) |
| `OLLAMA_EMBEDDING_KEEP_ALIVE` | `0` | Embedding keep-alive (`0` = unload after request; on-demand indexing) |
| `OLLAMA_EMBEDDING_NUM_GPU` | `0` | GPU layers for embeddings (`0` = CPU; keeps chat on GPU) |
| `OLLAMA_DOCKER_STATS_URL` | — | Docker API base for admin CPU/RAM (e.g. Jetson `http://<ip>:2375/v1.44`) |
| `OLLAMA_DOCKER_CONTAINER` | `qtask-ollama` | Container name for Docker stats |
| `DCGM_METRICS_URL` | — | Discrete GPU metrics; leave unset for Jetson |
| `LOG_LEVEL` | `debug` | `debug` \| `info` \| `warn` \| `error` |
| `MCP_JWT` | — | JWT for MCP stdio server (see §6) |
| `ADMIN_HOST` | `127.0.0.1` | Admin app bind address (keep loopback) |
| `ADMIN_PORT` | `3004` | Admin app listen port |
| `ADMIN_AUTH_MODE` | `password` | `password` or `mtls` (see §5) |
| `ADMIN_PASSWORD` | — | **Required** when `ADMIN_AUTH_MODE=password` and `HASH_ADMIN_PASSWORD` is not `true` |
| `HASH_ADMIN_PASSWORD` | — | Set to `true` to verify login against `ADMIN_PASSWORD_HASH` instead of plaintext |
| `ADMIN_PASSWORD_HASH` | — | **Required** when `HASH_ADMIN_PASSWORD=true`; generate with `npm run hash-admin-password` |
| `ADMIN_JWT_SECRET` | — | **Required.** Separate from `JWT_SECRET` |
| `ADMIN_COOKIE_SECURE` | `true` | Set `true` behind HTTPS |
| `ADMIN_PROXY_SECRET` | — | Required for mTLS proxy mode |
| `ADMIN_DELETE_CONFIRM_EMAIL` | `false` | Require typing account email before admin delete |
| `LLM_METRICS_RETENTION_DAYS` | `30` | Days to keep detailed per-call LLM metrics |

For standalone/systemd production, copy [`deploy/.env.production.example`](../deploy/.env.production.example). For Docker production, also see [`.env.docker.example`](.env.docker.example). Admin setup details are in §5.

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

Each user has their own projects by default. Project owners can share a project with other existing accounts (roles: editor, executor, viewer). Email invites for users without an account are not yet implemented.

---

## 4. Production deployment

Production runs on **port 3003** (nginx or another reverse proxy forwards HTTPS to `127.0.0.1:3003`). Local development stays on port 3000.

### Network model

One Node process on **3003** serves both the React web UI (static JS/CSS) and the REST API (`/api/*`, `/health`). There is no separate React server in production.

| Layer | Port | Reachable from internet? |
|-------|------|--------------------------|
| nginx (HTTPS) | 443 (+ 80 for cert renewal) | Yes — only public entry |
| QTask (API + web UI) | 3003 on `127.0.0.1` | No — localhost only |
| QTask admin | 3004 on `127.0.0.1` | No — localhost only (restricted nginx hostname) |
| MongoDB | Docker-internal or `127.0.0.1:27017` | No |
| Ollama (Jetson) | 11434 on LAN | No — LAN only |
| Jetson docker-proxy (Compose) | 2375 on LAN | No — LAN only |

Forward only **80** and **443** on your router. Do not forward 3003, 3004, 27017, 11434, or 2375.

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

When Ollama runs on a Jetson (native or Compose), set `OLLAMA_BASE_URL` to the Jetson LAN IP. See [§4.1.1 Jetson Ollama](#411-jetson-ollama) for Docker install, native vs Compose paths, systemd, and monitoring.

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
| Ollama | 11434 | Optional `--profile ollama`, or Jetson LAN host |
| Jetson docker-proxy | 2375 | Compose Jetson only — LAN stats for admin; do not internet-forward |

#### 4.1.1 Jetson Ollama

Target board for these notes: **Jetson Orin Nano 8GB** (classic Jetson Nano is 4GB — use smaller models there). The Jetson runs **only** the SLM (Ollama). The **app server** runs API, admin, and MongoDB and calls the Jetson over a **service VLAN** (not the admin/access interface).

Typical layout:

| Host | Access / SSH | Service VLAN | Install path |
|------|--------------|--------------|--------------|
| **App server** | `qtask@192.168.13.13` (or your access IP) | `192.168.13.13` | `/opt/qtask` |
| **Jetson** | `qtask@192.168.1.14` | `192.168.13.14` | `/opt/qtask-ollama` |

| Interface | Example IP | Use |
|-----------|------------|-----|
| App service VLAN | `192.168.13.13` | QTask API, MongoDB, admin |
| Jetson access / SSH | `192.168.1.14` | SSH as **`qtask`** — do **not** expose Ollama here |
| Jetson service VLAN | `192.168.13.14` | `JETSON_BIND_ADDRESS`, `OLLAMA_BASE_URL` — QTask traffic only |

| Port on service VLAN | Purpose | Internet? |
|----------------------|---------|-----------|
| 11434 | Ollama API | No — service VLAN + firewall only |
| 2375 | docker-proxy (Compose path, CPU/RAM stats) | No — service VLAN + firewall only |

Do not port-forward 11434 or 2375 on your router. If the service subnet is partially exposed (e.g. via port 80 on another host), run containers under the dedicated **`qtask`** system user, bind ports to **`JETSON_BIND_ADDRESS`** only, and firewall to the app host.

##### Docker on an existing JetPack install

These steps assume Jetson Linux / JetPack is already installed (no OS flash). SSH to the Jetson as **`qtask`** (`qtask@192.168.1.14`). Docker is often preinstalled; if not:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
```

NVIDIA Container Toolkit (GPU — one-time, with sudo):

```bash
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --runtime nvidia nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
```

**Account model:** the Jetson Ollama stack runs entirely as **`qtask`**. Only `qtask` should be in the `docker` group:

```bash
groups qtask   # should include docker
```

If `qtask` does not exist yet, [`deploy/install-jetson-ollama.sh`](../deploy/install-jetson-ollama.sh) creates it (requires sudo once during install).

If GPU passthrough fails, edit [`deploy/docker-compose.jetson.yml`](../deploy/docker-compose.jetson.yml): remove `runtime: nvidia` and the `NVIDIA_*` environment variables, then restart the stack (CPU-only).

##### Path A — Native Ollama on Jetson

Install Ollama on the Jetson host (not in Docker), then pull models:

```bash
# Install from https://ollama.com (ARM64 / Jetson-compatible release)
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

Ensure Ollama listens on the **service VLAN** IP only (not `0.0.0.0` on all interfaces if avoidable). On the **app host** `.env`:

```bash
OLLAMA_BASE_URL=http://192.168.13.14:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_DOCKER_STATS_URL=
# DCGM_METRICS_URL=   # leave unset on Jetson
```

##### Path B — Compose Ollama on Jetson (recommended)

Install to `/opt/qtask-ollama` as system user **`qtask`**. Ports bind to `JETSON_BIND_ADDRESS` in `.env` (service VLAN only). Requires **Docker Compose** (`docker compose` plugin or `docker-compose`).

**First-time Jetson bootstrap** (once, before publish):

1. Create `qtask` with home `/opt/qtask-ollama`, shell `/bin/bash`, and `docker` group membership.
2. Grant `qtask` sudo for install/systemd (or run initial `install-jetson-ollama.sh` as root).
3. Add your SSH public key to `/opt/qtask-ollama/.ssh/authorized_keys`.
4. Install `docker-compose-v2` if `docker compose version` fails.

**One command from dev machine** (build → scp → install → start → pull models → systemd → health checks):

```bash
npm run publish:jetson
# or: JETSON_SSH=qtask@192.168.1.14 npm run publish:jetson
```

**What publish updates**

| Location | Updated by publish? |
|----------|---------------------|
| `/opt/qtask-ollama/deploy/*` | Yes |
| `/opt/qtask-ollama/.env` on Jetson | **No** if it already exists — only set `JETSON_BIND_ADDRESS` once (default in example: `192.168.13.14`) |
| App host `/opt/qtask/.env` on `192.168.13.13` | **No** — use `npm run publish:app`; edit secrets on first install |

On the **app host**, set (and **rebuild/restart QTask** after API changes — embedding queue and CPU embed settings ship with the app, not the Jetson tar):

```bash
OLLAMA_BASE_URL=http://192.168.13.14:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_KEEP_ALIVE=-1
OLLAMA_EMBEDDING_KEEP_ALIVE=0
OLLAMA_EMBEDDING_NUM_GPU=0
OLLAMA_DOCKER_STATS_URL=http://192.168.13.14:2375/v1.44
OLLAMA_DOCKER_CONTAINER=qtask-ollama
```

After deploy, verify chat stays loaded and embeddings are on demand:

```bash
# Jetson — only chat should remain after idle embed work
docker exec qtask-ollama ollama ps

# App — create/update a task; embedding should run immediately (no 2s poll wait)
```

Use **`v1.44`** for `OLLAMA_DOCKER_STATS_URL` (not `v1.41`) — current Docker daemons reject older API versions.

**On Jetson only** (from extracted release tar, as `qtask`):

```bash
tar xzf qtask-ollama-<version>-jetson.tar.gz
cd qtask-ollama-<version>
./deploy/deploy-jetson-ollama.sh
```

That script runs install → migrate legacy volumes/containers → start → model pulls → systemd → health checks.

Options: `--skip-models`, `--skip-systemd`, `--install-only`.

**From repo on Jetson** (as `qtask`):

```bash
cd /path/to/qtask
./deploy/deploy-jetson-ollama.sh
```

Redeploy without re-pulling models (on Jetson, after a new tar is extracted):

```bash
./deploy/deploy-jetson-ollama.sh --skip-models
```

`start-ollama-jetson.sh` removes legacy containers named `qtask-ollama` / `qtask-ollama-docker-proxy` (from older compose project names) and migrates model data from volume `deploy_qtask_ollama_data` to `qtask_ollama_data` when needed.

Compose sets `OLLAMA_KEEP_ALIVE=-1` and `OLLAMA_MAX_LOADED_MODELS=1` so only the **chat** model stays loaded on Jetson; `deploy-jetson-ollama.sh` warms chat only. Embeddings run on demand from the app with `OLLAMA_EMBEDDING_KEEP_ALIVE=0` and `OLLAMA_EMBEDDING_NUM_GPU=0` (CPU, unload after each request). Task indexing is **event-driven** (no 2s poll) — jobs run when tasks are created/updated.

**Firewall** (on Jetson — allow only app server `192.168.13.13`):

```bash
sudo ufw allow from 192.168.13.13 to 192.168.13.14 port 11434 proto tcp
sudo ufw allow from 192.168.13.13 to 192.168.13.14 port 2375 proto tcp
sudo ufw deny 11434/tcp
sudo ufw deny 2375/tcp
```

##### Health checks

```bash
# From app host — service VLAN
curl -s http://192.168.13.14:11434/api/tags
curl -s http://192.168.13.14:2375/v1.44/_ping   # expect: OK

# Should NOT answer on access VLAN if bind is correct:
curl -s --connect-timeout 2 http://192.168.1.14:11434/api/tags || echo "ok — not exposed on access VLAN"
```

In the admin UI, Ollama status should show the Jetson models. With Path B, container CPU/RAM resources should be available; the GPU (DCGM) panel stays unavailable on Jetson by design.

Day-to-day ops (as `qtask`):

```bash
sudo systemctl restart qtask-ollama.service
/opt/qtask-ollama/deploy/start-ollama-jetson.sh   # after .env changes
docker compose -p qtask-ollama -f /opt/qtask-ollama/deploy/docker-compose.jetson.yml --env-file /opt/qtask-ollama/.env logs -f
```

**Updates:** from dev machine run `npm run publish:jetson` again. To skip model pulls on Jetson, run `./deploy/deploy-jetson-ollama.sh --skip-models` manually instead.

**Troubleshooting:** `container name already in use` — old stack still running; `start-ollama-jetson.sh` removes it on the next deploy, or run `docker rm -f qtask-ollama qtask-ollama-docker-proxy` then redeploy.

See also [`deploy/.env.jetson.example`](../deploy/.env.jetson.example), [`deploy/deploy-jetson-ollama.sh`](../deploy/deploy-jetson-ollama.sh), and [`scripts/publish-jetson-release.sh`](../scripts/publish-jetson-release.sh).

#### 4.1.2 App server (QTask API + MongoDB)

The app server runs at **`/opt/qtask`** as system user **`qtask`**. Deploy from your dev machine over SSH (same account model as Jetson).

**Prerequisites on app server:** Docker, Docker Compose, Node.js 20+.

**First-time bootstrap** (once, as an admin user with sudo — e.g. `davja@192.168.13.13`):

```bash
# From release tar or repo
./deploy/bootstrap-app-server.sh

# Optional: passwordless systemd deploy for qtask (also done automatically by bootstrap-app-server.sh)
sudo cp deploy/qtask-deploy.sudoers.example /etc/sudoers.d/qtask-deploy
sudo chmod 440 /etc/sudoers.d/qtask-deploy
sudo visudo -cf /etc/sudoers.d/qtask-deploy

# Allow qtask SSH from dev machine
ssh-copy-id -i ~/.ssh/id_ed25519.pub qtask@192.168.13.13
```

**One command from dev machine** (bump version → build → scp → install → MongoDB → systemd → health checks):

```bash
npm run publish:app
# or: APP_SSH=qtask@192.168.13.13 npm run publish:app
```

Each `publish:app` auto-bumps the patch version in root, `client`, and `admin-client` `package.json` files (e.g. `0.1.1` → `0.1.2`). Commit the bumped `package.json` and lockfiles after publishing.

**What publish updates**

| Location | Updated by publish? |
|----------|---------------------|
| `/opt/qtask/dist`, client, admin-client, `deploy/*` | Yes |
| `/opt/qtask/.env` on app server | **No** if it already exists — edit secrets manually on first install |

On first publish, edit `/opt/qtask/.env` (JWT, admin passwords, domain, mail), then run `npm run publish:app` again.

**App server `.env`** (Jetson Ollama on service VLAN):

```bash
OLLAMA_BASE_URL=http://192.168.13.14:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_KEEP_ALIVE=-1
OLLAMA_EMBEDDING_KEEP_ALIVE=0
OLLAMA_EMBEDDING_NUM_GPU=0
OLLAMA_DOCKER_STATS_URL=http://192.168.13.14:2375/v1.44
OLLAMA_DOCKER_CONTAINER=qtask-ollama
```

**On app server only** (from extracted release tar, as `qtask`):

```bash
tar xzf qtask-<version>-linux.tar.gz
cd qtask-<version>
./deploy/deploy-app.sh
```

Options: `--install-only`, `--skip-mongodb`, `--skip-systemd`, `--force` (start with placeholder secrets — not recommended).

Day-to-day ops (as `qtask` on app server):

```bash
sudo systemctl restart qtask qtask-admin
/opt/qtask/deploy/start-mongodb.sh
curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3004/health
```

See also [`deploy/.env.production.example`](../deploy/.env.production.example), [`deploy/deploy-app.sh`](../deploy/deploy-app.sh), [`deploy/bootstrap-app-server.sh`](../deploy/bootstrap-app-server.sh), and [`scripts/publish-app-release.sh`](../scripts/publish-app-release.sh).

### 4.2 Release tar (bootstrap / offline)

Build a deployable archive on your dev machine:

```bash
npm run release
```

This auto-bumps the patch version across root, `client`, and `admin-client` (e.g. `0.1.0` → `0.1.1`) and produces `release/qtask-<version>-linux.tar.gz` with compiled API (including `dist/admin`), built client, built admin-client, and `deploy/` scripts. It also builds `release/qtask-ollama-<version>-jetson.tar.gz` for Jetson-only Ollama installs. Commit the bumped `package.json` and lockfiles before deploying.

Jetson-only tarball without rebuilding the app:

```bash
npm run release:jetson
```

Publish to Jetson (build + scp + deploy):

```bash
npm run publish:jetson
```

Publish to app server (bump patch version, build, scp, deploy):

```bash
npm run publish:app
```

App-only tarball at current version (no bump):

```bash
npm run release:app
```

Copy to your Ubuntu server and install manually:

```bash
scp release/qtask-<version>-linux.tar.gz qtask@192.168.13.13:
ssh qtask@192.168.13.13
tar xzf qtask-<version>-linux.tar.gz
cd qtask-<version>
./deploy/deploy-app.sh          # installs to /opt/qtask by default
```

Then follow the install script's next steps: edit `/opt/qtask/.env` (JWT, admin secrets, mail, domain, `OLLAMA_BASE_URL`), start MongoDB, and enable **both** systemd units:

```bash
sudo cp /opt/qtask/deploy/qtask.service /etc/systemd/system/
sudo cp /opt/qtask/deploy/qtask-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qtask
sudo systemctl enable --now qtask-admin
curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3004/health
```

See §5 for admin auth, reverse proxy, and firewall details.

#### Updating a release install (systemd + MongoDB Docker)

Use this when the server was bootstrapped from a release tar (e.g. `/opt/qtask`) and is **not** a git checkout.

**On your dev machine** — build a new release:

```bash
npm run release
```

**On the server** — install over the existing deployment (`.env` is preserved):

```bash
# Copy the new archive (adjust version and host)
scp release/qtask-<version>-linux.tar.gz qtask@192.168.13.13:

ssh qtask@192.168.13.13
tar xzf qtask-<version>-linux.tar.gz
cd qtask-<version>
./deploy/deploy-app.sh
sudo systemctl restart qtask
sudo systemctl restart qtask-admin
curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3004/health
```

MongoDB does not need to be restarted for app-only updates. The `install.sh` script runs `npm ci --omit=dev` and replaces `dist/` (including admin), `client/dist/`, `admin-client/dist/`, and `deploy/`.

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

This runs `git pull`, rebuilds API, client, and admin-client, reinstalls production dependencies, and restarts the `qtask` and `qtask-admin` systemd services if they are running.

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
# Preferred helper (respects SECRETS_BACKEND and MONGO_ENCRYPT_AT_REST):
./deploy/start-mongodb.sh

# Or plain Compose (named volume, env from shell / .env):
docker compose -f deploy/docker-compose.mongodb.yml up -d
```

Optional systemd oneshot: copy [`deploy/qtask-mongodb.service`](../deploy/qtask-mongodb.service) and `systemctl enable --now qtask-mongodb`.

The API connects via `MONGODB_URI` (see [`deploy/.env.production.example`](../deploy/.env.production.example)). With Mongo root auth enabled, use a URI such as `mongodb://qtask:<password>@127.0.0.1:27017/qtask?authSource=admin`.

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

Many installs use **Cloudflare Origin** certs on the origin (e.g. `/etc/nginx/ssl/qtask.pem`) while `qtask.dev` / `www` are **proxied** through Cloudflare (edge cert in the browser). A wildcard Origin cert (`*.qtask.dev`) covers `admin.qtask.dev` for TLS on nginx; browsers that hit the origin **directly** on the LAN do not trust the Origin CA unless you install [Cloudflare’s Origin CA root](https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem) on each device (Keychain + **Certificate Trust Settings** on macOS) or append that root to the pem nginx serves.

With Let’s Encrypt instead of Origin certs, reuse the same files for admin or expand the SAN:

```bash
sudo apt install -y certbot python3-certbot-nginx   # if needed
sudo certbot certonly --nginx --expand -d qtask.dev -d admin.qtask.dev
sudo certbot certificates   # confirm admin.qtask.dev appears in Domains
```

### Standalone admin application

The admin UI/API runs as a separate process on port `3004`. It can reset passwords,
delete accounts, report per-user/global MongoDB usage, and show Ollama call/resource
statistics. Never expose port `3004` directly; bind it to loopback and give it a
separate nginx hostname reachable only through your firewall or VPN.

**Systemd (release tar / bare-metal):** `deploy/install.sh` ships both unit files under
`/opt/qtask/deploy/`. After editing `/opt/qtask/.env` (admin secrets included), install
and enable the admin service:

```bash
sudo cp /opt/qtask/deploy/qtask-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qtask-admin
curl http://127.0.0.1:3004/health
```

`./deploy/update-from-git.sh` rebuilds `admin-client` and restarts `qtask-admin` when
the unit is already active.

Build and run it outside Docker without systemd:

```bash
npm run build:all
NODE_ENV=production npm run start:admin
```

With Compose, include the admin profile:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile app --profile admin --profile ollama up -d --build
```

Required configuration:

```dotenv
ADMIN_AUTH_MODE=password
ADMIN_PASSWORD=a-strong-dedicated-password
ADMIN_JWT_SECRET=a-different-long-random-secret
ADMIN_COOKIE_SECURE=true
LLM_METRICS_RETENTION_DAYS=30
```

By default, deleting a user from the admin console only needs a dialog
confirmation (plus CSRF). To also require typing the account email before
delete, set `ADMIN_DELETE_CONFIRM_EMAIL=true`.

The detailed per-call metric collection expires after the configured number of
days; compact daily totals remain. Prompts and responses are never stored.
Although deployment can set `ADMIN_PASSWORD` and `MONGO_ROOT_PASSWORD` to the
same value, separate secrets are strongly recommended because the web process
does not need the MongoDB root credential.

#### Admin password hash (optional)

By default the admin app stores `ADMIN_PASSWORD` in plaintext in `.env` or Vault.
To store a bcrypt hash instead (same login UX — you still type the real password
in the browser):

```bash
npm run hash-admin-password
# paste both output lines into /opt/qtask/.env:
#   ADMIN_PASSWORD_HASH=$2a$12$...
#   HASH_ADMIN_PASSWORD=true
# remove or comment out ADMIN_PASSWORD

sudo systemctl restart qtask-admin
```

Non-interactive:

```bash
printf '%s' 'your-strong-password' | npm run hash-admin-password -- --stdin
```

When `HASH_ADMIN_PASSWORD=true`, `ADMIN_PASSWORD` is ignored if still present.

#### Admin on internal IP only (recommended for home / LAN)

Keep **`https://qtask.dev`** on `listen 443` (all interfaces → `127.0.0.1:3003`). Serve admin on a **separate hostname** bound to the app server’s **LAN/service IP** (e.g. `192.168.13.13`) so `admin.qtask.dev` is only reachable on your LAN (UniFi local DNS → service IP). Do **not** publish a public DNS record for `admin` if you want it off the public internet.

**Port forward:** WAN `443` → **`192.168.13.13:443`** (nginx), not `:3003` or `:3004`.

**Critical nginx detail:** NAT sends public traffic to **`SERVICE_IP:443`**, not `127.0.0.1:443`. If only the admin vhost listens on `SERVICE_IP:443`, requests for `www.qtask.dev` hit that socket, fail to match `admin.qtask.dev`, and nginx’s **default** on that IP can proxy to **3004 (admin)**. Add a **duplicate main-site** block on the same IP (see [`deploy/nginx-qtask-service-ip.conf.example`](../deploy/nginx-qtask-service-ip.conf.example)) in addition to [`deploy/nginx-admin-internal.conf.example`](../deploy/nginx-admin-internal.conf.example).

Setup checklist:

1. Ensure the TLS cert covers `admin.qtask.dev` (wildcard `*.qtask.dev` on Origin certs is enough).
2. UniFi / Pi-hole **local DNS:** `admin.qtask.dev` → service IP (e.g. `192.168.13.13`). Leave `qtask.dev` / `www` on Cloudflare public DNS.
3. Enable admin systemd: `qtask-admin.service`; `curl http://127.0.0.1:3004/health`.
4. Copy nginx examples; set `listen` to your service IP and cert paths (`/etc/nginx/ssl/qtask.pem` or Let’s Encrypt paths).
5. Verify on the app server:

```bash
curl -sk --resolve www.qtask.dev:443:127.0.0.1 https://www.qtask.dev/health          # → service qtask
curl -sk --resolve www.qtask.dev:443:YOUR.WAN.IP https://www.qtask.dev/health        # → service qtask
curl -sk --resolve admin.qtask.dev:443:192.168.13.13 https://admin.qtask.dev/health  # → service qtask-admin
```

#### Access admin from your Mac (SSH tunnel — recommended with Cloudflare Origin certs)

Direct `https://admin.qtask.dev` on the LAN uses the **Origin cert** on nginx. Browsers often reject it (`ERR_CERT_AUTHORITY_INVALID`), and HSTS from the main site (`includeSubDomains` on `qtask.dev`) can block bypass. **SSH local port forwarding** avoids HTTPS and nginx for admin on the operator machine:

```bash
ssh -L 3004:127.0.0.1:3004 qtask@192.168.13.13
```

Leave that session open. On the same Mac, open **`http://localhost:3004`** and log in with your admin password (from `ADMIN_PASSWORD` or the password you used with `npm run hash-admin-password`).

Health check through the tunnel:

```bash
curl -s http://localhost:3004/health
```

Background tunnel (no shell):

```bash
ssh -f -N -L 3004:127.0.0.1:3004 qtask@192.168.13.13
```

If login succeeds but the session does not stick, production sets `ADMIN_COOKIE_SECURE=true` (cookies require HTTPS). For tunnel-only use, temporarily set `ADMIN_COOKIE_SECURE=false` in `/opt/qtask/.env`, run `sudo systemctl restart qtask-admin.service`, then set it back to `true` when you finish.

Optional: trust the [Origin CA root](https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem) on each operator Mac (Keychain **and** System Settings → Privacy & Security → **Certificate Trust Settings**), append the root to `qtask.pem` on the server for a full chain, or use a **separate Let’s Encrypt cert** on the admin nginx blocks only.

For password mode without mTLS, log in with your admin password (not your normal QTask user password). With hash mode enabled, use the password you chose when running `npm run hash-admin-password`.

#### Admin mTLS (optional)

To use a verified client certificate instead of a password, set `ADMIN_AUTH_MODE=mtls`, generate a long `ADMIN_PROXY_SECRET`, and configure nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name admin.qtask.dev;

    ssl_certificate     /etc/letsencrypt/live/admin.qtask.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.qtask.dev/privkey.pem;
    ssl_client_certificate /etc/nginx/qtask-admin-client-ca.pem;
    ssl_verify_client on;

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
        proxy_set_header X-SSL-Client-DN $ssl_client_s_dn;
        proxy_set_header X-Admin-Proxy-Secret "same-value-as-ADMIN_PROXY_SECRET";
    }
}
```

The proxy secret prevents a locally spoofed certificate-identity header. Keep
the admin listener on loopback even when mTLS is enabled.

Ollama API health, models, durations, tokens, failures, and embedding queue
statistics work for local and remote Ollama. For local Compose CPU/RAM metrics,
also enable the restricted socket proxy:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile app --profile admin --profile ollama --profile monitoring up -d
```

For NVIDIA utilization, VRAM, temperature, and power, additionally enable
`--profile gpu-monitoring` on a host with the NVIDIA container runtime (discrete
GPUs / DCGM). When Ollama runs on a remote Jetson, use
[`deploy/docker-compose.jetson.yml`](../deploy/docker-compose.jetson.yml) with
`JETSON_BIND_ADDRESS` on the service VLAN, then set on the app host:

```bash
OLLAMA_DOCKER_STATS_URL=http://192.168.13.14:2375/v1.44
OLLAMA_DOCKER_CONTAINER=qtask-ollama
# Leave DCGM_METRICS_URL unset — Jetson does not use DCGM
```

See [§4.1.1 Jetson Ollama](#411-jetson-ollama). Local Docker/GPU collectors on the
app host correctly show unavailable when Ollama is remote and those URLs are unset.

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
- Do **not** forward **3004**; only the restricted admin nginx hostname may reach it
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

Use `docker-compose.prod.yml` to avoid publishing MongoDB to the host network. For standalone Mongo, set the same vars in `/opt/qtask/.env` (or in Vault when `SECRETS_BACKEND=vault`) and start with `./deploy/start-mongodb.sh`.

### Encryption at rest (optional)

Community MongoDB does not encrypt data files itself. QTask can optionally place `/data/db` on a **LUKS-encrypted** host directory:

```bash
# As root — block device, or sparse file for labs:
sudo ./deploy/setup-mongo-encrypted-volume.sh /dev/sdX1
# sudo ./deploy/setup-mongo-encrypted-volume.sh --file /var/lib/qtask/mongo.luks 20G

# In /opt/qtask/.env:
MONGO_ENCRYPT_AT_REST=true
MONGO_ENCRYPT_MOUNT=/var/lib/qtask/mongo-data

./deploy/start-mongodb.sh
```

Default is `MONGO_ENCRYPT_AT_REST=false` (Docker named volume `qtask_mongo_data`). Persist the LUKS mapper across reboot with `crypttab` + `fstab`. Keep backups encrypted or off-host as well.

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
- Default: keep secrets in `.env` (`SECRETS_BACKEND=env`)
- Optional: move secrets to Vault (`SECRETS_BACKEND=vault`) and remove them from `.env` (see §8)

---

## 8. HashiCorp Vault (optional)

By default QTask reads secrets from the config file (`.env`). Set `SECRETS_BACKEND=vault` only when you want HashiCorp Vault to hold passwords and API keys.

### What stays in `.env` vs Vault

| In `.env` (non-secrets + flags) | In Vault KV (when enabled) |
|---------------------------------|----------------------------|
| `PORT`, URLs, `OLLAMA_*`, feature flags | `JWT_SECRET`, `ADMIN_*` secrets |
| `SECRETS_BACKEND=vault` | `RESEND_API_KEY`, `SMTP_PASS` / `SMTP_USER` |
| `VAULT_ADDR`, `VAULT_SECRET_PATH` | `MONGO_ROOT_*`, `MONGODB_URI` |

AppRole `role_id` / `secret_id` are **not** stored in `.env`. Use systemd credentials.

### Start Vault

```bash
docker compose -f deploy/docker-compose.vault.yml up -d
# Install vault CLI, then init/unseal once:
export VAULT_ADDR=http://127.0.0.1:8200
vault operator init    # save unseal keys + root token securely
vault operator unseal  # repeat with enough key shares
export VAULT_TOKEN=<root-token>
./deploy/vault/bootstrap.sh
```

After reboot you must unseal Vault again (unless you add auto-unseal later). Do not put unseal keys in `.env`.

### systemd credentials for AppRole

```bash
# From bootstrap.sh output:
echo -n "$ROLE_ID" | sudo systemd-creds encrypt - /etc/credstore/qtask-vault-role-id
echo -n "$SECRET_ID" | sudo systemd-creds encrypt - /etc/credstore/qtask-vault-secret-id
```

Uncomment `LoadCredential=` lines in:

- [`deploy/qtask.service`](../deploy/qtask.service)
- [`deploy/qtask-admin.service`](../deploy/qtask-admin.service)
- [`deploy/qtask-mongodb.service`](../deploy/qtask-mongodb.service) (if used)

Then in `/opt/qtask/.env`:

```bash
SECRETS_BACKEND=vault
VAULT_ADDR=http://127.0.0.1:8200
VAULT_SECRET_PATH=secret/data/qtask/production
```

Remove secret values from `.env`, reinstall units, and restart:

```bash
sudo cp /opt/qtask/deploy/qtask.service /etc/systemd/system/
sudo cp /opt/qtask/deploy/qtask-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart qtask qtask-admin
```

Rotate the AppRole secret-id periodically (`vault write -f auth/approle/role/qtask/secret-id`) and re-encrypt with `systemd-creds`.

---

## 9. AWS stack

> **Status:** Not implemented yet. See [QTask_Product_Requirements.md](QTask_Product_Requirements.md) Delivery Phase 5.

For self-hosted deployment, use sections 4–8 above. AWS migration will be documented when ready.
