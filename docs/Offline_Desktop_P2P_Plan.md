# QTask for Mac, offline-first, with device-to-device sync (Wi-Fi and Bluetooth)

Status: **plan, nothing built.** Written 2026-10-11 against branch `feat/data-layer-abstraction`.

Modelled on Zolik: the native Mac app (`zolik/client-macos`, `docs/macos-window-model-plan.md`), and the offline / sync-later / Bluetooth work in `~/.claude/plans/do-a-plan-for-tender-spark.md` (Phases 1, 2, 2c, 3) plus `zolik/docs/drop-handling-and-hybrid-plan.md`.

## 1. Goal

1. A **Mac app** that runs QTask with **no server at all**: tasks, projects, comments, search, all on the device.
2. **Sync later to the server**: sign in, and what was done offline reaches the cloud account. Nothing is lost if the server is unreachable for days.
3. **Sync device to device over Wi-Fi or Bluetooth**, with no backend: a Mac and a phone (or two Macs) on the same table converge by themselves.

The cloud server becomes **one more peer**, not the centre. That is the one design idea everything below follows.

## 2. What Zolik did, and what carries over

| Zolik | QTask equivalent |
|---|---|
| Swift/AppKit shell, `WKWebView` showing the *same* web client the site serves (`client-macos/`) | Same shell around `client/` (the Vite SPA). |
| Page loads from `app://…`, CSP allows only the app; `bridge.js` swaps `fetch`/`WebSocket` for messages to native code, which refuses any host but the configured server, loopback or LAN | Same. QTask's client only uses `fetch` to `/api/*` (no WebSocket), so the bridge is simpler. |
| Go core linked into the app (`Zolikcore.xcframework`): "one process, no helper program" | **Does not carry over directly.** QTask's backend is TypeScript (Express, 20 services), not Go. See decision D1. |
| Embedded KDB (`FEATURE_FLAG_DB_ENGINE=kdb`, `KDB_PATH`) | Same engine. QTask already has `src/data/kdb/` behind `DATA_KDB`. |
| Offline pass, node key, signed bundle outbox, hub importer, import-once and ack | Replaced by KDB peer sync (§5), which does bundle/ack/retry natively. The *consent and identity* ideas carry over. |
| Bonjour `_zolik._tcp` + QR/typed-address fallback | Same, `_qtask._tcp`. |
| Custom BLE GATT tunnel, no pairing, own X25519 + ChaCha20-Poly1305 handshake, framing + deflate + flow control | Same design, reused wholesale. Carries KDB peer-sync frames instead of HTTP. |
| Mac e2e harness driving the built `.app` via a debug control folder | Same pattern. |

Not carried over: hosting a *game table*. Zolik has one authoritative host and guests. QTask data is long-lived and edited on several devices at once, so there is **no host**; every device is a full replica (§4).

## 3. Decisions to make first

**D1. How the existing TypeScript backend runs on the Mac.** I recommend **(a)**.

- (a) **Bundled Node as an in-app child process** hosting the current Express app on a loopback port, with `kdb-service` (Go, file-backed) as a second child. Least new code: the web client and all services run unmodified. Costs: ~50 MB for Node, two child processes to supervise, and it breaks Zolik's "no helper program" rule. Mitigation: the Swift app owns their lifecycle, loopback only, random port + per-launch token.
- (b) Run the services **inside the web view** against a browser-side KDB (Kotlin/JS or WASM). One process, nothing to spawn, and the same code could later run in React Native. Costs: the services must lose their Node-only dependencies (Express, `bcryptjs`, `jsonwebtoken`, `nodemailer`, S3) and KDB's browser persistence has to be proven. Larger refactor.
- (c) Port the logic to Go like Zolik. Rejected: rewrites 20 services and the MCP/agent layer for no user benefit.

Start with (a) to ship; keep the service layer free of Node-only imports where it is cheap, so (b) stays open. **Spike first** (Phase 0): confirm Node + `kdb-service` start from a signed `.app` and survive sandboxing.

