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
| Listening | The API: `127.0.0.1` only, OS-chosen port (`listen(0)`), reported on stdout. Device sync (below) also listens on every interface, on a separate TLS port that only paired devices get past. |
| Auth | Every request must carry `x-qtask-device-token` (checked first, constant time, 403 otherwise). `POST /api/auth/local-session` then returns an ordinary session JWT + user for the one local user, so the rest of the API is unchanged. |
| Unmounted (404) | `/api/auth/{login,register,verify-email,forgot-password,reset-password,change-password,oauth/*,...}`, `/oauth`, `/.well-known`, `/api/invites`, `/api/notifications`, `/api/feedback`, `/api/mcp*`, `/api/oauth`, and the AI agent/conversation routes (`agentRouter` under `/api`). Still mounted: `/api/auth/{me,refresh,config,local-session}`, `/api/tasks`, `/api/projects`, `/api/search`. |
| Workers | Embedding and feedback-vision workers are off; embedding jobs are not enqueued; search is lexical only. Nothing in the process calls the network. |
| Startup | The legacy data migrations are skipped (a local store is born current). |
| `/api/version` | `{service, version, gitSha, mode}`, mode `"local"` (or `"online"` on the server). Available in both modes. |
| `/api/sync` | The cloud hub's protocol is **not** mounted (a device is a client of a hub). The device's own sync controls are `/api/local-sync/*`. |

## Environment (input to `src/local/entry.ts`)

| Variable | Required | Meaning |
|---|---|---|
| `QTASK_DEVICE_TOKEN` | yes | Per-launch secret, at least 16 chars. The app uses 32 random bytes. |
| `KDB_ADDR` | yes | `tcp://127.0.0.1:<port>` of this launch's `kdb-service` SQL listener. |
| `QTASK_DATA_DIR` | no | Data directory; default `~/Library/Application Support/QTask`. Tests and the e2e harness always set it. |
| `KDB_CLIENT_MODULE` | no | Path of the `@limidus/kdb-client` module (the app bundles one). |
| `QTASK_EXIT_ON_STDIN_CLOSE=1` | no | Exit when the supervisor's stdin pipe closes (orphan protection). |

`entry.ts` sets everything else (`NODE_ENV`, secrets, storage path, workers off) **before**
importing the server, because `src/config` reads the environment once at import. Do not add
static imports of `../config` to it.

Readiness: after `listen`, stdout gets one line `QTASK_READY {"port":N,"pid":N,"deviceId":"..."}`.

## Device sync (`sync.ts`, `sync-routes.ts`, `owner.ts`)

On by default in local mode (`QTASK_LOCAL_SYNC=0` turns it off). `connectData()` wraps the KDB
store with `SyncDataStore` and opens the sync records; `startLocalServer()` then starts the
transports, and SIGTERM/SIGINT stop them and flush the records.

* **Records**: `<dataDir>/sync/meta.json`, written atomically with fsync (`FileMetaPersistence`
  durable mode), 250 ms after a change and *always before* a pull answer or a push leaves the
  device, so a `kill -9` cannot roll the change sequence back below a peer's cursor or lose a
  tombstone a peer needs. A delete made just before a crash is recovered at the next start by
  `reconcile()` (the record says live, the store says gone). Tested in `tests/local-sync-e2e.test.ts`.
* **Identity**: the sync node id is derived from `device.key` (the same Ed25519 key);
  `sync/identity.json` (0600) adds the TLS key and certificate. Paired peers: `sync/paired-peers.json`;
  last known addresses `sync/peer-addresses.json`; settings (Bluetooth on/off, the LAN port, reused
  across launches) `sync/settings.json`; cloud token `sync/cloud.json` (0600).
* **Transports**: `LanTransport` on `0.0.0.0` (mDNS `_qtask._tcp` on 5353), and `BleTransport`
  over the app's bridge radio when the app opened the bridge and the user turned Bluetooth on,
  combined by `TransportSelector` (Wi-Fi first). `LanSyncCoordinator` with headers-first and
  "lower node id initiates". A local write schedules one round 400 ms later (writes in between
  join it). Changes applied from a peer are relayed to the cloud and the other way round.
