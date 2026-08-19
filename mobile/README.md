# QTask Mobile (React Native / Expo)

Implements Phase 0–2 of [`docs/Mobile_Client_Plan.md`](../docs/Mobile_Client_Plan.md): a task manager
client talking to the same REST API as `client/` (the web app), sharing domain types with it via
`@qtask/shared` (`../shared/src`).

## What's here

- Expo (managed) + TypeScript + React Navigation + TanStack Query.
- **Server connect screen** — QTask is self-hosted, so (unlike the web app, which is always
  same-origin) the mobile app asks for the server URL on first launch and stores it via
  `expo-secure-store`.
- **Auth**: email/password login against `POST /api/auth/login`, JWT stored in
  `expo-secure-store` (`src/config/storage.ts`), session bootstrap via `GET /api/auth/me`.
- **Projects list**, **task list per project** (create, toggle done), **task detail** (edit
  title/description, change status/priority, delete).

## What's NOT here (see plan doc §4 for why)

- Social/OAuth sign-in (Google/Microsoft) — needs `expo-auth-session` + deep-link config; the
  backend endpoint (`POST /api/auth/oauth/exchange`) already supports it, this is unimplemented
  client work.
- Subtasks, materials/labor cost tracking, comments, activity feed, AI agent chat — the web app's
  full data model (see `shared/src/types.ts`) is ported as types, but only a task-management
  subset has screens.
- Push notifications — needs new backend work (device token registration + send integration).
- Store submission / EAS build config, app icons, splash screen.

## Running it

```bash
cd mobile
npm install   # first time only
npm start     # then press i / a / w, or scan the QR code in Expo Go
```

You'll need a running QTask backend reachable from your phone/simulator (not `localhost` if
testing on a physical device — use your machine's LAN IP or a tunnel).

## Monorepo wiring

This isn't an npm workspace (the repo doesn't use one elsewhere either — see `client/`'s
`@qtask/agent` path alias for precedent). Instead:

- `metro.config.js` adds `../` as a watch folder and maps `@qtask/shared` to `../shared/src`.
- `tsconfig.json` mirrors that with a `paths` entry.

`shared/src/types.ts` is the same file used by `client/src/types.ts` (which now re-exports from
`@qtask/shared` instead of duplicating it).
