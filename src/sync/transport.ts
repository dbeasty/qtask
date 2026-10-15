/**
 * Transports. `SyncTransport` itself is declared in types.ts; these are the two
 * built-in implementations. Phase 3 adds Wi-Fi and Bluetooth by implementing the same
 * three methods over their own framing.
 */

import type { SyncService } from './engine.js';
import type {
  HelloRequest,
  HelloResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncTransport,
} from './types.js';

export class SyncTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true
  ) {
    super(message);
    this.name = 'SyncTransportError';
  }
}

/**
 * In-process transport to a `SyncService`. Every message is round-tripped through
 * JSON, so anything that would not survive a real wire (a Date left in a document, a
 * shared object reference) fails here too. `before` lets a test inject latency or
 * failures.
 */
export class LoopbackTransport implements SyncTransport {
  readonly kind = 'loopback';
  /** Bytes sent and received, for the benchmarks. */
  bytesOut = 0;
  bytesIn = 0;
  requests = 0;

  constructor(
    private readonly service: SyncService,
    private readonly before?: (op: 'hello' | 'pull' | 'push') => Promise<void> | void
  ) {}

  private async call<Req, Res>(
    op: 'hello' | 'pull' | 'push',
    req: Req,
    fn: (req: Req) => Promise<Res>
  ): Promise<Res> {
    await this.before?.(op);
    const wireReq = JSON.stringify(req);
    this.bytesOut += wireReq.length;
    this.requests += 1;
    const res = JSON.stringify(await fn(JSON.parse(wireReq) as Req));
    this.bytesIn += res.length;
    return JSON.parse(res) as Res;
  }

  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.call('hello', req, (r) => this.service.hello(r));
  }
  pull(req: PullRequest): Promise<PullResponse> {
    return this.call('pull', req, (r) => this.service.pull(r));
  }
  push(req: PushRequest): Promise<PushResponse> {
    return this.call('push', req, (r) => this.service.push(r));
  }
}

export interface HttpTransportOptions {
  /** Origin of the hub, e.g. `https://qtask.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token for the signed-in account. */
  getToken: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Path prefix of the hub routes. */
  prefix?: string;
  timeoutMs?: number;
}

/** Talks to the cloud hub's `/api/sync` routes. */
export class HttpSyncTransport implements SyncTransport {
  readonly kind = 'http';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post<Res>(path: string, body: unknown): Promise<Res> {
    const token = await this.options.getToken();
    if (!token) throw new SyncTransportError('not signed in', 401, false);
    const base = this.options.baseUrl.replace(/\/$/, '');
    const url = `${base}${this.options.prefix ?? '/api/sync'}/${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new SyncTransportError(`network error: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new SyncTransportError(`hub responded ${response.status}`, response.status, retryable);
    }
    return (await response.json()) as Res;
  }

  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.post('hello', req);
  }
  pull(req: PullRequest): Promise<PullResponse> {
    return this.post('pull', req);
  }
  push(req: PushRequest): Promise<PushResponse> {
    return this.post('push', req);
  }
}
