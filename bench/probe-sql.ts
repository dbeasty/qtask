/**
 * Diagnostic: times the SQL the KDB store's pushdown generates for qtask's hot filters, straight
 * through @kdb/client, to separate server time from the store's in-process work.
 *
 *   KDB_ADDR=tcp://127.0.0.1:8412 KDB_NAMESPACE_PREFIX=qtask/docs BENCH_INDEX=... tsx bench/probe-sql.ts
 */

import { readFileSync } from 'node:fs';
import type { DatasetIndex } from './lib/dataset.ts';

const { connect } = (await import(process.env.KDB_CLIENT_MODULE ?? '@kdb/client')) as {
  connect: (addr: string, o: object) => Promise<{ queryRaw(ns: string, sql: string, args?: unknown[]): Promise<{ rows: string[][] }>; close(): Promise<void> }>;
};
const ns = process.env.KDB_NAMESPACE_PREFIX ?? 'qtask/docs';
const client = await connect(process.env.KDB_ADDR ?? 'tcp://127.0.0.1:8412', {});
const index = JSON.parse(readFileSync(process.env.BENCH_INDEX!, 'utf8')) as DatasetIndex;
const u = index.users[1]!;

async function time(label: string, sql: string, args: unknown[]): Promise<void> {
  const xs: number[] = [];
  let rows = 0;
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    rows = (await client.queryRaw(ns, sql, args)).rows.length;
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  console.log(`${label.padEnd(56)} rows ${String(rows).padStart(5)}  median ${xs[2]!.toFixed(1)} ms`);
}

await time('COUNT(*)', 'SELECT COUNT(*) FROM docs', []);
await time('projects userId = ?', 'SELECT kdb_id FROM docs WHERE _c = ? AND userId = ?', ['projects', u.id]);
await time('projects collaborators.userId = ?', 'SELECT kdb_id FROM docs WHERE _c = ? AND collaborators.userId = ?', ['projects', u.id]);
await time('projects (userId = ? OR collaborators.userId = ?)', 'SELECT kdb_id FROM docs WHERE _c = ? AND ((userId = ?) OR (collaborators.userId = ?))', ['projects', u.id, u.id]);
await time('  same, _doc', 'SELECT kdb_id, _doc FROM docs WHERE _c = ? AND ((userId = ?) OR (collaborators.userId = ?))', ['projects', u.id, u.id]);
await time('users email = ?', 'SELECT kdb_id FROM docs WHERE _c = ? AND email = ?', ['users', u.email]);
await time('tasks userId = ?', 'SELECT kdb_id FROM docs WHERE _c = ? AND userId = ?', ['tasks', u.id]);
await time('  same, _doc', 'SELECT kdb_id, _doc FROM docs WHERE _c = ? AND userId = ?', ['tasks', u.id]);
await time('tasks (userId = ? OR projectIds IN (...))', `SELECT kdb_id FROM docs WHERE _c = ? AND ((userId = ?) OR (projectIds IN (${u.ownProjectIds.map(() => '?').join(', ')})))`, ['tasks', u.id, ...u.ownProjectIds]);
await time('_c = tasks (whole collection ids)', 'SELECT kdb_id FROM docs WHERE _c = ?', ['tasks']);
await client.close();
