/**
 * Translates the part of a Mongo-style filter that KDB SQL can evaluate into a
 * `WHERE` fragment, so the server narrows a scan instead of shipping the whole
 * collection across the wire.
 *
 * The contract is one-sided and that is what makes it safe: the fragment must match
 * a *superset* of what the filter matches. The caller still runs every returned
 * document through the shared query engine (checked against a real mongod in
 * tests/data-query-parity.test.ts), so pushdown can make a query cheaper but cannot
 * change its answer — unless the SQL wrongly excludes a document the filter wants,
 * which is the one failure tests/data-kdb-pushdown.test.ts exists to catch.
 *
 * Anything not understood is simply left out, never guessed at:
 *  - `null` / missing-field matching (`field: null` matches an absent field in Mongo,
 *    where SQL `= NULL` is never true), `$ne`, `$nin`, `$not`, `$nor`, `$exists`,
 *    `$regex`, `$elemMatch`, `$size` and `$all` stay in process;
 *  - an `$or` is pushed only when every branch yields a constraint, since one
 *    unconstrained branch makes the whole disjunction unconstrained.
 */

import { toDocumentUuid } from './ids.js';
import type { Filter } from '../types.js';

export interface Where {
  sql: string;
  args: unknown[];
}

/** Dotted identifiers only. Numeric segments (array positions) and anything that
 *  could be read as SQL syntax are not pushed. */
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const RANGE_OPERATORS: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

/** A scalar KDB compares the way the query engine does, as a SQL parameter. Dates
 *  are stored as fixed-width ISO strings, so comparing the ISO form orders by instant. */
function toParam(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (value instanceof Date && !Number.isNaN(value.getTime())) return { ok: true, value: value.toISOString() };
  return { ok: false };
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function column(path: string): string | null {
  return PATH_RE.test(path) ? path : null;
}

function fieldClauses(path: string, condition: unknown): Where[] {
  if (path === '_id') {
    // `_id` is the document identity; `kdb_id` is the indexed form of it.
    return idClauses(condition);
  }
  const col = column(path);
  if (!col) return [];

  if (!isOperatorObject(condition)) {
    const param = toParam(condition);
    return param.ok ? [{ sql: `${col} = ?`, args: [param.value] }] : [];
  }

  const out: Where[] = [];
  for (const [operator, operand] of Object.entries(condition)) {
    if (operator === '$eq') {
      const param = toParam(operand);
      if (param.ok) out.push({ sql: `${col} = ?`, args: [param.value] });
    } else if (operator === '$in' && Array.isArray(operand) && operand.length > 0) {
      const params = operand.map(toParam);
      // A null (or otherwise unpushable) member could match an absent field, which
      // SQL IN cannot express, so any such member keeps the whole clause in process.
      if (params.every((p) => p.ok)) {
        const values = params.map((p) => (p as { ok: true; value: unknown }).value);
        out.push({ sql: `${col} IN (${values.map(() => '?').join(', ')})`, args: values });
      }
    } else if (operator in RANGE_OPERATORS) {
      const param = toParam(operand);
      if (param.ok) out.push({ sql: `${col} ${RANGE_OPERATORS[operator]} ?`, args: [param.value] });
    }
  }
  return out;
}

function idClauses(condition: unknown): Where[] {
  if (typeof condition === 'string') {
    return [{ sql: 'kdb_id = ?', args: [toDocumentUuid(condition)] }];
  }
  if (isOperatorObject(condition)) {
    const out: Where[] = [];
    if (typeof condition.$eq === 'string') out.push({ sql: 'kdb_id = ?', args: [toDocumentUuid(condition.$eq)] });
    const members = condition.$in;
    if (Array.isArray(members) && members.length > 0 && members.every((m) => typeof m === 'string')) {
      const ids = (members as string[]).map(toDocumentUuid);
      out.push({ sql: `kdb_id IN (${ids.map(() => '?').join(', ')})`, args: ids });
    }
    return out;
  }
  return [];
}

function conjunction(parts: Where[]): Where | null {
  if (parts.length === 0) return null;
  return {
    sql: parts.length === 1 ? parts[0].sql : parts.map((p) => `(${p.sql})`).join(' AND '),
    args: parts.flatMap((p) => p.args),
  };
}

/** The pushable constraint of a filter, or null when none of it can be pushed. */
export function buildWhere(filter: Filter): Where | null {
  const parts: Where[] = [];

  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(condition)) {
      for (const sub of condition) {
        const where = buildWhere(sub as Filter);
        if (where) parts.push(where);
      }
    } else if (key === '$or' && Array.isArray(condition) && condition.length > 0) {
      const branches = condition.map((sub) => buildWhere(sub as Filter));
      if (branches.every((branch): branch is Where => branch !== null)) {
        parts.push({
          sql: branches.map((b) => `(${b.sql})`).join(' OR '),
          args: branches.flatMap((b) => b.args),
        });
      }
    } else if (!key.startsWith('$')) {
      const clauses = fieldClauses(key, condition);
      const where = conjunction(clauses);
      if (where) parts.push(where);
    }
  }

  return conjunction(parts);
}
