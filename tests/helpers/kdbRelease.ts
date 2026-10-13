/**
 * Where the KDB tests find the server and the client: the released ones this checkout pins.
 *
 * The client is the `@kdb/client` package from package.json; the server is that same release's
 * `kdb-service`, fetched by `npm run kdb:fetch` into `.kdb/<version>/`. Nothing points at a KDB
 * source tree, so what is tested is what gets deployed. KDB_SERVICE_BIN and KDB_CLIENT_MODULE
 * still override both, for trying a KDB build before it is released.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pinnedKdbVersion } from '../../scripts/fetch-kdb.ts';

export const KDB_VERSION = pinnedKdbVersion();
export const SERVICE_BIN =
  process.env.KDB_SERVICE_BIN ?? join(resolve(import.meta.dirname, '../..'), '.kdb', KDB_VERSION ?? 'none', 'kdb-service');
export const CLIENT_MODULE = process.env.KDB_CLIENT_MODULE ?? '@kdb/client';

function clientResolves(): boolean {
  try {
    import.meta.resolve(CLIENT_MODULE);
    return CLIENT_MODULE.startsWith('@') || existsSync(CLIENT_MODULE);
  } catch {
    return false;
  }
}

/** Why the KDB tests cannot run here, or undefined when they can. */
export const kdbUnavailable: string | undefined = !KDB_VERSION && !process.env.KDB_SERVICE_BIN
  ? '@kdb/client is not installed - npm install, then npm run kdb:fetch'
  : !existsSync(SERVICE_BIN)
  ? `no kdb-service v${KDB_VERSION} at ${SERVICE_BIN} - run npm run kdb:fetch`
  : !clientResolves()
    ? `cannot load ${CLIENT_MODULE} - run npm install`
    : undefined;
