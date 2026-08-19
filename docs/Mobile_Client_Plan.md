# QTask Mobile Client — Implementation Plan

Status: **Phase 0 done; Phase 1 (auth) and a slice of Phase 2 (core tasks) implemented** in `mobile/`. Written 2026-08-19, updated same day against codebase v0.1.58. See `mobile/README.md` for what's implemented vs. deferred.

Implementation note vs. §2 below: instead of real npm workspaces, `shared/` and `mobile/` use the same path-alias pattern `client/` already uses for `@qtask/agent` (Vite `resolve.alias` / tsconfig `paths`, and Metro `watchFolders`/`extraNodeModules` for the mobile side). This matches existing repo convention and avoids introducing workspace tooling the rest of the repo doesn't use.

This plan is grounded in the current codebase, not the original (partly aspirational) PRD stack table. Key corrections vs. the PRD:

- Backend is **Express 5**, not Hono.
- Backend has **no WebSocket/Socket.io layer** — REST + polling only.
- Auth is **stateless Bearer JWT** (not cookie/session-based) — this is the single biggest reason a mobile client is cheap to add: no backend auth rework is needed.
- `shared/` currently holds only CSS theme tokens, not shared types/schemas. There is **no npm/yarn workspace** wiring `client/`, `admin-client/`, and a future `mobile/` together.

## 1. Recommended stack

| Decision | Choice | Why |
|---|---|---|
| Framework | **React Native + Expo** (managed workflow, EAS Build) | Fastest path to a working iOS+Android app from one codebase; avoids owning Xcode/Gradle build config by hand. Bare RN only buys anything if we need a native module Expo doesn't support — nothing on the current roadmap requires that. |
| Language | TypeScript | Matches `client/` and `src/`; enables sharing types. |
| Navigation | `@react-navigation/native` (stack + bottom tabs) | De facto standard for Expo apps; `client/` has no router to mirror, so this is a fresh choice, not a port. |
| Data fetching / cache | **TanStack Query (React Query)** | `client/` currently does hand-rolled `fetch` + hooks with no cache layer. Don't copy that pattern into mobile — mobile needs request caching/retries/offline-aware refetch far more than a desktop tab does (backgrounding, flaky networks). Introducing React Query here is a deliberate improvement, not scope creep, since mobile's UX depends on it. |
| Auth token storage | `expo-secure-store` (Keychain / EncryptedSharedPreferences) | Direct mobile analog of `client/src/auth/storage.ts`'s `localStorage` usage. |
| Styling | React Native `StyleSheet` + a small design-token module ported from `shared/theme-tokens.css` | Don't pull in a heavy UI kit; the web app's visual language is simple enough to hand-port core tokens (colors, spacing, type scale). |
| Push notifications | Expo Notifications (APNs/FCM via Expo push service) | See §5 — this requires new backend work, not just client work. |

## 2. Repo structure change

Add `mobile/` as a sibling to `client/` and `admin-client/`:

```
qtask/
  client/
  admin-client/
  mobile/              # new: Expo app
  shared/
  src/
```

`shared/` currently isn't a real package (no `package.json`). To avoid duplicating API types a third time (backend already has them inline, `client/src/types.ts` hand-duplicates them), this plan proposes:

- Turn `shared/` into an actual npm workspace package (`shared/package.json`, add root `"workspaces": ["client", "admin-client", "mobile", "shared"]`).
- Extract the request/response types currently hand-typed in `client/src/types.ts` into `shared/src/types.ts`, generated or kept in sync with backend route handlers in `src/routes/*.ts`.
- `mobile/` and `client/` both import types from `shared`.

This is a real but bounded refactor — do it as **Phase 0**, before mobile UI work starts, so mobile isn't built against a third copy of the type definitions.

## 3. Phased plan

### Phase 0 — Foundation (no user-visible mobile UI yet) — DONE
- Convert repo to npm workspaces; add `shared/package.json` and move duplicated types into it; update `client/` to import from `shared`.
- Scaffold `mobile/` with Expo + TypeScript, React Navigation, React Query, ESLint/Prettier config matching root.
- Add `mobile/` build step to `.github/workflows/ci.yml` (typecheck + `expo-doctor`/lint; full EAS builds likely stay manual/on-demand, not on every PR, to control CI cost).
- Decide and document target Expo SDK / RN version and minimum OS versions (e.g. iOS 15+, Android 8+).

### Phase 1 — Auth — DONE
- Email/password login screen calling `POST /api/auth/login`.
- Token storage via `expo-secure-store`; port the proactive-refresh logic from `client/src/auth/session.ts` (`REFRESH_LEAD_MS`/`REFRESH_GRACE_MS`) to a React Query-friendly auth context.
- Google/Microsoft OAuth — **done**, via `expo-web-browser`'s `openAuthSessionAsync` and the existing `POST /api/auth/oauth/exchange` endpoint. This needed one small backend change beyond what was originally scoped: `/api/auth/oauth/:provider` now accepts an allowlisted `redirectUri` query param (`qtask://oauth` only) so the callback can hand the code to the app via custom URL scheme instead of always redirecting to the web SPA's fixed callback page. See `src/auth/userOAuth/service.ts` (`isAllowedMobileRedirectUri`).
- Logout — implemented. Proactive token-refresh timing (`REFRESH_LEAD_MS`/`REFRESH_GRACE_MS`) ported to `shared/src/jwt.ts` but not yet wired into `AuthContext` as a background timer — currently only checked on app bootstrap.

