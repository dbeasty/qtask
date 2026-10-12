# QTask for Mac (Phase 1: one device, fully offline)

A native window around the web client (`client/`). The task service runs inside the app as
two supervised children, with nothing to install and no network:

```
WKWebView  (app://qtask/, content security policy: connect-src 'none')
   │  bridge.js: fetch('/api/…') -> message to native code (a path, never a host)
   ▼
QTask (Swift/AppKit)  window, menus, Dock badge, supervisor
   │  loopback + per-launch device token
   ├─► Node  (bundled, src/local/entry.ts, QTASK_LOCAL=1)  the existing Express app
   │       │ @kdb/client over loopback
   └─► kdb-service (bundled)  file store in ~/Library/Application Support/QTask/kdb
```

* `Sources/QTaskCore`: plain logic, unit tested (`swift test`): request policy (what the page
  may ask for), asset serving and CSP, launch arguments, the process supervisor.
* `Sources/QTask`: the AppKit/WebKit shell. `E2EControl.swift` exists only in builds made with
  `E2E=1` (it is `#if QTASK_E2E`); a release build contains none of it.
* `Resources/bridge.js`: the page's side of the bridge.
* Backend contract (data directory, device identity, what local mode unmounts): `src/local/README.md`.

## Build and test

```
scripts/build-macos.sh              # release, ad hoc signed: client-macos/build/QTask.app
E2E=1 scripts/build-macos.sh        # same, plus the control folder the e2e/perf runs need
cd client-macos && swift test       # unit tests
node e2e/macos/run.mjs              # end-to-end against the built app
node e2e/macos/perf.mjs             # measurements -> docs/perf/phase1.md
```

The build needs a standalone Node (`QTASK_NODE_BIN`; Homebrew's cannot be bundled), a built
`kdb-service` and the `@kdb/client` source (`KDB_ROOT`, default the checkout beside this repo).
KDB is only read: its binary is copied and its client bundled as they are.

## Where data lives

`~/Library/Application Support/QTask/` (override with `QTASK_DATA_DIR`): `kdb/` the store,
`device.json` + `device.key` the device identity, `secrets.json` session secrets, `uploads/`,
`logs/node.log`, `logs/kdb.log`, `run/children.json`. Owner-only permissions throughout.

## Device sync

The backend syncs with paired devices over Wi-Fi (and Bluetooth when turned on) and, optionally,
a cloud account; see `src/local/README.md` ("Device sync"). In the app: File > Pair Device…,
File > Sync Now (⌥⌘S), File > Sync over Bluetooth, View > Devices & Sync (⌘3); opening a
`qtask://pair` link joins that pairing. `Info.plist` declares `NSLocalNetworkUsageDescription`
and `NSBonjourServices` (`_qtask._tcp`); the entitlements carry network client/server. Two app
copies pairing and syncing through the UI: `node e2e/macos/sync.mjs`.

## Bluetooth (Phase 4, opt-in, never run on a radio)

`Sources/QTask/BLE/` holds `CoreBluetoothRadio` (peripheral + central roles, no OS pairing) and `BLEBridgeClient` (loopback TCP to the backend's bridge, authenticated with the device token); `Sources/QTaskCore/BLE/` holds the pure, unit-tested parts. The backend opens the bridge at every launch (`QTASK_BLE=0` leaves it out) and the app connects to it, but CoreBluetooth is not touched until the user turns on "Sync over Bluetooth" (Devices & Sync or the File menu), which is remembered. It compiles, its pure parts are tested, and the Node side is tested end to end through the bridge with the driver standing in for this code (`tests/local-sync-ble.test.ts`); **it has not been run against a real Bluetooth radio** (a Mac cannot hear its own advertisement). `Info.plist` carries `NSBluetoothAlwaysUsageDescription`; the entitlements file declares `com.apple.security.device.bluetooth`. Details: `docs/sync-ble-transport.md`.

## Known limits of Phase 1

* No auto-update, Developer ID signing or notarization (Phase 5); the App Store sandbox is untested.
* The KDB SQL listener has no authentication in the build used: it is loopback-only on a random
  port per launch, and a process running as the same user could connect to it.
* The bundled Node is whatever the build machine provided (see `backend/VERSIONS.txt` in the app).
* The AI agent, invites, notifications, feedback, MCP and password UI are hidden: the backend does
  not mount them in local mode.
