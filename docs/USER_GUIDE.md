# QTask — User Guide

How to use QTask day to day: projects, tasks, agent, and sharing.

Official site: **https://qtask.dev** · Source: [github.com/dbeasty/qtask](https://github.com/dbeasty/qtask)

---

## Table of Contents

1. [Getting started](#1-getting-started)
2. [Projects](#2-projects)
3. [Active project](#3-active-project)
4. [Tasks](#4-tasks)
5. [Agent](#5-agent)
6. [Sharing and roles](#6-sharing-and-roles)
7. [More help](#7-more-help)

---

## 1. Getting started

1. Create an account and verify your email.
2. Sign in. You will see the app header with three main views: **Projects**, **Tasks**, and **Agent**.
3. Open your account menu (your name or email in the header) for preferences, password, legal pages, and **Help**.

Use **Projects** to organize workspaces, **Tasks** to manage work items, and **Agent** to ask the AI assistant to create or update work (with your approval).

---

## 2. Projects

Projects group related tasks. They can form a **tree**: a project may sit under a parent project.

### Create

- On the Projects view, add a **root** project, or add a **child** under an existing project.
- Give it a name and optional description. Changes in the detail panel save automatically.

### Nest and move

- Create a child under any project you own.
- Use **Move** to reparent a project under another parent, or move it to the root level.
- You cannot move a project under one of its own descendants (that would create a cycle).

### Delete

- Deleting a project **reparents** its direct children to the deleted project’s former parent (or to root if it was a top-level project).
- Tasks that belonged **only** to the deleted project are removed.
- Tasks also linked to other projects stay; they are only unlinked from the deleted project.

### Progress

- **Leaf** projects (no child projects): percent complete is the average of linked tasks; status follows those tasks.
- **Parent** projects: percent complete rolls up from child projects. You can set each child’s **progress share** (relative weight) so some sub-projects count more toward the parent.
- Status on parents is derived from children (for example, all done → done; any activity → in progress).

### Members

- Open a project’s members controls to invite or manage collaborators.
- Roles and permissions are **per project**. Nesting does not automatically share access with parent or child projects.

---

## 3. Active project

The header shows your **active project** (click the name next to the tagline to switch).

- Agent and Tasks are scoped to the active project.
- Switching projects changes which work you see and where new agent-driven work tends to land.
- From the active-project menu you can also jump to the Projects view.

---

## 4. Tasks

- Tasks support nested **subtasks**, status, priority, due dates, and percent complete.
- Leaf task progress can be set directly; parents often roll up from subtasks.
- Tasks can belong to one or more projects. From Tasks you can **move**, **link** (share into another project), **unlink**, or **duplicate** a task into another project.
- Use the task tree and detail panel to navigate, edit, and reorganize work.

---

## 5. Agent

Agent is the AI assistant for QTask.

- Ask in natural language to find, create, or update tasks and projects.
- Use **New session** in the sidebar to start fresh threads; switch between **Sessions** as needed.
- **Write** actions (create/update/share, and similar) appear as proposals. Review and **Approve** or **Reject** them before they become real (unless you enable auto-approve in preferences).
- **Read** actions (search, get task, list projects, summarize) run without approval.
- Nesting projects (parent/child) is managed in the **Projects** UI today. The agent can create top-level projects and work with tasks; use Projects to build and rearrange the hierarchy.

---

## 6. Sharing and roles

Each project has an owner and optional collaborators:

| Role | Typical access |
|------|----------------|
| **Owner** | Full control, including members |
| **Editor** | Edit project and tasks |
| **Executor** | Update status / progress-style fields |
| **Viewer** | Read-only |

Invite people by email when your deployment supports it. Access is always checked on the project you are working in.

---

## 7. More help

- **In the app:** account menu → **Help** (same topics as this guide).
- **Developers / self-hosting:** [README](../README.md), [DEPLOY.md](DEPLOY.md)
- **Product requirements:** [QTask_Product_Requirements.md](QTask_Product_Requirements.md)
- **Contribute:** [github.com/dbeasty/qtask](https://github.com/dbeasty/qtask)
