/**
 * A deliberately tiny stand-in for the Phase 2 sync engine, used only by the LAN
 * transport tests and perf runs: last-writer-wins documents with a hybrid logical
 * clock, a digest exchange when a link comes up, and gossip of accepted changes to
 * the other links. It exercises the transport exactly the way the real engine will
 * (auto-sync on peer-up, whole messages, many peers) without depending on it.
 */

import type { PeerLinkTransport, SyncPeerLink } from '../../src/sync/transport-contract.ts';

export interface LwwDoc {
  id: string;
  /** Sortable clock: "<wallMs padded>:<counter padded>:<node>". */
  hlc: string;
  value: unknown;
}

type Msg =
  | { t: 'digest'; d: Array<[string, string]> }
  | { t: 'docs'; docs: LwwDoc[]; seq?: number };

export class LwwReplica {
  readonly docs = new Map<string, LwwDoc>();
  private counter = 0;
  private lastMs = 0;
  private links = new Map<string, SyncPeerLink>();
  onApplied: ((doc: LwwDoc, from: string) => void) | null = null;
  stats = { docsReceived: 0, docsSent: 0, digestsReceived: 0, syncRounds: 0 };

  constructor(
    readonly nodeId: string,
    transport: PeerLinkTransport,
    private readonly batch = 500,
  ) {
    transport.onPeerUp((l) => this.attach(l));
    transport.onPeerDown((id) => this.links.delete(id));
  }

  private tick(): string {
    const now = Date.now();
    if (now > this.lastMs) {
      this.lastMs = now;
      this.counter = 0;
    } else this.counter++;
    return `${String(this.lastMs).padStart(15, '0')}:${String(this.counter).padStart(6, '0')}:${this.nodeId}`;
  }

  put(id: string, value: unknown): LwwDoc {
    const doc = { id, hlc: this.tick(), value };
    this.docs.set(id, doc);
    this.broadcast([doc], null);
    return doc;
  }

  /** Seeds many docs without broadcasting (initial-sync setup). */
  seed(n: number, prefix: string, makeValue: (i: number) => unknown): void {
    for (let i = 0; i < n; i++) this.docs.set(`${prefix}${i}`, { id: `${prefix}${i}`, hlc: this.tick(), value: makeValue(i) });
  }

  private attach(link: SyncPeerLink): void {
    this.links.set(link.peerId, link);
    link.onMessage((m) => this.onMessage(link, m));
    this.stats.syncRounds++;
    const d: Array<[string, string]> = [];
    for (const doc of this.docs.values()) d.push([doc.id, doc.hlc]);
    void link.send(Buffer.from(JSON.stringify({ t: 'digest', d } satisfies Msg))).catch(() => undefined);
  }

  private async onMessage(link: SyncPeerLink, raw: Uint8Array): Promise<void> {
    const msg = JSON.parse(Buffer.from(raw).toString('utf8')) as Msg;
    if (msg.t === 'digest') {
      this.stats.digestsReceived++;
      const theirs = new Map(msg.d);
      const out: LwwDoc[] = [];
      for (const doc of this.docs.values()) {
        const h = theirs.get(doc.id);
        if (h === undefined || h < doc.hlc) out.push(doc);
      }
      for (let i = 0; i < out.length; i += this.batch) {
        const docs = out.slice(i, i + this.batch);
        this.stats.docsSent += docs.length;
        await link.send(Buffer.from(JSON.stringify({ t: 'docs', docs } satisfies Msg)));
      }
    } else if (msg.t === 'docs') {
      const accepted: LwwDoc[] = [];
      for (const doc of msg.docs) {
        this.stats.docsReceived++;
        const cur = this.docs.get(doc.id);
        if (!cur || cur.hlc < doc.hlc) {
          this.docs.set(doc.id, doc);
          accepted.push(doc);
          this.onApplied?.(doc, link.peerId);
        }
      }
      if (accepted.length) this.broadcast(accepted, link.peerId);
    }
  }

  private broadcast(docs: LwwDoc[], except: string | null): void {
    const buf = Buffer.from(JSON.stringify({ t: 'docs', docs } satisfies Msg));
    for (const [id, l] of this.links) if (id !== except) void l.send(buf).catch(() => undefined);
  }
}
