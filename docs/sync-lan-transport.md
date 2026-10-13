# LAN (Wi-Fi) peer sync transport, Phase 3

Code: `src/sync/lan/` (identity, x509, mdns, links, transport), `src/sync/framing.ts` (transport-agnostic), `src/sync/transport-contract.ts`. Tests: `tests/sync-*.test.ts`. Measurements: `docs/perf/phase3.md`.

## What it is

Device-to-device sync with no server: pair two devices once, after which they find each other on the local network and connect over mutually pinned TLS. The transport carries opaque messages for the sync engine (Phase 2) through the `SyncTransport` interface.

`src/sync/transport-contract.ts` declares the interface the engine codes against. It was written without sight of Phase 2's own contract (it had not landed). Its surface is intentionally tiny (`onPeerUp(link)`, `onPeerDown`, `links()`, and per link `send` / `onMessage` / `onClose` / `close`); when Phase 2's contract lands, make this file re-export it.

## Trust model

- Each device has an Ed25519 identity key (`nodeId` = first 16 bytes of SHA-256 of its public key, hex) and a P-256 TLS key with a self-signed certificate (built in `x509.ts` with node:crypto only, no openssl, no dependency).
- A **pairing record** binds both devices' (nodeId, identity key, certificate fingerprint) and is signed by both identity keys. Records are re-verified on every load; editing one (for example swapping in an attacker's certificate fingerprint) invalidates it.
- Every sync connection is TLS 1.3 with client certificates on both sides. Each side compares the peer certificate's SHA-256 fingerprint to the pinned one before sending anything. No CA, no hostnames.
- ALPN `qtask-sync/1` is served to paired fingerprints only; any other client is destroyed before the server writes a byte (the server does not even send a hello). ALPN `qtask-pair/1` is served only while the user has an open pairing window (see below).
- What an unpaired device on the same Wi-Fi can learn: that something with a TLS stack listens on a port, the public self-signed certificate (that is what TLS gives away), and from mDNS the public node id and protocol version. No names, no account, no task data. mDNS is only a hint of where to dial; a forged advertisement can at worst cause a failed dial, since the pin is what authenticates.

### Pairing

Opened explicitly by the user on one device (`openPairing()`): one attempt at a time, 3 failures or 2 minutes closes it.

1. **QR flow.** The inviter shows `qtask://pair?h=ip:port&id=<nodeId>&fp=<certFp>&s=<128-bit secret>`. The joiner scans it, pins the certificate fingerprint from the QR before exchanging anything, and proves it holds the secret with an HMAC bound to the TLS session (RFC 5705 exported keying material) and to both device descriptions. The inviter proves the same back. Then both sign the record.
2. **6-digit code flow** (typed address, or no camera). Not a typed password: the 6-digit number is a short authentication string derived from the TLS session and both identities. **Both screens must show the same number and both users must confirm.** A man in the middle holds two different TLS sessions and so produces two different numbers. Because a typed 6-digit secret would be offline-brute-forceable without a PAKE, this deliberately does not work the other way round ("type the number shown on the other device"). The inviter must opt in (`confirmSas` callback), otherwise only QR joiners are accepted.

Open item for security review: SAS strength is 10^6 per attempt and the inviter allows 3 attempts; a stronger variant would use a PAKE (SPAKE2/OPAQUE), which needs elliptic-curve point addition that node:crypto does not expose.

### Discovery

- mDNS / DNS-SD `_qtask._tcp.local`, implemented in `mdns.ts` on `node:dgram` (PTR/SRV/TXT/A; announce, goodbye with TTL 0, query backoff 1 s to 60 s). TXT: `v=1`, `id=<nodeId>`.
- **Why not a package:** `bonjour-service` / `multicast-dns` would work, but this path parses attacker-controlled UDP from the LAN and we need one service type and four record types. ~250 lines with a bounded, never-throwing decoder (fuzz-tested) is a smaller attack surface than a dependency tree. Revisit if full mDNS correctness (conflict resolution, known-answer suppression, IPv6) becomes necessary.
- Manual fallback: `qtask://sync?h=ip:port&id=<nodeId>` (client-isolated Wi-Fi, hotspots, typed address) via `addManualAddress()`.
- Auto-sync: when a paired peer is discovered the transport dials it (the lower node id dials at once, the other waits 1.2 s to avoid duplicate connections), resets backoff, and fires `onPeerUp` so the engine starts a sync round. Failed dials back off exponentially (500 ms to 30 s with jitter). Duplicate connections between a pair are resolved deterministically on both sides (keep the one initiated by the lower node id).

