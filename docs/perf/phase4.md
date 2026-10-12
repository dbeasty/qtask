# Phase 4 (Bluetooth) measurements, on a simulated radio

Reproduce: `npm run perf:ble` (`QUICK=1 SIZES=1000 PROFILES=mtu185-60KBps-50ms` narrows it). Script: `scripts/perf-ble.ts`; raw output of the run below: `docs/perf/phase4.json`. darwin/arm64, Node v26.0.0, one run per configuration.

## Read this first

**Every number here comes from a software simulation of a Bluetooth link. None comes from a radio.** The simulator (`src/sync/ble/sim.ts`) is given a throughput, a latency, an MTU, a connect time and so on, and the numbers that come out are what the *protocol* does on a link with those properties: how many bytes it sends, how many round trips it needs, how it behaves under flow control and reconnects. They say nothing about what a real phone or Mac achieves; whether 20, 60 or 150 KB/s is realistic is exactly what a hardware test has to find out. Treat the byte counts as solid (they do not depend on the radio) and the times as "what these assumptions give".

## Method

* Two devices (A, B), each with its own identity, the real `SyncEngine` over `SyncDataStore` over an in-memory store, the real `BleTransport` (tunnel, framing, deflate, credit flow control, discovery and reconnect), paired through the real pairing-record format. Only the radio is simulated. `LanSyncCoordinator` runs the rounds with `headersFirst` on unless stated.
* **Time is virtual.** The simulator is the clock: a transfer that needs minutes of airtime runs in milliseconds, and only the radio costs time (computation counts as zero, and the clock waits for work in flight before it moves). So the times are *radio time*; real devices would add CPU time (deflate, ChaCha20, JSON, applying documents) on top.
* **Profiles** (MTU is the ATT MTU, chunk = MTU - 3; throughput is application payload bytes per second per direction; latency is one-way per chunk, about one connection interval):
  * MTU 185, 20 KB/s, 100 ms: a conservative link (long connection interval)
  * MTU 185, 60 KB/s, 50 ms: a middling link
  * MTU 512, 150 KB/s, 30 ms: an optimistic link (large MTU, short interval)
  * Fixed in all: advertisement heard within 300 ms, connect + service discovery + subscribe 600 ms, radio transmit queue 24 chunks, link supervision timeout 4 s. These are guesses, not measurements.
