/**
 * A stand-in for @kdb/client that records how the store connects and does nothing else, for
 * tests/data-kdb-connect.test.ts. Every call succeeds with an empty answer.
 */

export const calls: Array<{ addr: string; options: unknown }> = [];

export async function connect(addr: string, options: unknown) {
  calls.push({ addr, options });
  const empty = { columns: [], rows: [] };
  return {
    upsert: async () => '',
    queryRaw: async () => empty,
    queryRawPages: async function* () {
      yield empty;
    },
    exec: async () => undefined,
    get: async () => ({ body: null, commit: '' }),
    getWithHash: async () => ({ body: null, contentHash: '' }),
    replace: async () => '',
    replaceIf: async () => '',
    delete: async () => '',
    close: async () => undefined,
  };
}
