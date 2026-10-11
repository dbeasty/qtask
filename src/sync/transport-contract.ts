// Named PeerLinkTransport (not SyncTransport) because the engine's own SyncTransport in
// types.ts is the request/response interface (hello/pull/push). rpc.ts bridges the two.
/**
 * The minimal transport-side contract the sync engine (Phase 2) is coded against.
 *
 * Phase 2 owns change tracking and merge; it needs from a transport only: "a paired
 * peer is reachable", "send this opaque message to it", "a message arrived", "it is
 * gone". Everything else (discovery, pairing, TLS, framing, reconnect) is the
 * transport's job. Phase 3 (LAN) and Phase 4 (BLE) both implement this.
 *
 * NOTE: declared here by the Phase 3 work because Phase 2's own README/contract had
 * not landed when this was written. When it does, reconcile by making this file
 * re-export Phase 2's types (the shapes are deliberately small so that is a rename).
 */

export type TransportKind = 'lan' | 'ble' | 'cloud';

/** One live, authenticated, ordered, message-oriented connection to one paired peer. */
export interface SyncPeerLink {
  /** Stable id of the remote device (hash of its identity public key). */
  readonly peerId: string;
  readonly peerName: string;
  readonly transport: TransportKind;
  /** Sends one whole message. Resolves when the transport has accepted it (flow-controlled). */
  send(message: Uint8Array): Promise<void>;
  /** At most one handler; messages arriving before it is set are buffered. */
  onMessage(handler: (message: Uint8Array) => void | Promise<void>): void;
  onClose(handler: (reason?: Error) => void): void;
  close(): void;
}

export interface PeerLinkTransport {
  readonly kind: TransportKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Called whenever a paired peer becomes reachable (new link). The engine should
   * start a sync round on it: this is the "auto-sync when a paired peer appears" hook.
   */
  onPeerUp(handler: (link: SyncPeerLink) => void): void;
  /** Called when a link closes. */
  onPeerDown(handler: (peerId: string, reason?: Error) => void): void;
  /** Currently connected links. */
  links(): SyncPeerLink[];
}
