# src/local: local mode and the device contract

Local mode (`QTASK_LOCAL=1`) is the Express backend running as a private, single-user
service inside the Mac app (Phase 1 of `docs/Offline_Desktop_P2P_Plan.md`). It is set by
the app's supervisor, never by an end user. Phases 2 (cloud sync) and 3 (Wi-Fi peer sync)
build on the pieces below; **please keep their code in `src/sync/` and add to this
contract here rather than changing it silently.**

## What local mode changes

| Concern | Local mode |
|---|---|
| Data store | Forced to KDB (`resolveDataBackend`); `DATA_MONGO` is an error. The app starts `kdb-service` and passes `KDB_ADDR`. |
| Listening | `127.0.0.1` only, OS-chosen port (`listen(0)`), reported on stdout. |
| Auth | Every request must carry `x-qtask-device-token` (checked first, constant time, 403 otherwise). `POST /api/auth/local-session` then returns an ordinary session JWT + user for the one local user, so the rest of the API is unchanged. |
| Unmounted (404) | `/api/auth/{login,register,verify-email,forgot-password,reset-password,change-password,oauth/*,...}`, `/oauth`, `/.well-known`, `/api/invites`, `/api/notifications`, `/api/feedback`, `/api/mcp*`, `/api/oauth`, and the AI agent/conversation routes (`agentRouter` under `/api`). Still mounted: `/api/auth/{me,refresh,config,local-session}`, `/api/tasks`, `/api/projects`, `/api/search`. |
| Workers | Embedding and feedback-vision workers are off; embedding jobs are not enqueued; search is lexical only. Nothing in the process calls the network. |
| Startup | The legacy data migrations are skipped (a local store is born current). |
| `/api/version` | `{service, version, gitSha, mode}`, mode `"local"` (or `"online"` on the server). Available in both modes. |

## Environment (input to `src/local/entry.ts`)

| Variable | Required | Meaning |
|---|---|---|
| `QTASK_DEVICE_TOKEN` | yes | Per-launch secret, at least 16 chars. The app uses 32 random bytes. |
| `KDB_ADDR` | yes | `tcp://127.0.0.1:<port>` of this launch's `kdb-service` SQL listener. |
| `QTASK_DATA_DIR` | no | Data directory; default `~/Library/Application Support/QTask`. Tests and the e2e harness always set it. |
| `KDB_CLIENT_MODULE` | no | Path of the `@kdb/client` module (the app bundles one). |
| `QTASK_EXIT_ON_STDIN_CLOSE=1` | no | Exit when the supervisor's stdin pipe closes (orphan protection). |

`entry.ts` sets everything else (`NODE_ENV`, secrets, storage path, workers off) **before**
importing the server, because `src/config` reads the environment once at import. Do not add
static imports of `../config` to it.

Readiness: after `listen`, stdout gets one line `QTASK_READY {"port":N,"pid":N,"deviceId":"..."}`.

## The data directory (`resolveDataDir()`, `dataPaths(dir)` in `device.ts`)

```
<dataDir>/                 0700
  device.json              public identity {deviceId, publicKey, createdAt, schema}
  device.key               0600, PKCS8 PEM Ed25519 private key; never leaves the device
  secrets.json             0600, JWT/session secrets; local only, never synced
  kdb/                     kdb-service --data-dir (the documents)
  uploads/                 attachments (storage/local)
  logs/                    node.log, kdb.log (written by the supervisor)
```

## Device identity (`loadOrCreateDeviceIdentity(dataDir)`)

* `deviceId`: UUID, stable for the life of the data directory. Use it as the KDB node id /
  peer name and in sync logs.
* `publicKey` / `device.key`: Ed25519. Sign pairing and handshakes with the private key
  (read `device.key` directly; do not copy it). The plan keeps the long-term key in the
  Keychain: when that lands, `device.key` is replaced by a Keychain item and this module
  is the one place to change.
* `loadOrCreateDeviceIdentity` throws if `device.json` and `device.key` do not match
  (a bad restore must not sign as another device).

## The local user

`ensureLocalUser()` (`auth.ts`) finds or creates the single user `local@device.qtask.invalid`
plus its default project. Phase 2's "adopt account" re-owns documents whose `userId` is that
user's id; the id is `users.findOne({email: LOCAL_USER_EMAIL})._id`.

## KDB assumptions (isolated)

* One `kdb-service` per launch, one namespace `qtask/docs` (`KDB_NAMESPACE_PREFIX`), SQL
  wire on a loopback ephemeral port, **no auth** (the build in use has none for the SQL
  listener), peer-sync and stream listeners **disabled** (`--peer-addr "" --stream-addr ""`).
  Phase 2/3 will enable peer sync by changing the supervisor's argument list only
  (`client-macos/Sources/QTask/Supervisor.swift`, `KdbArguments`).
* Nothing outside `src/data/kdb/` and the Swift `Supervisor` knows about KDB. Swapping the
  store for another `DataStore` implementation needs no change here.