### Phase 2 — Core task management (MVP surface) — DONE
Port the functional core of `client/src/pages/` to native screens, in priority order:
1. Task list / project view (read) — **done**.
2. Task create/edit/complete/delete — **done** (title, description, status, priority; not steps/tags/due date).
3. Projects/lists CRUD — **done** (list, create, rename/edit description, delete via `ProjectDetailScreen`).
4. Search (`/api/search`) — **done** (`SearchScreen`, results link into project task list / task detail).
5. Invites — accept/view pending invites (`/api/invites`) — **done**, folded into `NotificationsScreen` (see Phase 3) rather than a separate screen, since invites are themselves a notification-adjacent inbox concern.

Each screen: React Query hooks wrapping the existing REST endpoints (no new backend routes needed for this phase — same API surface as web).

### Phase 3 — Notifications — DONE (polling only)
- In-app notification list/badge, mirroring `NotificationBell.tsx`, via `GET /api/notifications` + `/unread-count`, polled every 30s while the app is foregrounded (`src/hooks/useUnreadCount.ts`) since there's no WebSocket layer — see §4 for the polling-vs-push tradeoff. Badge surfaces on the bottom-tab Notifications icon.
- Native push notifications (APNs/FCM) — **still not implemented**; this needs backend work, scoped separately in §5. Remains an explicit stretch goal, not baseline Phase 3, since it has server-side dependencies (device token registration/storage, send integration) beyond mobile-client scope.

### Phase 4 — Polish & store readiness
- Offline behavior: React Query cache + a clear "stale/offline" indicator (full offline write queue is out of scope for v1 — flag as a future item, not a v1 requirement).
- App icons, splash screen, deep linking (e.g. `qtask://task/:id`) for notification taps.
- EAS Build pipeline for TestFlight (iOS) and internal testing track (Android).
- Accessibility pass (screen reader labels, dynamic type).
- Store listings (screenshots, privacy nutrition label / Play data-safety form — check what user data is collected: email, tasks, feedback attachments).

### Phase 5 — Launch
- TestFlight/Play internal testing → closed beta → public release.
- Crash reporting (Sentry or Expo's own) wired before public beta, not after.

## 4. Open decisions requiring a call before/during Phase 0

1. **Realtime strategy.** No WebSocket layer exists today (confirmed absence, matches PRD). Options: (a) plain polling on app-foreground/interval, same as web today — cheapest, ships now; (b) add a WebSocket/SSE layer to the backend — bigger lift, benefits web too, but is a backend project of its own and shouldn't block mobile v1. **Recommendation: ship mobile v1 on polling, revisit realtime as a shared web+mobile backend initiative later.**
2. **Component sharing with web.** `client/` has no router and no shared component library extracted (all page components are web-DOM-specific, not reusable in RN). There is effectively nothing to share except types/constants/API-call shape (via `shared/`, per §2) and business logic (e.g. token-refresh timing math) that can be extracted into plain TS functions. Full UI code sharing (e.g. via Tamagui/Solito) is not recommended — the web app isn't built for it and retrofitting would be a larger project than the mobile app itself.
3. **Push notifications backend.** Needs: device token registration endpoint, storage (new `deviceTokens` collection), a send-on-event hook wherever notifications are currently created server-side, and either direct APNs/FCM integration or Expo's push service. Scope this as its own backend workstream (est. Phase 3/4 boundary), not bundled into Phase 0.
4. **Timing vs. other roadmap items.** The PRD (docs/QTask_Product_Requirements.md, "Open Questions") already flags mobile timing as undecided relative to AWS migration and real-time collaboration work. This plan doesn't resolve that prioritization call — it only says that *if/when* mobile is greenlit, this is the sequence.

## 5. Backend changes required (summary)

Everything in Phase 0–2 needs **zero backend changes** — the existing REST + JWT API already serves a web SPA and will serve RN identically. Backend work only enters at:
- Push notifications (new endpoint + collection + send integration, §4.3).
- Optionally, realtime (§4.1), if that decision is pulled forward.

## 6. Effort shape (rough, not a committed estimate)

- Phase 0: small (mostly the workspace/shared-package refactor; scaffolding itself is fast with Expo).
- Phase 1: small–medium (OAuth-in-mobile has the usual redirect-URI/deep-link fiddliness).
- Phase 2: the bulk of the work — screen-by-screen port of existing functionality, no new backend design needed.
- Phase 3: small for polling notifications; medium-large if push is included (backend + client + store review requirements).
- Phase 4–5: medium (store submission overhead is real and often underestimated — Apple review cycles, Play data-safety forms, TestFlight setup).