**D2. Conflict policy.** KDB peers auto-merge when *different documents* changed, and for the *same document* apply `--peer-conflict-policy strict|last-write`. A task title edited on a phone and a due date edited on the Mac are the same document. Recommend: the application resolves it with a **field-level three-way merge** (base from the common commit, theirs, ours; same field changed on both sides → later `updatedAt` wins and the loser is kept in the activity log). Needs the resolver hook KDB exposes via `acceptRemote` / `rejectRemote` / `mergeBranches` — verify it is reachable from the service process, otherwise ship `last-write` first and add the resolver in Phase 5.

**D3. What replicates to which device.** Recommend **one KDB namespace per user** (`user/<id>`) and one per shared project (`project/<id>`). A device holds and syncs only namespaces it is entitled to (KDB: "the way to have a node hold only the data it needs is to make that data its own namespace"). Today `src/data/kdb/store.ts` puts everything in one namespace with a `_c` discriminator because `kdb-service` opens one runtime — so this depends on KDB's multi-namespace runtime (`kdb-spec-layer17`, "not wired into the binary" at the time of writing). Without it, a device would have to replicate the *entire* database, which is unacceptable for a hub with many users.

**D4. Identity with no server.** Recommend a **local user** created on first launch (device key pair in the Keychain). Signing in later *adopts* the account: local documents are re-owned to the account's `userId` and replicated into `user/<id>`. Two offline Macs belonging to the same person pair by QR / 6-digit code and then share a namespace; the pairing is signed by both device keys. Decide whether people who are *different* users may sync shared projects peer-to-peer without a server (§7, phase 6) or only through the cloud.

**D5. Phones.** Out of scope for the first ship; decided in Phase 7 once the Mac works. The Expo app in `mobile/` has no Node. Realistic route: the TS service layer plus a native KDB module in React Native (route (b) above). Say if phones must ship with the Mac, because it changes D1.

## 4. Architecture

```
WKWebView (client/ SPA, unchanged UI)
   │  bridge.js: fetch("/api/…") → native message; no direct network
   ▼
Swift app: windows, menus, Keychain, Bonjour, CoreBluetooth, supervisor
   │ loopback + per-launch token
   ├─► Node: the existing Express app, DATA_KDB=true, "local mode"
   │        │ @limidus/kdb-client over loopback
   └─► kdb-service (Go): file store + peer-sync listener
             ▲   ▲
   Wi-Fi/TLS │   │ BLE tunnel (framed, E2E-encrypted)
             ▼   ▼
        other devices      cloud hub (just another peer, outbound only)
```

Each device is a complete, independent replica. Reads and writes always hit the local KDB, so the app works identically offline, on a LAN or online. Sync is background reconciliation, never a request path.

**Local mode** (`QTASK_LOCAL=1`), set by the app and not by an end user:
- Auth: accept the local device token; the OAuth, email, password-reset, MCP-OAuth and feedback-email routes are not mounted.
- Features that need a remote service (embeddings via a model, the AI agent, S3 attachments, email invites) degrade visibly: hidden or "needs internet", queued where it makes sense (`embeddingJobs` is already a queue). Local Ollama is an option later. Attachments use the existing `storage/local.ts`.
- The web client hides online-only UI the way Zolik's does, from a `mode` flag in `/api/version`.

## 5. Sync design

KDB's model (README: "source control for structured documents … peers are equal … divergence is normal; merging is explicit") fits this directly. We use what exists and add as little as possible:

