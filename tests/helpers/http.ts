/**
 * supertest, served from one HTTP server per app, bound to 127.0.0.1.
 *
 *   import request, { serve } from './helpers/http.js';
 *   app = await serve(await createApp({ connect: true, startWorker: false }));
 *   await request(app).get('/api/health').expect(200);
 *
 * Use this instead of importing supertest directly. Handed an app, supertest starts a fresh
 * server for every request with `app.listen(0)` - on the wildcard address, `[::]` - and then
 * sends the request to `127.0.0.1:<port>`. On macOS a listener bound to 127.0.0.1 itself is
 * allowed to share a port with a wildcard one and wins every connection to 127.0.0.1, and the
 * kernel will hand a wildcard `listen(0)` a port that another process already holds on
 * 127.0.0.1. Under a parallel run there are plenty of those (kdb-service, mongod, other test
 * files' and other worktrees' servers), so now and then a request lands on a stranger: a
 * kdb-service hangs up (`socket hang up`, ECONNRESET), another HTTP server answers with its
 * own status (a 404 in a millisecond). Seen with `lsof` at the moment of failure: our
 * `*:61429` beside a kdb-service on `127.0.0.1:61429`. Keep-alive is not the cause - supertest
 * sends every request on a fresh connection (`Connection: close`).
 *
 * Binding to 127.0.0.1 makes the kernel refuse a port someone else holds there (EADDRINUSE,
 * so `listen(0)` picks another), and one server per app for the whole file, rather than one
 * per request, also stops the suite churning through a few thousand ports a run. Each server
 * is closed once the file's tests are done.
 */

import { createServer, type RequestListener, type Server } from 'node:http';
import { after } from 'node:test';
import supertest from 'supertest';

export type { Response, Test } from 'supertest';

const servers = new Map<RequestListener, Server>();

/** Starts the app's server. Returns the app, so it wraps the line that creates it. */
export async function serve<App extends RequestListener>(app: App): Promise<App> {
  if (servers.has(app)) return app;
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.set(app, server);
  return app;
}

type Target = RequestListener | Server | string;

function serverFor(app: Target): Server | string {
  if (typeof app !== 'function') return app;
  const server = servers.get(app);
  // Falling back to supertest's own per-request server would bring the flake back quietly.
  if (!server) throw new Error('request(app) on an app that was never served - wrap its creation in serve()');
  return server;
}

const request = Object.assign((app: Target) => supertest(serverFor(app)), {
  agent: (app: Target) => supertest.agent(serverFor(app)),
});

export default request;

after(async () => {
  await Promise.all(
    [...servers.values()].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});
