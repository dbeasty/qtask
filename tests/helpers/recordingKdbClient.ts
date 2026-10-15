/**
 * A stand-in for @kdb/client that records how the store connects and the SQL it sends, and does
 * nothing else, for tests/data-kdb-connect.test.ts. Every call succeeds with an empty answer.
 */

export const calls: Array<{ addr: string; options: unknown }> = [];
/** Every SQL statement the store sent, in order. */
export const statements: string[] = [];

export async function connect(addr: string, options: unknown) {
  calls.push({ addr, options });
  const empty = { columns: [], rows: [] };
  return {
    upsert: async () => '',
    queryRaw: async (_ns: string, sql: string) => {
      statements.push(sql);
      return empty;
    },
    queryRawPages: async function* (_ns: string, sql: string) {
      statements.push(sql);
      yield empty;
    },
    commit: async () => '',
    exec: async () => undefined,
    get: async () => ({ body: null, commit: '' }),
    getWithHash: async () => ({ body: null, contentHash: '' }),
    replace: async () => '',
    replaceIf: async () => '',
    delete: async () => '',
    close: async () => undefined,
  };
}
