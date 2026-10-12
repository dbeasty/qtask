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

## Bluetooth (Phase 4, opt-in, never run on a radio)

`Sources/QTask/BLE/` holds `CoreBluetoothRadio` (peripheral + central roles, no OS pairing) and `BLEBridgeClient` (loopback TCP to the backend's bridge, authenticated with the device token); `Sources/QTaskCore/BLE/` holds the pure, unit-tested parts. Start the app with `QTASK_BLE=1` to have the backend open the bridge. It compiles and its pure parts are tested; **it has not been run against a real Bluetooth radio** (a Mac cannot hear its own advertisement) and the sync engine is not yet wired into local mode, so the radio is connected but unused. `Info.plist` carries `NSBluetoothAlwaysUsageDescription`; the entitlements file declares `com.apple.security.device.bluetooth`. Details: `docs/sync-ble-transport.md`.

## Known limits of Phase 1

* No auto-update, Developer ID signing or notarization (Phase 5); the App Store sandbox is untested.
* The KDB SQL listener has no authentication in the build used: it is loopback-only on a random
  port per launch, and a process running as the same user could connect to it.
* The bundled Node is whatever the build machine provided (see `backend/VERSIONS.txt` in the app).
* The AI agent, invites, notifications, feedback, MCP and password UI are hidden: the backend does
  not mount them in local mode.
