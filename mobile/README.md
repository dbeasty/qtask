# QTask Mobile (React Native / Expo)

Implements Phases 0–3 of [`docs/Mobile_Client_Plan.md`](../docs/Mobile_Client_Plan.md): a task
manager client talking to the same REST API as `client/` (the web app), sharing domain types with
it via `@qtask/shared` (`../shared/src`).

## What's here

- Expo (managed) + TypeScript + React Navigation (bottom tabs: Projects / Search / Notifications)
  + TanStack Query.
- **Server connect screen** — QTask is self-hosted, so (unlike the web app, which is always
  same-origin) the mobile app asks for the server URL on first launch. Defaults to
  `https://qtask.dev` (the official hosted instance); stored via `expo-secure-store`, overridable
  any time via "Change server" on the login screen.
- **Auth**: email/password login against `POST /api/auth/login`, plus **Google/Microsoft OAuth**
  via the system browser (`expo-web-browser`'s `openAuthSessionAsync`, custom scheme `qtask://`).
  JWT stored in `expo-secure-store` (`src/config/storage.ts`), session bootstrap via
  `GET /api/auth/me`.
  - OAuth required a small backend change: `src/auth/userOAuth/service.ts` now accepts an
    allowlisted `redirectUri` (`qtask://oauth` only — see `isAllowedMobileRedirectUri`) so the
    provider callback can hand the auth code to the app instead of always redirecting to the web
    SPA's callback page. See `mobile/src/auth/oauth.ts`.
- **Projects**: list, create, edit/rename, delete (`ProjectDetailScreen`).
- **Tasks**: list per project, create, toggle done, edit title/description/status/priority,
  delete.
- **Search**: hits `GET /api/search`, results link into the matching project's task list or a
  task's detail screen.
- **Notifications & invites**: `NotificationsScreen` lists pending project invites (accept/
  decline) above the notification feed (mark read / mark all read); the Notifications tab shows an
  unread-count badge, polled every 30s (`src/hooks/useUnreadCount.ts`) since there's no
  WebSocket/push layer to push it live — see plan doc §4.1.

## What's NOT here (see plan doc §4 for why)

- Subtasks, materials/labor cost tracking, comments, activity feed, AI agent chat — the web app's
  full data model (see `shared/src/types.ts`) is ported as types, but only a task/project
  management subset has screens.
- Push notifications (APNs/FCM) — needs new backend work (device token registration + send
  integration); the badge above is polling, not push.
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
