/**
 * Value comparison and equality with MongoDB's semantics, shared by the filter
 * evaluator and the sort comparator.
 */

import { isPlainObject } from './paths.js';

/**
 * BSON type ordering, which is what Mongo sorts by when a field holds mixed types
 * or is missing from some documents. Only the ranks this application can actually
 * produce are modelled; anything unrecognized sorts with objects.
 *
 * Missing and null share rank 1 deliberately: to a sort, an absent field and an
 * explicit null are the same value. (To `$exists` they are not — see pathExists.)
 */
function typeRank(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  if (Array.isArray(value)) return 5;
  if (value instanceof Date) return 6;
  if (typeof value === 'boolean') return 7;
  return 4;
}

function normalizeDate(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

/** Deep equality with Mongo's leniency: dates equal by instant, numbers by value. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  const aDate = a instanceof Date;
  const bDate = b instanceof Date;
  if (aDate || bDate) {
    const at = aDate ? a.getTime() : typeof a === 'string' ? Date.parse(a) : NaN;
    const bt = bDate ? b.getTime() : typeof b === 'string' ? Date.parse(b) : NaN;
    return Number.isFinite(at) && Number.isFinite(bt) && at === bt;
  }

  // A missing field and an explicit null compare equal, which is what makes
  // `{ field: null }` match documents that never had the field.
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && valuesEqual(a[key], b[key]));
  }

  return false;
}

/**
 * Total order over values: negative when a sorts first. Values of different types
 * order by type rank, which is how Mongo keeps a sort total over heterogeneous data
 * rather than leaving it undefined.
 */
export function compareValues(a: unknown, b: unknown): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;

  const left = normalizeDate(a);
  const right = normalizeDate(b);

  if (left === null || left === undefined) return 0;

  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) {
      const item = compareValues(left[i], right[i]);
      if (item !== 0) return item;
    }
    return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
  }
  return 0;
}

/**
 * Comparison for the ordering operators (`$gt`, `$lte`, …). Unlike compareValues
 * this refuses to order across types: Mongo's range operators only match values of
 * the same type as the operand, so `{ n: { $gt: 5 } }` does not match `n: "abc"`.
 * Null is returned for "not comparable", which the caller reads as "no match".
 */
export function orderingCompare(a: unknown, b: unknown): number | null {
  if (a === undefined || a === null || b === undefined || b === null) return null;

  const left = normalizeDate(a);
  const right = normalizeDate(b);

  // A date operand still compares against a stored ISO string: values crossing an
  // API boundary arrive as strings, and refusing them would silently drop matches.
  if (a instanceof Date && typeof b === 'string') {
    const parsed = Date.parse(b);
    return Number.isFinite(parsed) ? numeric(a.getTime(), parsed) : null;
  }
  if (b instanceof Date && typeof a === 'string') {
    const parsed = Date.parse(a);
    return Number.isFinite(parsed) ? numeric(parsed, b.getTime()) : null;
  }

  if (typeof left === 'number' && typeof right === 'number') return numeric(left, right);
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  return null;
}

function numeric(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