## Framing (`src/sync/framing.ts`), shared with Bluetooth (Phase 4)

Frame: `varint(len) | flags | payload`. Flags: deflate (whole message, raw deflate, only if it helps and the message is at least 256 bytes), more-chunks, credit, ping, pong. Messages are chunked at `maxFramePayload` (64 KiB on LAN; set to MTU-3 minus header for a BLE characteristic). Flow control is credit based (1 MiB window by default; the receiver withholds credit while 4 MiB of undelivered messages are queued), so a slow consumer slows the sender. Limits: frame size, reassembled message size, decompression output cap (bomb protection). Protocol errors close the channel; `receive()` never throws.

The Bluetooth tunnel (Phase 4) supplies an `io.write` over a GATT characteristic, feeds notifications into `receive()`, and sets a small `maxFramePayload`; nothing else changes. Its own encryption layer (X25519 + ChaCha20-Poly1305 keyed from the keys exchanged at pairing) sits below the framing.

## What the Swift side must expose (Mac app, Phase 1's territory; not implemented here)

The Node process owns the protocol. The app shell must:

1. **Local Network permission.** `Info.plist`: `NSLocalNetworkUsageDescription` (for example "QTask syncs with your other devices on this network") and `NSBonjourServices` = `["_qtask._tcp"]`. Without both, macOS blocks multicast discovery and LAN connections silently after the first prompt.
2. **Entitlements** (sandboxed builds): `com.apple.security.network.client` and `com.apple.security.network.server` (the node child listens on a TCP port and sends multicast). A non-sandboxed ad hoc signed build needs none.
3. **Trigger the permission prompt deliberately**, from a settings screen ("Nearby devices"), not at launch: start discovery, and if nothing is found after about 5 s show the hint ("Allow Local Network access in System Settings > Privacy & Security, or use the QR / address option").
4. **Secrets:** pass a `SecretStore` backed by the Keychain (the default is a 0600 file in the data directory). Provide the data directory and a device name (`Host.localizedName`).
5. **Pairing UI:** render the invitation `link` as a QR code; accept a scanned or pasted `qtask://pair` link; show the 6-digit code with Confirm/Cancel for the code flow; a "Nearby devices" list (paired peers, connected or not, last sync); an "Unpair" action (`PeerStore.remove`). Register the `qtask://` URL scheme.
6. **Optionally** advertise/browse with `NWListener` / `NWBrowser` instead of the Node mDNS; the service type and TXT keys are the same, and both can coexist. If the native browser is used, hand discovered `(nodeId, host, port)` to `addManualAddress()`.
7. If the Node child binds to a specific interface, bind the sync listener to `0.0.0.0`, and keep the *API* listener (the loopback HTTP server) on loopback only. They are different ports.

## Not covered

Real multi-device Wi-Fi behaviour (client isolation, IGMP snooping, roaming, power save), IPv6-only networks (the mDNS implementation is IPv4; the TLS transport accepts IPv6 addresses), and iOS/Android. The Phase 2 engine integration is untested: all sync behaviour above is tested against a small stand-in engine in `tests/helpers/lww-store.ts`.

## In the app (local mode)

`src/local/sync.ts` runs this transport in the Mac app's backend: listener on `0.0.0.0` (port remembered across launches), mDNS on, identity from the device key, pairing through `/api/local-sync/pair/*` and the Devices & Sync page, the Swift items from "What the Swift side must expose" 1, 2 and 5 done (Info.plist keys, entitlements, pairing UI, `qtask://` scheme). Not done: Keychain `SecretStore`, the native `NWBrowser` and the 5 s "nothing found" hint. Engine over this transport between two real backend processes: `tests/local-sync-e2e.test.ts`; two app copies: `e2e/macos/sync.mjs`.
