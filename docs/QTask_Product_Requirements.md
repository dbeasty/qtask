# QTask — Product Requirements Document

*AI-native, MCP-powered, open-source task management*

Version 0.3 — Draft
Phase: Backend-first, self-hosted (on-prem GPU box), web clients shipped; mobile not started

*0.3: reconciled against current codebase (v0.1.58) — hybrid semantic search, role-based collaboration + email invites, and an admin console are live; social sign-in covers Google/Microsoft only (no Apple, no external task sync yet); deployment is self-hosted (Jetson/on-prem), not AWS.*

*0.2: nested projects, progress rollup, and Projects UI shipped in the web client.*

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Users & Use Cases](#2-users--use-cases)
3. [Core Feature Requirements](#3-core-feature-requirements)
4. [Technical Architecture](#4-technical-architecture)
5. [Delivery Phases](#5-delivery-phases)
6. [Open Questions](#6-open-questions)

---

## 1. Product Overview

QTask is an open-source, AI-native task management application. Unlike conventional todo apps where AI is a bolt-on feature, QTask is designed so that a language model sits in the critical path of core operations — creating, organizing, linking, and summarizing tasks — via the Model Context Protocol (MCP). This makes the AI layer swappable: users can run a small local language model (SLM) for privacy and speed, or connect Claude (or any MCP-compatible model) for heavier reasoning.

The product started as a backend-first build and is currently deployed self-hosted on an on-prem GPU box (NVIDIA Jetson) rather than AWS — see 4.5. Clients today are two React web apps (user-facing and admin); React Native (iOS and Android) is a planned future client, not yet started (see 5, item 4).

### 1.1 Goals

- Make AI a first-class, central capability — not a sidebar feature.
- Support solo use from day one, with collaboration as a core (not bolted-on) capability.
- Be open source, self-hostable, and cloud-portable (local → AWS).
- Allow tasks to sync to a user's existing cloud account (Google, Microsoft, or Apple) when signed in, in addition to QTask's own backend.
- Support sharing and collaboration across users regardless of which identity provider they use — including plain email invites for people without any linked account.

### 1.2 Non-Goals (initial phase)

- Enterprise SSO / SCIM provisioning — deferred to a later phase.
- Native desktop apps (Electron, etc.) — web app covers desktop initially.
- Billing / monetization — this is an open-source project; hosting and pricing concerns are out of scope for v1.

---

## 2. Users & Use Cases

### 2.1 Primary Persona (Phase 1)

Solo user (the project author) managing personal and project tasks, using AI to break down goals into tasks and subtasks, and tracking completion percentage across nested work.

### 2.2 Secondary Persona (Phase 2+)

Small collaborative teams (2–10 people) sharing projects or individual tasks, where members may use different identity providers (Google, Microsoft, Apple, or plain email) and need a consistent way to see who is working on what.

---

## 3. Core Feature Requirements

### 3.1 Task Management

- Create, read, update, delete tasks with title, description, status, priority, due date, and tags.
- Subtasks: tasks can contain an arbitrary number of nested subtasks (at least 2 levels deep).
- Percent complete: calculated automatically from subtask completion ratio, or set manually for leaf tasks with no subtasks. User can override the calculated value.
- Task linking: tasks can reference other tasks as related, blocking, or blocked-by — not just parent/child subtask relationships.
- Activity log per task: status changes, comments, assignment changes, and AI actions are all recorded.
- Comments: threaded comments on any task, visible to all collaborators with access.
- Attachments: files can be attached to a task and stored in the configured storage backend (see 3.5).
- Tasks may belong to one or more projects; users can move, share (link), unlink, or duplicate a task across projects.

### 3.2 Project Hierarchy

Projects form an optional tree (not only a flat list of workspaces). Nested projects are available in the web client.

- Nesting: each project may have an optional `parentId`. Users can create root projects or child projects under an existing parent.
- Move / reparent: a project can be moved under another parent (or to root). Cycles are rejected (a project cannot become a descendant of itself).
- Delete: deleting a project reparents its direct children to the deleted project’s former parent (or to root). Tasks that belong only to the deleted project are removed; tasks also linked to other projects are unlinked from the deleted project only.
- Progress and status rollup:
  - Leaf projects (no child projects): percent complete is derived from linked tasks (equal-weight average); status is derived from task statuses.
  - Parent projects: percent complete is a weighted rollup of child projects using optional per-child `progressShare` (same weighting model as task subtasks); status is derived from children.
- Active project: the web UI maintains an active project that scopes Agent and Tasks views; the picker is hierarchy-aware.
- Access control remains per project (collaborator list and roles). Nesting does not replace or inherit ACL across the tree automatically.

### 3.3 AI / LLM Integration (Central, not bolt-on)

The AI layer is implemented as an MCP server exposed by the QTask backend. Any MCP-compatible client can connect — a local small language model (SLM) via Ollama, or Claude via the Anthropic API. The choice of model is a user/deployment setting, not a hardcoded dependency.

#### 3.3.1 MCP Tools Exposed by the Backend

- `create_task` — create a task, optionally generating subtasks from a natural-language goal.
- `update_task` — update fields such as status, priority, due date, percent complete.
- `find_tasks` — hybrid semantic + structured search (see 3.4).
- `get_task` — fetch a single task with its subtasks, links, and comments.
- `get_workload` — list tasks for a given user, with status and percent complete.
- `assign_task` / `share_task` — assign or share a task or project with a collaborator.
- `summarize_project` — generate a natural-language status digest for a project.

#### 3.3.2 Conversational Interface

- Users can interact with QTask via natural language ("finish the login page by Friday, block it on the design review") and have the AI translate this into the appropriate tool calls.
- Per-user conversation history is stored so the AI retains context across a session without the user repeating themselves.
- Responses stream incrementally to the client for responsiveness.

#### 3.3.3 Model Flexibility

- Local SLM (e.g. via Ollama: Phi-3, Mistral, Llama) for default, privacy-preserving operation.
- Claude (Anthropic API) as an optional, swappable, more capable model for complex reasoning or summarization.
- Architecture must not assume a single hardcoded model — the MCP boundary keeps this swappable by design.

### 3.4 Intelligent Task Retrieval — **Implemented**

The AI must be able to locate relevant existing tasks (not just create new ones), including open/incomplete tasks, by querying the database intelligently rather than guessing.

- Structured query: exact filters such as status, assignee, due date range, priority, project.
- Semantic search: vector embeddings over task title, description, and comments, enabling natural-language queries like "what's blocking the launch?" or "anything related to last week's API work?".
- Hybrid retrieval: results from structured and semantic search are merged and re-ranked before being returned to the model (`src/services/searchService.ts`).
- Indexing pipeline: on task create/update, an embedding job is queued asynchronously (`src/services/embeddingQueue.ts`) and generates a vector by calling Ollama's `/api/embeddings` endpoint directly (`src/services/embeddingService.ts`), stored back on the task document.
- Vector storage: local cosine-similarity search against stored embeddings, running against the self-hosted Ollama instance (see 4.5). MongoDB Atlas Vector Search remains a future option if/when the deployment moves to a cloud host, but is not in use today.

### 3.5 Social Sign-In (Google / Microsoft) — **partially implemented**; Cloud Account Sync — **not started**

**Current state:** Google and Microsoft sign-in are implemented via OIDC (`src/config/oauthProviders.ts`, `src/auth/userOAuth/providers/registry.ts`), used purely for authentication/identity plus email/password (bcrypt + JWT, `src/services/authService.ts`, `src/routes/auth.ts`). There is no Apple provider wired up, and there is no code that syncs task data to Google Tasks, Microsoft To Do, OneDrive, or any external provider — OAuth today only establishes who the user is, it does not move data.

**Original plan (still aspirational, not scheduled):** when a user signs in with a Google, Microsoft, or Apple account, QTask should be able to additionally store or sync task data to that provider's associated services, where applicable, alongside QTask's own database, which remains the system of record.

- Google: optional sync of tasks/projects to Google Tasks or a dedicated Google Drive app-data folder, using OAuth with the Google Tasks/Drive API.
- Microsoft: optional sync to Microsoft To Do or OneDrive app folder, using Microsoft Graph API with OAuth.
- Apple: optional sign-in and sync via Apple's Reminders/CloudKit integration where feasible (note: Apple's APIs are the most restrictive of the three and may limit scope for third-party server-side sync; Apple sign-in itself hasn't been started either).
- Sync is opt-in per user and per provider; QTask's own MongoDB store always remains authoritative regardless of sync state.
- File attachments may be stored in the user's connected cloud drive (Google Drive / OneDrive) instead of, or in addition to, QTask's own object storage.

### 3.6 Collaboration & Sharing — **role-based sharing and email invites implemented; no real-time presence**

Sharing is a core feature, not an afterthought. Collaborators may use different identity providers, or no linked account at all — QTask's own backend is the source of truth for who has access to what, independent of which cloud account (if any) a user signed in with.

- Sharer / collaborator list: every project has a list of collaborators with defined roles (owner, manager, editor, executor, viewer), implemented in `src/types/project.ts` with permission helpers (`canEditProject`, `canManageMembers`, `canDeleteProject`, etc.). Manager can create sub-projects and edit structure but not delete or manage members. Access is evaluated per project; nesting does not automatically grant access to ancestors or descendants.
- Invite by email: a person without any existing QTask, Google, or Microsoft account can be invited by email; QTask sends an invite link (7-day TTL) and creates a pending collaborator record, with accepted/declined notification emails (`src/routes/invites.ts`, `src/services/inviteService.ts`, `src/services/emailService.ts`).
- Cross-provider identity: a collaborator's identity (Google-signed-in, Microsoft-signed-in, or email-only — Apple not yet supported, see 3.5) is tracked independently of how the resource owner signed in — access control lives entirely in QTask's backend, not in any single provider's system.
- Task delegation: a user can hand off an entire task (reassign) or share a subset (e.g. specific subtasks) with another collaborator.
- Real-time collaboration — **not implemented**: no websocket/socket.io layer exists in the backend or either client; collaboration today is invite/email-driven plus client-side polling/refetch, not live presence. The 4.1 stack row referencing Socket.io reflects the original plan, not current code.
- Notifications: in-app notifications are implemented (`src/services/notificationService.ts`, `NotificationBell` component in the web client); email notifications cover invite accept/decline. Push notifications are not implemented.

### 3.7 Search

Initial search is served by the hybrid structured + semantic retrieval described in 3.4, backed by MongoDB (with Atlas Vector Search in the cloud or local vector comparison in development).

- OpenSearch is a candidate future addition once usage outgrows MongoDB's native text/vector search — particularly useful for large shared workspaces needing advanced full-text relevance (fuzzy matching, faceting) and for AWS-native deployment via Amazon OpenSearch Service.
- Decision: defer OpenSearch to a later phase; do not add it to the initial backend to keep the local dev stack lean.

---

## 4. Technical Architecture

### 4.1 Stack Summary

| Layer | Technology | Status |
|---|---|---|
| Web client (user-facing) | React (Vite), `client/` | Shipped |
| Web client (admin console) | React (Vite), `admin-client/` — users, feedback triage, Ollama/GPU stats | Shipped, not in original plan |
| Mobile clients | React Native (iOS, Android) | Planned, not started |
| Backend API | Node.js / Express (Hono per `@hono/node-server` override), REST | Shipped; no WebSocket/Socket.io layer exists |
| AI interface | MCP server exposed by backend; MCP clients = local SLM (Ollama) or Claude API | Shipped |
| Database | MongoDB | Shipped, self-hosted (not Atlas) |
| In-memory cache / queue | Removed from stack — Redis dropped per current decision; embedding queue is a MongoDB-backed in-process queue | Confirmed absent |
| File storage | Local disk / S3-compatible (`@aws-sdk/client-s3` used for S3-compatible storage only, not an AWS migration) | Shipped |
| Vector search | Local cosine similarity against Ollama-generated embeddings | Shipped (see 3.4) |
| Auth | OAuth (OIDC): Google, Microsoft, plus email/password | Shipped; Apple not implemented |
| Full-text search (future) | OpenSearch — deferred, candidate for Phase 3+ | Not started |
| Deployment | Self-hosted, on-prem NVIDIA Jetson / GPU box, A/B blue-green deploy over SSH (see 4.5) | Shipped; supersedes "AWS migration" framing |

### 4.2 Note on Dropping Redis

Redis was originally proposed for session caching and a job queue for the embedding pipeline. Per the current decision, Redis is removed from the stack. Implications to plan for:

- Sessions: use signed JWTs (stateless) instead of server-side session storage.
- Embedding queue: use an in-process or MongoDB-backed job queue (e.g. a lightweight collection-based queue, or a library such as Agenda which uses MongoDB itself) instead of a Redis-backed queue like Bull.
- Caching: rely on MongoDB query performance and indexes initially; revisit a caching layer only if profiling shows it's needed.

### 4.3 MCP Server Design

The backend exposes an MCP server so that AI clients (local SLM or Claude) connect uniformly. Tool calls map directly onto existing domain service methods (task service, project service, collaboration service) so there is a single source of business logic shared between the regular REST API and the AI tool-calling path.

### 4.4 Data Model (MongoDB Collections)

| Collection | Purpose |
|---|---|
| `users` | Account info, linked identity providers (Google/MS/Apple/email), preferences |
| `projects` | Workspaces/projects with optional `parentId` (tree), `sortOrder`, `status`, `percentComplete`, optional `progressShare`, collaborator list with roles |
| `tasks` | Task documents incl. subtasks (nested or referenced), links, percent complete, embedding vector |
| `comments` | Threaded comments per task |
| `activity` | Audit log of changes per task/project, including AI-driven actions |
| `invites` | Pending email invites for collaborators without an existing account |
| `conversations` | Per-user agent session history for context continuity |

### 4.5 Deployment Architecture — self-hosted, not AWS

The original "local → AWS" migration narrative has not played out; instead, production runs self-hosted on an on-prem NVIDIA Jetson / GPU box (used to host Ollama for local LLM + embedding inference):

- `docker-compose.yml` runs MongoDB, the API, the admin console, and Ollama (with GPU profiles via `dcgm-exporter`/`nvidia`); `deploy/docker-compose.jetson.yml` and `scripts/build-jetson-release.sh` are Jetson-specific build/release paths.
- Releases are pushed via `scripts/publish-app-release.sh` over SSH to a fixed host, using an A/B blue-green deploy (`qtask-deploy prepare/test/promote`) across ports 3003–3006 for live/candidate app + admin stacks.
- `scripts/tunnel-app-server.sh` is a developer-convenience SSH tunnel, not a production service.
- The only AWS-adjacent dependency is `@aws-sdk/client-s3`, used for S3-compatible object storage — it does not imply the app itself runs on AWS.
- Implication: an actual AWS migration (Atlas, ECS/Fargate, managed S3, etc.) remains future work and should be tracked as its own phase rather than assumed as the default target.

---

## 5. Delivery Phases

1. **Backend core + agent UI — done.** Node.js + MongoDB, task/subtask/link CRUD, nested projects with progress rollup, percent-complete logic, MCP server with core tools, local SLM via Ollama, agent API with streaming, hybrid semantic search, React web client for Projects / Tasks / Agent / Search.
2. **Collaboration — mostly done.** Sharer/collaborator lists, email invites, role-based access shipped; real-time/live-presence updates not implemented (see 3.6).
3. **Auth & sync — partially done.** Google/Microsoft social sign-in shipped; Apple sign-in and all provider-side task/drive sync (Google Tasks, Microsoft To Do, Reminders/CloudKit) not started (see 3.5).
4. **Admin console & user feedback loop — done, not originally planned.** `admin-client/` for user management, feedback triage (incl. vision-assisted triage of image attachments) and admin replies, and Ollama/GPU monitoring; in-app `FeedbackDialog`/`FeedbackForm` and `NotificationBell` in the user-facing client.
5. **Launch/SEO surface — done, not originally planned.** About/Privacy/Terms/Welcome marketing pages, guided demo tour, MCP directory submission.
6. **Production clients (current focus for mobile):** React web app is polished and live; React Native iOS/Android has not been started — no mobile project scaffolding exists in the repo yet.
7. **AWS migration — not started; deployment model changed.** Current production deployment is self-hosted on an on-prem Jetson/GPU box (see 4.5), not AWS. Revisit whether an AWS migration is still the intended direction, or whether self-hosting is now the target architecture.
8. **Optional:** OpenSearch integration for advanced full-text search at scale.

---

## 6. Open Questions

- Apple sync scope — CloudKit/Reminders integration constraints need a feasibility spike before committing to a specific implementation. Apple sign-in itself also hasn't been scoped.
- Conflict resolution policy when a task is edited both in QTask and in a synced external provider (e.g. Google Tasks) simultaneously — moot until provider-side sync is actually built.
- Self-hosting documentation format and licensing (e.g. MIT vs AGPL) for the open-source release.
- Choice of specific local SLM and embedding model defaults to ship out of the box.
- **AWS vs. self-hosted:** production is currently self-hosted on a Jetson/GPU box (4.5), diverging from the original "local → AWS" narrative. Decide whether AWS migration is still a goal, or whether self-hosting is now the intended primary deployment model, and update this document's framing accordingly.
- **Mobile timing:** React Native iOS/Android has no code yet. Decide whether it stays a later phase or should be pulled forward, and whether it will share components with the web client or be built independently.
- **Real-time collaboration:** no websocket/live-presence layer exists despite being in the original plan (3.6) — decide if/when this gets prioritized given collaboration already works via invites + refetch.
