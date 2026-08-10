# QTask — Launch & Marketing Copy

Ready-to-use copy for GitHub About, Show HN, MCP directories, and community posts.

---

## GitHub About (manual)

Apply at [github.com/dbeasty/qtask/settings](https://github.com/dbeasty/qtask/settings) → gear icon next to **About**.

| Field | Value |
|-------|-------|
| **Description** | AI-native task manager with an MCP server — connect it to Claude Desktop, Cursor, or any MCP client. |
| **Website** | https://qtask.dev |
| **Topics** | `mcp`, `mcp-server`, `task-management`, `todo-app`, `claude`, `ai-agent`, `self-hosted`, `productivity`, `ollama` |

---

## Show HN

**Title:**

```
Show HN: QTask – open-source task manager with an MCP server for Claude/Cursor
```

**Body:**

```
Hi HN — I built QTask because most todo apps don't integrate with AI workflows, and MCP clients need useful servers beyond filesystem and search.

QTask is open-source task and project management with a built-in MCP server. You can use it in the browser (with an in-app agent that proposes changes for your approval), or connect external AI tools:

- Claude Desktop — OAuth connector, no API key juggling
- Cursor — MCP API key + stdio bridge to qtask.dev or self-hosted
- Self-hosted — Ollama-backed agent, your data stays local

Features: nested tasks/projects, semantic search, staged writes (external AI proposes; you approve), sharing/roles.

Live: https://qtask.dev
GitHub: https://github.com/dbeasty/qtask
MCP setup: https://github.com/dbeasty/qtask/blob/main/docs/MCP.md

I'd love feedback from people using MCP with Claude or Cursor — what tools would you want exposed, and what's missing from task-management servers today?
```

---

## MCP directory submissions

Reuse this blurb across listings:

```
QTask — Task and project management MCP server. List/create/update tasks and projects, semantic search, staged write approval. Works with Claude Desktop (OAuth), Cursor (stdio bridge), and self-hosted deployments.

Docs: https://github.com/dbeasty/qtask/blob/main/docs/MCP.md
Site: https://qtask.dev
Repo: https://github.com/dbeasty/qtask
```

**Do not pay** for “premium / featured / dofollow” listing upsells ($39 etc.). Free paths below are enough.

| Directory | Free path | Notes |
|-----------|-----------|--------|
| **mcp.so** | [GitHub issue on chatmcp/mcpso](https://github.com/chatmcp/mcpso/issues/new) (or [mcp.so](https://mcp.so) → **Submit**) | Title: `Add MCP server: QTask`. Body: name, blurb, repo, site, docs, remote URL `https://qtask.dev/api/mcp` |
| **glama.ai** | [glama.ai/mcp/servers](https://glama.ai/mcp/servers) → **Add Server**, or wait for auto-index | Ensure GitHub topics include `mcp` and `model-context-protocol` |
| **mcpservers.org** | [mcpservers.org/submit](https://mcpservers.org/submit) | Leave **Premium Submit ($39)** unchecked; fill name/description/GitHub/category and hit **Submit** |
| Official community list | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Optional PR to community section |

### mcp.so issue body (copy-paste)

```
**Server Name:** QTask
**Description:** Task and project management MCP server. List/create/update tasks and projects, semantic search, staged write approval. Works with Claude Desktop (OAuth), Cursor (stdio bridge), and self-hosted deployments.
**GitHub:** https://github.com/dbeasty/qtask
**Homepage:** https://qtask.dev
**Docs:** https://github.com/dbeasty/qtask/blob/main/docs/MCP.md
**Remote MCP URL:** https://qtask.dev/api/mcp
**Auth:** OAuth (Claude connector) or API key + stdio bridge (Cursor)
```

### mcpservers.org form fields

| Field | Value |
|-------|-------|
| Server Name | QTask |
| Short Description | Task/project MCP server with OAuth for Claude, Cursor bridge, semantic search, staged write approval |
| Link | https://github.com/dbeasty/qtask |
| Category | Productivity |
| Contact Email | your email |
| Premium | **off** |

---

## Community posts (optional)

**r/ClaudeAI / r/cursor framing:**

```
Built an MCP server for task management — works with Claude Desktop OAuth and Cursor.

QTask lets you list/create/update tasks and projects from your AI client, with staged writes so nothing applies until you approve. Self-hostable or use qtask.dev.

MCP docs: https://github.com/dbeasty/qtask/blob/main/docs/MCP.md
```

---

## Link preview verification

After deploying to qtask.dev, confirm social previews:

- [opengraph.xyz](https://www.opengraph.xyz/?url=https://qtask.dev)
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/?q=https%3A%2F%2Fqtask.dev)

Expected: title, description, and og-image.png should appear in unfurls.
