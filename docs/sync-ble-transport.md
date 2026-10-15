# Bluetooth LE peer sync transport, Phase 4

Code: `src/sync/ble/` (`radio.ts`, `tunnel.ts`, `transport.ts`, `selector.ts`, `bridge.ts`, `sim.ts`), `src/local/ble.ts`, `client-macos/Sources/QTask/BLE/` and `client-macos/Sources/QTaskCore/BLE/`. Tests: `tests/sync-ble-*.test.ts` and `client-macos` `swift test`. Measurements and their limits: `docs/perf/phase4.md`.

**Read this first: what is and is not verified.** Everything in TypeScript is tested against a *simulated* radio. The Swift code compiles and its pure parts are unit tested, but **no byte has ever crossed a real Bluetooth radio**: a Mac cannot hear its own advertisement, there was no second device, and CoreBluetooth behaviour (MTU, throughput, backpressure, connect timing, permission prompts, background limits) is assumed from Apple's documentation, not observed. The first two-device test is the main open risk. See "Known limits and unverified assumptions".

## What it is

Two paired QTask devices with no network at all find each other over BLE, authenticate, and run the same sync engine over the link that runs over Wi-Fi:

```
SyncEngine (src/sync)              unchanged: hello / pull / push, headers-first
  LinkRpc + LanSyncCoordinator     unchanged (src/sync/lan/rpc.ts), plus shouldInitiate
    TransportSelector              Wi-Fi before Bluetooth, one link per peer
      BleTransport                 discovery, connect, reconnect, dedupe     (transport.ts)
        FramedChannel              messages, deflate, credit flow control    (src/sync/framing.ts, unchanged)
          SecureTunnel             X25519 + Ed25519 + ChaCha20-Poly1305      (tunnel.ts)
            RecordPipe             varint records, MTU-3 chunks, backpressure
              BleRadio             the contract in radio.ts
                SimulatedRadio     tests and measurements                    (sim.ts)
                BridgeRadio        JSON over loopback to the Mac app         (bridge.ts)
                  CoreBluetoothRadio (Swift)                                 (client-macos)
```

`BleRadio` is deliberately dumb. It advertises the service UUID, scans, connects, moves chunks of at most `MTU-3` bytes, and says honestly when its queue is full (`tryWrite` returns false until `onWritable`, mirroring `canSendWriteWithoutResponse` and `peripheralManagerIsReady`) and when a link is gone. It never pairs or bonds, so no OS dialog appears and no stable address exists. All security is in the tunnel.

## GATT profile

One primary service, UUIDs in `radio.ts` (and `BleProfile.swift`):

| Characteristic | Properties | Use |
|---|---|---|
| `info` | read | `version(1) flags(1) nodeId(16) keyTag(8) [name <= 24 bytes while pairing]` |
| `c2h` | write without response | central to peripheral |
| `h2c` | notify | peripheral to central |

Advertisements carry **only the service UUID** (no local name: a device name on the air announces who is nearby). `nodeId` is the device's LAN identity node id (SHA-256 of its Ed25519 public key, first 16 bytes). `keyTag` is `SHA-256("qtask-ble-info" || SPKI)[0..8]`, an early cheap check that an `instanceId` claim matches the key we hold for that peer. The `name` is included only while the user has opened a pairing window.

Every device runs both roles at once. For one pair, whichever side connects first is the GATT central of that link.

## Trust model

