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

/** Most branches a disjunction is split into; past this, one query with an OR is cheaper. */
const MAX_UNION_BRANCHES = 8;

/**
 * The filter as alternatives to query separately and union, or null to query it whole.
 *
 * KDB (to v0.8.0) serves a query from an index only through a top-level AND condition, so a
 * `$or` - which is how qtask states access ("mine, or shared with me, or in my projects") -
 * makes it scan the whole namespace however well each branch is indexed: 338 ms where either
 * branch alone took under 9 ms on 8.5k documents. Asked one branch at a time, each is a lookup.
 *
 * Split only where it helps: one `$or` (top level, or inside a top-level `$and`) of 2 to
 * MAX_UNION_BRANCHES branches, every branch pushable with an indexed condition (`indexed`), and
 * nothing outside the `$or` indexed already (then that index serves the whole query and one
 * round trip beats several). Each alternative is the rest of the filter plus one branch, so the
 * union is exactly the `$or`; the caller still re-checks every document, and dedupes by id.
 */
export function unionBranches(filter: Filter, indexed: (path: string) => boolean): Filter[] | null {
  let disjunction: Filter[] | null = null;
  let rest: Filter = {};
  let restAnd: Filter[] = [];
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(condition) && disjunction === null) {
      disjunction = condition as Filter[];
    } else if (key === '$and' && Array.isArray(condition)) {
      for (const sub of condition as Filter[]) {
        const keys = Object.keys(sub);
        if (disjunction === null && keys.length === 1 && keys[0] === '$or' && Array.isArray(sub.$or)) {
          disjunction = sub.$or as Filter[];
        } else {
          restAnd.push(sub);
        }
      }
    } else {
      rest = { ...rest, [key]: condition };
    }
  }
  if (!disjunction || disjunction.length < 2 || disjunction.length > MAX_UNION_BRANCHES) return null;
  const restFilter: Filter = restAnd.length > 0 ? { ...rest, $and: restAnd } : rest;
  if (hasIndexedCondition(restFilter, indexed)) return null;
  if (!disjunction.every((branch) => hasIndexedCondition(branch, indexed))) return null;
  return disjunction.map((branch) => ({ ...rest, $and: [...restAnd, branch] }));
}

/** Whether pushing `filter` down yields a condition an index can serve on its own: an equality,
 *  IN or range on an indexed path (or on the document id), at the top level of the filter. */
function hasIndexedCondition(filter: Filter, indexed: (path: string) => boolean): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(condition)) {
      if ((condition as Filter[]).some((sub) => hasIndexedCondition(sub, indexed))) return true;
    } else if (!key.startsWith('$') && (key === '_id' || indexed(key)) && fieldClauses(key, condition).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * How the schema stores a path, as far as exact translation cares: `text` for a string, an id or
 * a boolean held directly; `textList` for such values reached through an array (an array of
 * strings, or a field of an array of sub-documents), which SQL and Mongo both match per element.
 * Anything else - numbers, dates, mixed or nested values - is `other`, and never exact.
 */
export type PathKind = 'text' | 'textList' | 'other';

/**
 * The filter as SQL that matches exactly the documents the filter matches, or null when that
 * cannot be promised. buildWhere only promises a superset, which is all a scan needs because the
 * engine re-checks each document; a count asked of the server has nobody to re-check it.
 *
 * Exact here means: equality or `$in` of strings or booleans on a `text`/`textList` path (Mongo
 * matches an array if any element matches, as KDB's multikey comparison does; a missing field
 * matches neither), the document id, and `$and`/`$or` of exact parts. Everything else - ranges,
 * numbers (formatting), dates, `null`, `$exists`, `$ne`, `$regex`... - is refused, not guessed.
 */
export function exactWhere(filter: Filter, kindOf: (path: string) => PathKind): Where | null {
  const parts: Where[] = [];
  for (const [key, condition] of Object.entries(filter)) {
    if ((key === '$and' || key === '$or') && Array.isArray(condition) && condition.length > 0) {
      const subs = (condition as Filter[]).map((sub) => exactWhere(sub, kindOf));
      if (!subs.every((sub): sub is Where => sub !== null)) return null;
      parts.push({
        sql: subs.map((sub) => `(${sub.sql})`).join(key === '$and' ? ' AND ' : ' OR '),
        args: subs.flatMap((sub) => sub.args),
      });
    } else if (key === '_id') {
      const exactId =
        typeof condition === 'string' ||
        (isOperatorObject(condition) &&
          Object.keys(condition).every((op) => op === '$eq' || op === '$in') &&
          (condition.$eq === undefined || typeof condition.$eq === 'string') &&
          (condition.$in === undefined || (Array.isArray(condition.$in) && condition.$in.length > 0 && condition.$in.every((m) => typeof m === 'string'))));
      if (!exactId) return null;
      const where = conjunction(idClauses(condition));
      if (!where) return null;
      parts.push(where);
    } else if (key.startsWith('$')) {
      return null;
    } else {
      const where = exactField(key, condition, kindOf(key));
      if (!where) return null;
      parts.push(where);
    }
  }
  // An empty filter matches every document: no clause, the caller's `_c = ?` alone.
  return parts.length === 0 ? { sql: '', args: [] } : conjunction(parts);
}

function exactField(path: string, condition: unknown, kind: PathKind): Where | null {
  const col = column(path);
  if (!col || kind === 'other') return null;
  const isText = (v: unknown) => typeof v === 'string' || typeof v === 'boolean';
  if (isText(condition)) return { sql: `${col} = ?`, args: [condition] };
  if (!isOperatorObject(condition)) return null;
  const clauses: Where[] = [];
  for (const [operator, operand] of Object.entries(condition)) {
    if (operator === '$eq' && isText(operand)) {
      clauses.push({ sql: `${col} = ?`, args: [operand] });
    } else if (operator === '$in' && Array.isArray(operand) && operand.length > 0 && operand.every(isText)) {
      clauses.push({ sql: `${col} IN (${operand.map(() => '?').join(', ')})`, args: operand });
    } else {
      return null;
    }
  }
  return conjunction(clauses);
}