* **Documents** are `realisticTask(i)` in `tests/helpers/ble-world.ts`: short imperative titles ("Review the quarterly report before Friday"), 0 to 5 sentences of notes with names, ticket numbers and amounts, tags, priority, estimate, optional due date. Plain JSON is 201.9 KB per 1,000 documents. This text is generated from a small template vocabulary, so it compresses better than real free text would; the "harder text" table below adds longer notes made of 4,000 pseudo-words with a Zipf-like frequency and random reference numbers, to show the sensitivity. Neither is a sample of real user data.
* The initial sync is A holding N documents and B empty, from the moment the first link is up until B holds all N. "Sync time" excludes discovery and connection (0.9 to 1.8 s in every run). "Bytes on air" counts GATT chunk payload in both directions including the handshake, record headers, AEAD tags, credit frames and keep-alives. "Framed bytes" is what the framing layer wrote before encryption and record headers.
* Both ends start a round when the link comes up (the default) unless the row says "single initiator".
* Run-to-run variation: radio events are deterministic, but the transport adds random jitter to connection timing, so identical configurations differ a little. The amount of duplicated data in the both-ends-initiate case varies noticeably (see the 3-device table: one neighbour's initial sync was 103 KB in one run and 136 KB in another). One run each; do not read differences of a few percent as real.

## What the simulator models, and what it does not

Models: ATT MTU and chunking; bytes per second and per-chunk latency per direction; a bounded transmit queue with the same backpressure contract as CoreBluetooth; connect, service discovery and info-read delays; advertising and scanning (a scan session reports each device once; a radio never hears its own advertisement); range in and out with a supervision timeout; abrupt disconnects; Bluetooth off and on; address rotation; optional link-layer retransmission delay and hard chunk loss (used in the correctness tests, not in these tables).

**Does not model, and therefore has not measured**: the throughput and latency a real radio gives; packet loss and retransmission on a busy 2.4 GHz band, or Wi-Fi coexistence; **3 to 4 centrals contending for one peripheral's airtime** (the simulator gives every connection its own full bandwidth, so a table of 4 devices around one hub would be slower than any figure here); the connection interval, MTU and data-length extension the OS actually negotiates (the app cannot force them); **iOS and Android behaviour** (Android address rotation is only simulated; scan throttling, background restrictions, the advertisement overflow area); **backgrounding and App Nap** (the Mac app asleep, an iPhone with the screen locked); CPU cost of crypto and deflate on a phone; battery. Reconnect times below are dominated by the advertising interval and connect time configured in the simulator.

## Results

### Initial sync

#### 1,000 documents

| Profile | Variant | Sync time | Bytes on air (KB) | Framed bytes A to B (KB) | Messages | Radio queue refusals |
|---|---|---|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | headersFirst+deflate | 6.0 s | 111 | 103 | 20 | 587 |
| MTU 185, 20 KB/s, 100 ms | headersFirst, no deflate | 62.2 s | 1,271 | 1,195 | 20 | 7,439 |
| MTU 185, 20 KB/s, 100 ms | no headersFirst, deflate | 5.5 s | 101 | 98 | 12 | 603 |
| MTU 185, 20 KB/s, 100 ms | no headersFirst, no deflate | 57.5 s | 1,129 | 1,105 | 12 | 6,647 |
| MTU 185, 60 KB/s, 50 ms | headersFirst+deflate | 2.1 s | 112 | 103 | 20 | 597 |
| MTU 185, 60 KB/s, 50 ms | headersFirst, no deflate | 20.8 s | 1,272 | 1,195 | 20 | 7,442 |
| MTU 185, 60 KB/s, 50 ms | no headersFirst, deflate | 1.9 s | 102 | 98 | 12 | 617 |
| MTU 185, 60 KB/s, 50 ms | no headersFirst, no deflate | 19.2 s | 1,129 | 1,105 | 12 | 6,645 |
| MTU 512, 150 KB/s, 30 ms | headersFirst+deflate | 941 ms | 114 | 105 | 20 | 246 |
| MTU 512, 150 KB/s, 30 ms | headersFirst, no deflate | 8.4 s | 1,272 | 1,195 | 20 | 3,063 |
| MTU 512, 150 KB/s, 30 ms | no headersFirst, deflate | 787 ms | 104 | 100 | 12 | 269 |
| MTU 512, 150 KB/s, 30 ms | no headersFirst, no deflate | 7.7 s | 1,130 | 1,105 | 12 | 2,779 |

#### 10,000 documents

| Profile | Variant | Sync time | Bytes on air (KB) | Framed bytes A to B (KB) | Messages | Radio queue refusals |
|---|---|---|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | headersFirst+deflate | 72.2 s | 1,398 | 1,315 | 164 | 7,359 |
| MTU 185, 20 KB/s, 100 ms | headersFirst, no deflate | 793.1 s | 16,171 | 15,320 | 164 | 94,591 |
| MTU 185, 20 KB/s, 100 ms | no headersFirst, deflate | 65.7 s | 1,295 | 1,262 | 84 | 7,645 |
| MTU 185, 20 KB/s, 100 ms | no headersFirst, no deflate | 745.3 s | 14,710 | 14,400 | 84 | 86,489 |
| MTU 185, 60 KB/s, 50 ms | headersFirst+deflate | 24.8 s | 1,398 | 1,315 | 164 | 7,362 |
| MTU 185, 60 KB/s, 50 ms | headersFirst, no deflate | 264.4 s | 16,170 | 15,320 | 164 | 94,552 |
| MTU 185, 60 KB/s, 50 ms | no headersFirst, deflate | 22.0 s | 1,296 | 1,262 | 84 | 7,651 |
| MTU 185, 60 KB/s, 50 ms | no headersFirst, no deflate | 248.5 s | 14,709 | 14,400 | 84 | 86,449 |
| MTU 512, 150 KB/s, 30 ms | headersFirst+deflate | 10.3 s | 1,398 | 1,316 | 164 | 2,840 |
| MTU 512, 150 KB/s, 30 ms | headersFirst, no deflate | 105.8 s | 16,170 | 15,320 | 164 | 38,999 |
| MTU 512, 150 KB/s, 30 ms | no headersFirst, deflate | 8.8 s | 1,296 | 1,264 | 84 | 3,222 |
| MTU 512, 150 KB/s, 30 ms | no headersFirst, no deflate | 99.5 s | 14,709 | 14,400 | 84 | 36,046 |

What they show:

* **Deflate is essential.** The engine's wire format carries a stamp and a version vector per field, about 1.2 KB per document before compression against about 0.2 KB of document text. Compressed it is about 100 to 135 bytes per document. Without deflate 10,000 documents are 15 MB and take 13 minutes at 20 KB/s (4.4 minutes at 60, 1.8 at 150); with it, 72 s, 25 s and 10 s.
* **Headers-first costs a little in the two-device case**: about 8% more bytes and 10 to 17% more time at 10,000 documents (1,398 KB against 1,296 KB on air; 24.8 s against 22.0 s at 60 KB/s), because the headers (document id and version vector for every document) cross the link and with a single source nothing is saved by them. It pays off with more than one neighbour, see below. It stays on, as asked.
* With the BLE channel defaults (window 48 KiB, 2 KiB frames) the sender is never starved of credit in any run; the radio's own queue is what paces it (the "refusals" column counts writes that had to wait for the ready signal).

### Compression sensitivity: harder text (1,000 documents)

| Profile | Variant | Sync time | Bytes on air (KB) |
|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | headersFirst+deflate | 12.1 s | 230 |
| MTU 185, 20 KB/s, 100 ms | headersFirst, no deflate | 75.4 s | 1,530 |
| MTU 185, 60 KB/s, 50 ms | headersFirst+deflate | 4.2 s | 231 |
| MTU 185, 60 KB/s, 50 ms | headersFirst, no deflate | 25.2 s | 1,530 |
| MTU 512, 150 KB/s, 30 ms | headersFirst+deflate | 1.8 s | 232 |
| MTU 512, 150 KB/s, 30 ms | headersFirst, no deflate | 10.1 s | 1,532 |

Longer, less repetitive notes roughly double the compressed size (231 KB against 112 KB). Real free text may be on either side of the first data set; the order of magnitude, a few hundred bytes per document compressed, is what to expect.

### Batch size (1,000 documents, headers-first, deflate)

The engine requests and pushes in batches (default 500 documents); a batch is one message delivered whole.

| Profile | Batch size | Sync time | Bytes on air (KB) | Messages |
|---|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | 25 | 22.1 s | 233 | 324 |
| MTU 185, 20 KB/s, 100 ms | 100 | 9.8 s | 158 | 84 |
| MTU 185, 20 KB/s, 100 ms | 500 | 6.0 s | 111 | 20 |
| MTU 185, 60 KB/s, 50 ms | 25 | 10.1 s | 233 | 324 |
| MTU 185, 60 KB/s, 50 ms | 100 | 3.7 s | 158 | 84 |
| MTU 185, 60 KB/s, 50 ms | 500 | 2.2 s | 112 | 20 |
| MTU 512, 150 KB/s, 30 ms | 25 | 5.6 s | 233 | 324 |
| MTU 512, 150 KB/s, 30 ms | 100 | 1.8 s | 158 | 84 |
| MTU 512, 150 KB/s, 30 ms | 500 | 932 ms | 113 | 20 |

Smaller batches cost more round trips and about twice the bytes at 25 per batch (more envelope, less to compress against), and were slower on every profile. Their only advantage is progress per interruption: if the link drops mid-batch, the batch is repeated, so a batch is the unit of wasted airtime. 500 stayed the default; 100 is a reasonable choice if links are expected to break often. This was measured on a stable link, not with interruptions.

### Single-change latency (1,000 documents already on both devices)

Create one task on one device, trigger a round, wait until the other device has it. Radio time only.

| Profile | Change A to B | Change B to A | Bytes on air per change |
|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | 540 ms (p95 540) | 540 ms (p95 540) | 1,162 |
| MTU 185, 60 KB/s, 50 ms | 280 ms (p95 280) | 280 ms (p95 280) | 1,159 |
| MTU 512, 150 KB/s, 30 ms | 160 ms (p95 160) | 160 ms (p95 160) | 1,159 |

A change costs about 1.2 KB on air and about 5.5 one-way latencies (hello, pull, push, each a round trip). Latency is deterministic in the simulation, hence identical median and 95th percentile.

### Reconnect, and idle cost (100 documents)

| Profile | First link after both start | Back in range: link up p50 / p95 / max | Back in range: change delivered p50 / max | Address rotated: link up p50 / max | Idle bytes per 5 min |
|---|---|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | 1,568 ms | 1,315 / 1,667 / 1,667 ms | 1,866 / 2,221 ms | 1,552 / 1,877 ms | 1,200 |
| MTU 185, 60 KB/s, 50 ms | 1,317 ms | 955 / 1,478 / 1,478 ms | 1,186 / 1,700 ms | 1,054 / 1,487 ms | 1,200 |
| MTU 512, 150 KB/s, 30 ms | 1,174 ms | 812 / 1,288 / 1,288 ms | 946 / 1,420 ms | 812 / 1,020 ms | 1,200 |

"Back in range" is measured from the moment the radios can hear each other; the loss itself is noticed after the 4 s supervision timeout (in the simulator) and the devices scan for the missing peer meanwhile. Reconnecting to a remembered device id and finding a peer whose address changed took about the same time because the simulator's scan finds a device within the configured advertising interval; a real scan may take much longer. Keep-alives cost 1.2 KB per five minutes per link.

### A third device joins two neighbours that both hold 1,000 documents

| Profile | Variant | C receives (framed KB) | Time for C to complete |
|---|---|---|---|
| MTU 185, 20 KB/s, 100 ms | headersFirst, both ends initiate | 175 | 8.4 s |
| MTU 185, 20 KB/s, 100 ms | headersFirst, single initiator | 110 | 7.3 s |
| MTU 185, 20 KB/s, 100 ms | no headersFirst, both ends initiate | 262 | 6.8 s |
| MTU 185, 60 KB/s, 50 ms | headersFirst, both ends initiate | 142 | 3.3 s |
| MTU 185, 60 KB/s, 50 ms | headersFirst, single initiator | 74 | 4.4 s |
| MTU 185, 60 KB/s, 50 ms | no headersFirst, both ends initiate | 262 | 2.9 s |
| MTU 512, 150 KB/s, 30 ms | headersFirst, both ends initiate | 142 | 2.0 s |
| MTU 512, 150 KB/s, 30 ms | headersFirst, single initiator | 71 | 3.2 s |
| MTU 512, 150 KB/s, 30 ms | no headersFirst, both ends initiate | 262 | 1.9 s |

Without headers-first the newcomer is sent every document by both neighbours and in both directions of each round (262 KB in every profile, against about 68 KB for one clean copy). Headers-first brings that to 142 to 175 KB. Letting **only one end of each link start the round** (`shouldInitiate`: lower node id) cuts it again to 71 to 110 KB, and also halves the cost of an ordinary two-device sync (68 KB instead of 103 to 136 KB). The remaining duplication (C hears from two neighbours that both have everything) needs engine support (not offering a document another neighbour is already sending); it is not done.

## Observations that affect design

* Bandwidth, not latency, dominates a first sync; a steady-state change is a fraction of a second. The risky case is a large first sync over a slow link: 10,000 documents of ordinary task text are about 1.4 MB on air, 25 s to 72 s across the first two profiles.
* Everything depends on compression being effective on the wire envelope; a future change that makes the envelope less repetitive (random per-field ids, encrypting before compressing) would be costly.
* The simulation showed that the coordinator started two rounds per link, doubling the data on a scarce link; that is now an option (`shouldInitiate`), and the BLE setup in the tests uses it.
* An earlier version of the simulator let virtual time run ahead while the engine was still applying a batch, which inflated sync times by tens of seconds; the clock now waits for work in flight (promises, compression jobs, short timers). Numbers from before that fix are not comparable and are not kept.

## Not measured (summary)

Real radio throughput and latency on macOS, iOS and Android; loss; 3 to 4 centrals; coexistence with Wi-Fi; backgrounding and App Nap; CPU and battery; the 30-minute soak from the plan (the simulator can run one, but it would test the simulator's assumptions, not hardware; the keep-alive test covers ten idle virtual minutes); scan and connect timing on real stacks.