Authentication uses the **existing pairing records** (`PeerStore`, signed by both devices' Ed25519 identity keys when they paired). Nothing new is provisioned.

```
I -> R  HELLO    0x01 | v | I.nodeId | R.nodeId | eI                 (66 bytes)
R -> I  WELCOME  0x02 | eR | sigR      sigR = Ed25519(R.id, "R" | TH)
I -> R  AUTH     0x03 | seal(k_i2r, ctr 0, sigI)   sigI = Ed25519(I.id, "I" | TH)
R -> I  READY    0x04 | seal(k_r2i, ctr 0, TH)
        TH = SHA-256("qtask-ble-v1" | HELLO | eR);  keys = HKDF-SHA-256(X25519(eI,eR), salt TH, label)
data    0x10 | ChaCha20-Poly1305(k_dir, nonce = 4 zero bytes | 64-bit counter, aad = type)
```

* The responder **drops an initiator that is not a paired peer on the HELLO, silently, before sending a byte**. A device holding a wrong key fails at AUTH (initiator side: a responder that cannot sign as the expected device fails at WELCOME). No application data exists before both signatures verified. A HELLO addressed to a different node id is refused (stale address).
* Both signatures cover both ephemeral keys and both node ids: a man in the middle cannot splice or redirect sessions. Fresh ephemerals per session give forward secrecy against later key theft and make cross-session replay useless.
* Counters are implicit. A replayed, reordered, dropped, truncated or modified record fails authentication and **ends the tunnel**; the link is ordered, so nothing legitimate is ever out of order. A record that starts and never finishes is closed by a stall timer (15 s). Tests: `tests/sync-ble-tunnel.test.ts` (wrong key, unpaired, tamper, replay in-session and across sessions, reorder, drop, truncation, stall, fuzz of the record and info decoders and of the first-record path).
* Both screens can show a **six-digit code** (`SecureTunnel.sas`, HKDF of the same secret) for a paired link; it is optional there because the signatures already authenticate. It is essential during pairing (below).
* Limits of this model (accepted, documented): **the `info` value and the two node ids in HELLO are readable by anyone in radio range.** A stable device identifier on the air is a tracking vector; it is the price of finding a peer whose address rotates. An observer also sees traffic volume and timing. A radio-level attacker can jam or fill the peripheral's connection slots (at most `maxPreAuth`, default 4, unauthenticated connections are tolerated at once, each with a 10 s handshake timeout). Compromise of a device's identity key breaks that device's pairings, as on Wi-Fi.

### First-time pairing over Bluetooth

**Decision: pairing runs over Bluetooth itself, in a pre-auth tunnel, rather than requiring LAN pairing first.** The point of this transport is "no network at all"; making the user pair on Wi-Fi first would fail exactly the table-with-no-router case. The LAN pairing dialogue (QR secret MAC or six-digit code) is network-agnostic once it has a channel that binds both parties, so it is reused rather than reinvented:

1. The inviter calls `openPairing()`: the `info` flag turns on and a 128-bit secret is generated; the QR code is `qtask://pairble?id=<nodeId>&s=<secret>`. The joiner scans it, finds the device by node id (scan, connect, read `info`).
2. The joiner sends `PAIR_HELLO` with an ephemeral X25519 key, the inviter answers `PAIR_WELCOME`. Both derive an anonymous sealed session. A value derived from the DH secret plays the part of the TLS exporter on LAN.
3. Inside it the **same dialogue** as `LanTransport` runs (shared proofs in `src/sync/lan/pairing-crypto.ts`): QR flow = HMAC with the QR secret over a transcript binding both device descriptions and the session; or code flow = both users confirm the same six digits (derived from the transcript) and press yes. Then both sign the same `PairingRecord` and `PeerStore.add` stores it. The joiner hangs up (a CoreBluetooth peripheral cannot disconnect a central).
4. The inviter accepts one attempt at a time, three failures or two minutes close the window, a code-flow joiner is accepted only if the inviter opted in with `confirmSas`.

A man in the middle holds two sessions, so the two screens show different codes, and in the QR flow cannot compute the MAC at all. This is tested (`tests/sync-ble-transport.test.ts`, "a man in the middle sees two sessions"). Same limit as LAN: six digits give 10^6 per attempt with three attempts; a PAKE would be stronger and `node:crypto` cannot do the point arithmetic.

A device paired over Wi-Fi is automatically known to the Bluetooth transport (they share one `PeerStore`, which now notifies listeners), and the reverse.

## Transport behaviour

* **Discovery.** Scan only while some paired, unsuppressed peer has no link (`updateScan`); stop when everyone is connected. Scans restart every 8 s while looking, because OS scans report each device once per session. Each discovered device is connected to, its `info` read, and dropped at once if it is not a paired peer (and then ignored for 2 minutes), so unrelated QTask users nearby cost one short connection, not a handshake. One outbound connection at a time.
* **Addresses rotate.** A peer is identified only by `info.nodeId`. After a link drops, the central retries the remembered device id with backoff (1 s doubling to 30 s with jitter); an "unknown device" failure clears it and the scan finds the new address (tested: `rotateAddress`).
* **Two links at once.** If both devices connect at once, both keep the link opened by the lower node id. The higher id, after reading `info`, waits up to 1.5 s for the lower id to connect before spending a handshake.
* **Who starts a round.** On Wi-Fi both ends start a round when a link comes up. A round is bidirectional, so on Bluetooth that sends the data twice. `LanSyncCoordinator` now takes `shouldInitiate(link)`; the BLE setup uses "lower node id initiates", the other end serves and starts its own round after 15 s only if the peer never did (tested, including a wedged initiator). Measured effect in `docs/perf/phase4.md`.
* **Keep-alive.** A ping every 20 s on a quiet link; silence for 60 s closes it (virtual-clock tested; 1.2 KB per 5 minutes idle).
* **Wi-Fi first.** `TransportSelector([lan, ble])` (selector.ts) presents one link per peer to the coordinator, the best by list order. When Wi-Fi appears while a Bluetooth link is active the coordinator is given the Wi-Fi link; the Bluetooth link stays up as a standby and keeps serving whatever the other end still sends on it, so a switch loses nothing. After `standbyGraceMs` (30 s) of Wi-Fi staying up, Bluetooth is told to drop the peer and stop scanning for it (a Bluetooth link held "just in case" costs the radio); when Wi-Fi goes away it is released and reconnects lazily (scan, connect, handshake: roughly 1 to 2 s on the simulator, see the perf doc). `standbyGraceMs: Infinity` keeps standby links for instant failover. Tested with the real `LanTransport` on loopback: `tests/sync-ble-engine-e2e.test.ts`.
* **Batch size.** The engine's default batch is 500 documents per request. A message is delivered whole, so a 500-document response is one long uninterruptible transfer, and a link lost in the middle repeats it. Smaller batches (25, 100) cost more round trips and more bytes (measured: `docs/perf/phase4.md`); 100 to 500 is the useful range and 500 was fastest on every simulated profile, so the default was left alone. `headersFirst` stays on.

## What Swift exposes (and what the app must do)

The Node process owns the protocol. The Swift side owns the radio, in `client-macos/Sources/QTask/BLE/`:

* `CoreBluetoothRadio.swift`: `CBPeripheralManager` (service with `info`, `c2h`, `h2c`; advertises the UUID only) and `CBCentralManager` (scan, connect, discover, subscribe, write without response with `canSendWriteWithoutResponse`, notify with `updateValue` and `peripheralManagerIsReady`). **No pairing, no encrypted characteristics.** It keeps the *desired* state and applies it whenever Bluetooth powers on; managers are created on the first command so the permission prompt appears when the user turns Bluetooth sync on, not at launch.
* `BLEBridgeClient.swift`: a loopback TCP client (`Network.framework`) that authenticates with the per-launch device token (the same one used for HTTP) and relays JSON lines. The protocol is documented at the top of `src/sync/ble/bridge.ts`; `tests/helpers/ble-bridge-driver.ts` is an executable stand-in for the Swift side and the whole stack is tested through it.
* Pure, unit-tested parts in `QTaskCore/BLE`: `BleProfile`/`BleInfo` (golden bytes shared with the TypeScript test), `BridgeCodec`/`BridgeLineDecoder`, `ChunkQueue`.
* Opt-in wiring: `QTASK_BLE=1` in the app's environment makes the supervisor start Node with `QTASK_BLE_BRIDGE=1`; Node (`src/local/ble.ts`) listens on loopback only, requires the token, accepts one client, and reports `bleBridgePort` in its ready line; the app connects. Local mode now consumes it: `src/local/sync.ts` builds `BleTransport` on `bleRadio()` inside a `TransportSelector` after the LAN transport, and starts it only when the user turns Bluetooth sync on (`POST /api/local-sync/bluetooth`). The bridge is opened by default; `QTASK_BLE=0` removes it.
* `Info.plist`: `NSBluetoothAlwaysUsageDescription` (added). Entitlements: `com.apple.security.device.bluetooth` (added; it is the App Sandbox entitlement and does nothing for this unsandboxed ad hoc build). `scripts/build-macos.sh` now fails the build if the usage string is missing from the built `Info.plist` or the signed app lacks the entitlement (the checks were exercised on a test binary, not on a full app build).
* State restoration: not used on macOS (a quit Mac app does not sync). The iOS client should pass `CBCentralManagerOptionRestoreIdentifierKey` / `CBPeripheralManagerOptionRestoreIdentifierKey`.

## Known limits and unverified assumptions

Not verified on hardware (every item here is an assumption or a risk):

* **Real throughput.** The simulator takes bytes per second as an input. Real BLE notification/write-without-response throughput depends on the OS, the connection interval the central negotiates, data length extension, the PHY and interference; 20 to 150 KB/s are plausible figures to test with, not measurements.
* **Several centrals at once** (3 to 4 devices): radio time is shared; the simulator does not model contention.
* **CoreBluetooth assumptions**: that `maximumWriteValueLength(for: .withoutResponse)` and `maximumUpdateValueLength` give the usable payload; that `respond(to:)` on a write-without-response request is harmless; that `retrievePeripherals(withIdentifiers:)` finds a recently seen device; that unsubscribing is how a disconnected central shows up; that the scan reports a returning device after a restart. A peripheral cannot hang up on a central, so `close` on an incoming link stops using it and relies on the remote central cancelling (it does, when its tunnel closes); a misbehaving central can hold a connection slot.
* **iOS and Android** behaviour: not built here. Android rotates its address (handled by design) and has its own scan throttling; iOS suspends background apps and limits background scanning and advertising (service UUID advertisements move to an "overflow area" visible only to scans that name the UUID, which ours do). Background sync on a phone is unmeasured and may need a foreground screen.
* **Backgrounding / App Nap** on the Mac.
* **Scan and connect timing** in the simulator is configured (advertising interval 300 ms, connect 600 ms); real discovery after coming back into range may take seconds longer.
* The single-initiator rule needs the other end to be reachable; the 15 s fallback covers a silent peer, not a half-working link.
* A third device that joins next to two neighbours that both hold everything still receives roughly one copy per neighbour; the engine cannot tell one neighbour another is already sending (documented in the perf doc).

## Running the tests

```
npx tsc -p tsconfig.json --noEmit
npm run typecheck:tests          # pre-existing errors in client/ are unrelated (client deps not installed in a bare worktree)
node --import tsx --test --test-concurrency=1 tests/sync-*.test.ts
cd client-macos && swift build && swift test
npm run perf:ble                 # writes JSON to stdout; QUICK=1 SIZES=1000 PROFILES=... narrow it
```