* **Owner** (`owner.ts`): every device's local user has the same id (`LOCAL_OWNER_ID`), and the
  default project a deterministic id, so two devices' data line up without an account. A Phase 1
  install's random local user is re-owned to it at the first start. Signing in adopts the account
  (re-owns everything); a paired device learns the owner in the sync hello and adopts it too; two
  different accounts refuse to sync peer to peer.
* **Environment** (tests and diagnostics): `QTASK_DEVICE_NAME`, `QTASK_SYNC_LAN=0`,
  `QTASK_SYNC_HOST`, `QTASK_SYNC_ADVERTISE_HOST`, `QTASK_SYNC_MDNS=0`, `QTASK_SYNC_MDNS_PORT`,
  `QTASK_SYNC_MDNS_IFACES`, `QTASK_BLE_ENABLE=1`.

### `/api/local-sync` (device token only, no session)

| Route | |
|---|---|
| `GET /status` | this device, engine (pending, last synced, documents), Wi-Fi/Bluetooth state, peers (`connected`, `transport` wifi/bluetooth, `lastSyncedAt`, `pendingChanges`, `lastError`), cloud, current pairing, recent log, conflicts (from `activities`, `action: sync_conflict`) |
| `GET /revision?since=N&wait=ms` | long poll; answers when remote changes were applied or the owner changed (the client reloads its views / renews its session) |
| `POST /now` | a round with every connected peer and the cloud |
| `POST /pair/open` | pairing window (2 min): `link` (QR, with secret), `qrSvg`, `address` + `codeLink` (typed; six-digit code on both screens), `bleLink` when Bluetooth is on |
| `POST /pair/join {link}` | QR/pasted link, `host:port`, or `qtask://pairble`; returns when paired, failed, or a code needs confirming |
| `POST /pair/confirm {accept}` · `GET /pair` · `DELETE /pair` | code confirmation, state, cancel |
| `GET /peers` · `DELETE /peers/:id` · `POST /peers/:id/address` | list, unpair (drops the link at once), manual address |
| `POST /bluetooth {enabled}` | persisted; the radio is not touched until enabled |
| `POST /cloud/sign-in {hubUrl, token \| email+password}` · `POST /cloud/sign-out` | see "Cloud" |

### Cloud (minimum, not the plan's final sign-in)

Sign-in exchanges e-mail and password for a session at the hub's `/api/auth/login` (or takes a
session token), adopts the account and runs `DeviceSyncClient` against the hub's `/api/sync`.
**Missing**: OAuth / browser sign-in with the `qtask://oauth` callback, Keychain storage of the
token (it is a 0600 file), and token refresh: when the hub rejects the token the client shows
`signed-out` and the user signs in again. A hub account that already has its own default
project ends up with two "Project One"s after the first sync (different ids).

## The data directory (`resolveDataDir()`, `dataPaths(dir)` in `device.ts`)

```
<dataDir>/                 0700
  device.json              public identity {deviceId, publicKey, createdAt, schema}
  device.key               0600, PKCS8 PEM Ed25519 private key; never leaves the device
  secrets.json             0600, JWT/session secrets; local only, never synced
  kdb/                     kdb-service --data-dir (the documents)
  uploads/                 attachments (storage/local)
  logs/                    node.log, kdb.log (written by the supervisor)
  sync/                    0700: meta.json, identity.json, paired-peers.json, peer-addresses.json,
                           settings.json, owner.json, cloud.json (see "Device sync")
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
plus its default project. With device sync on (the default) its id is the device owner (see
"Device sync"), not a random id. Phase 2's "adopt account" re-owns documents whose `userId` is that
user's id; the id is `users.findOne({email: LOCAL_USER_EMAIL})._id`.

## KDB assumptions (isolated)

* One `kdb-service` per launch, one namespace `qtask/docs` (`KDB_NAMESPACE_PREFIX`), SQL
  wire on a loopback ephemeral port, **no auth** (the build in use has none for the SQL
  listener), peer-sync and stream listeners **disabled** (`--peer-addr "" --stream-addr ""`).
  Phase 2/3 will enable peer sync by changing the supervisor's argument list only
  (`client-macos/Sources/QTask/Supervisor.swift`, `KdbArguments`).
* Nothing outside `src/data/kdb/` and the Swift `Supervisor` knows about KDB. Swapping the
  store for another `DataStore` implementation needs no change here.