1. **Transport adapters, same protocol.** KDB peer sync already runs over TCP/TLS (`kdb-service --peer-addr`, `--peer`). Wi-Fi uses it as is, after Bonjour discovery. Bluetooth tunnels the same frames (§6). The protocol is not forked.
2. **The cloud is a peer** with a stable address: the app dials out with `--peer` when online and signed in. "Sync later" is just the next successful dial; KDB pushes everything missing and pulls the rest. No separate outbox, importer or ack loop to build or to leak (Zolik's Phase 2c had to fix an import loop, a retry gap and an unchecked-seat hole in its own outbox; we avoid all three by not having one).
3. **Deletes are tombstones** (`deletedAt`, filtered by the data layer), because a hard delete on one peer would otherwise reappear from another. Purge only after every known peer has the tombstone (KDB `--peer-retention-grace`). Audit every `deleteOne` / `deleteMany` in `src/services/*` for this.
4. **IDs are collision-free by construction.** `src/data/kdb/ids.ts` already maps ObjectId-shaped ids to KDB ids; confirm devices mint non-colliding ids offline (UUID or ObjectId with a per-device machine part).
5. **Counters and derived fields don't merge.** `trackingRollup`, `percentComplete`, `progressShare` and `sortOrder` are derived or order-dependent; recompute them after a merge instead of merging them (a post-merge hook in `taskService` / `projectService`).
6. **Data not to replicate:** sessions, MCP OAuth tokens, `userOAuthAuthCodes`, LLM metrics, admin audits, `embedding` vectors (rebuilt locally). These live in a local-only namespace.
7. **Authorisation at the peer.** A peer may only pull namespaces its credential covers (`kdb-rbac-plan`); the cloud hub enforces project collaborator roles (`editor|executor|viewer|manager`) on push; two offline devices of one person trust each other fully, anything else is limited to shared-project namespaces.
8. **Visibility:** a status line and per-device list ("Last synced 2 min ago from Dana's iPhone over Bluetooth", "3 changes waiting for the server"), and a sync log of what merged and what lost a conflict.

## 6. Wi-Fi and Bluetooth transports

**Wi-Fi (Phase 3).**
- `_qtask._tcp` over Bonjour (`NWListener` / `NWBrowser`); TXT carries protocol version, node id, namespace hashes. Fallback: QR code or `qtask://sync?h=ip:port&id=…` for client-isolated networks; a phone hotspot works without a router.
- TLS with a per-device self-signed certificate pinned at pairing, so a stranger on the same Wi-Fi can't pull your tasks. Browsing never exposes content; only a paired device completes the handshake.
- macOS: `NSLocalNetworkUsageDescription`, `NSBonjourServices`, the network client/server entitlements. Prompt deliberately and show a hint if nothing is found in ~5 s (Zolik's rule).

**Bluetooth (Phase 4).** Reuse Zolik's design; there, the BLE work is the largest risk.
- BLE GATT service with `info` (read), `c2h` (write), `h2c` (notify); advertise only the UUID, read `info` after connecting. **No OS pairing** (it shows a system dialog and gives no stable address): the tunnel brings its own X25519 handshake and ChaCha20-Poly1305 per message, authenticated by the keys exchanged at pairing — which is stronger than Zolik's trust-on-first-use, since QTask pairs once on purpose.
- Framing (varint length + flags, MTU−3 chunks) with deflate and explicit flow control, copied from `zolik-nearby`.
- Throughput: sync is incremental deltas, not live play, so the latency budget is loose; the first full sync of a large namespace is the case to measure. Prefer Wi-Fi when both are present.
- macOS ↔ macOS can be tested with two Macs; Mac ↔ iPhone needs a device. As in Zolik's README, **a Mac can't hear its own advertisement**, so BLE needs a second device for any real test.
- Alternative worth one day of evaluating before building: **Multipeer / Network.framework Apple-to-Apple only** is much cheaper and fine for Mac↔iPhone. Zolik needed custom BLE only for Android; decide whether Android is a requirement (D5).

## 7. Phases

Each is its own PR and releasable.

**Phase 0 — Prerequisites and spikes** (before any native code)
- Land the data-layer abstraction and flip production to `DATA_KDB` using the shadow-read bake that is already built. Remove the remaining Mongoose-only paths so the Node process doesn't need Mongo at all.
- Spike D1: a signed `.app` that launches Node + `kdb-service` from `Contents/Resources`, picks a free loopback port, and shuts both down cleanly. Measure size and cold start.
- Spike D2/D3: two `kdb-service` nodes, same namespace, same task edited on both, then `--peer` sync; confirm the resolver hook and multi-namespace runtime work.
- Audit services for hard deletes, counters and derived fields (§5.3, §5.5).
- Exit: a written go/no-go on D1–D3 here, in this file.

**Phase 1 — Mac app, single device, fully offline** (the Zolik Phase 1 equivalent)
- `client-macos/` Swift package: `WebController`, `Bridge`, `bridge.js`, menu builder, Keychain, supervisor; copy Zolik's CSP/`app://` approach.
- Local mode in the backend (§4); local user; data in `~/Library/Application Support/QTask/`.
- Menus/windows: one main window, ⌘N new task, ⌘F search, Dock badge for tasks due today. A window-per-project is a later option, not part of this phase.
- `scripts/build-macos.sh`, release into the existing `release:app` / `publish:app` flow, ad hoc signed.
- Exit: in airplane mode create, edit, complete, search and delete tasks and projects; quit, relaunch, data intact; `node e2e/macos/run.mjs`-style test passes.

**Phase 2 — Sync later to the cloud**
- Sign-in from the app (the browser flow, with the `qtask://oauth` callback that `mobile/` already uses; this fixes the "doesn't come back to the app" gap Zolik's Mac app still has).
- Adopt-account flow: re-own local docs, replicate into `user/<id>`, then dial the hub as a peer. Show "Sync now", status and queue size.
- Cloud side: accept peer connections per user namespace, enforce roles, keep the existing REST API reading from the same store so the web and the app agree.
- Exit: edit offline for a day on the Mac and on the web; reconnect; both converge; a task edited in both lands field-merged with the loser in the activity log; repeated syncs change nothing (idempotent).

**Phase 3 — Wi-Fi peer sync**
- Bonjour + QR pairing, pinned TLS, "Nearby devices" screen, auto-sync when a paired peer appears.
- Exit: two Macs on one Wi-Fi, no internet, edit the same project, converge in seconds; a hotspot works; client-isolated Wi-Fi shows the QR fallback.

**Phase 4 — Bluetooth peer sync**
- Native BLE module plus the tunnel and framing from `zolik-nearby`; transport selection (prefer Wi-Fi).
- Exit: with Wi-Fi off, two devices converge; walking out of range and back resumes without re-pairing; a 30-minute soak.

**Phase 5 — Conflict resolver and polish**
- Field-level merge (D2), tombstone purge, sync log screen, "resolve" UI for the rare case where both sides change the same text field.
- Sparkle auto-update, notarisation, Developer ID signing, then the Mac App Store sandbox question (a bundled Node and a local server are the hard part under the sandbox).

**Phase 6 — Sharing between different people, peer to peer** (optional)
- Project namespaces replicate between people's devices with the roles from `collaborators`; invites become a signed token handed over by QR / AirDrop instead of email.

**Phase 7 — Phones** (decision D5)
- Expo `mobile/` gains a local KDB and the same peer protocol over Wi-Fi/BLE; otherwise it stays an online client of the cloud peer.

## 8. Risks

- **Two sidecar processes in a sandboxed Mac app.** The biggest unknown (§7 Phase 0, and Phase 5 for the App Store). If it fails, fall back to D1(b).
- **Multi-namespace KDB** isn't wired into the shipped binary; D3 depends on it. Without it, sync is per-database, which is wrong for the hub.
- **Silent data loss from merges.** Same-document conflicts are the real product risk; ship `last-write` + a visible activity entry before claiming correctness, and test with randomised concurrent edits across 3 peers.
- **Tombstone growth / resurrected deletes** if a device is offline for months. Purge window is a policy decision.
- **Bluetooth throughput and OS limits** (background, App Nap); mitigated by incremental deltas and a Wi-Fi preference.
- **Privacy:** a stranger on the same network must see nothing. Pairing and pinned certificates are not optional, and this needs a security review before Phase 3 ships.
- **Feature drift:** AI agent, embeddings and email invites don't work offline; the UI must say so rather than fail.

## 9. Critical files

- Reuse/read: `zolik/client-macos/Sources/Jokerless/{Bridge,WebController,MenuBuilder}.swift`, `Resources/bridge.js`, `zolik/scripts/build-macos.sh`, `zolik/e2e/macos/`, `zolik/modules/zolik-nearby` (BLE + Bonjour), `kdb/docs/kdb-user-guide.md` ("Peer sync and replication"), `kdb/docs/kdb-spec-layer17-multi-namespace-runtime.md`.
- QTask, modified: `src/data/kdb/{store,schema,ids}.ts`, `src/config/index.ts` (local mode), `src/services/*Service.ts` (tombstones, post-merge recompute), `client/src/api/*` (mode flag, hide online-only UI), `scripts/build-app-release.sh`.
- QTask, new: `client-macos/`, `src/local/` (local auth + device identity), `src/sync/` (status API, resolver), `scripts/build-macos.sh`, `e2e/macos/`.
