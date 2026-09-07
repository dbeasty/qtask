/**
 * Applies the MongoDB update-operator subset this application uses, in process.
 *
 * Supported: $set, $unset, $inc, $push (with $each), $pull, $addToSet, $min, $max,
 * and whole-document replacement (an update with no operator keys). An unsupported
 * operator throws — an update that silently does nothing is worse than one that
 * fails, because the caller reports success either way.
 */

import { matchesFilter, type Filter } from './filter.js';
import { valuesEqual, orderingCompare } from './compare.js';
import { getPath, setPath, unsetPath, isPlainObject, type Doc } from './paths.js';

export type Update = Record<string, unknown>;

const SUPPORTED = new Set(['$set', '$unset', '$inc', '$push', '$pull', '$addToSet', '$min', '$max', '$setOnInsert']);

export function isOperatorUpdate(update: Update): boolean {
  return Object.keys(update).some((key) => key.startsWith('$'));
}

/**
 * Returns a new document with the update applied; the input is not mutated, so a
 * caller holding the pre-update document (to compare, or to roll back) still has it.
 *
 * `isInsert` drives $setOnInsert, which applies only when the update is creating a
 * document through an upsert.
 */
export function applyUpdate(doc: Doc, update: Update, isInsert = false): Doc {
  if (!isOperatorUpdate(update)) {
    // Whole-document replacement keeps the _id: Mongo refuses to change it, and a
    // replacement that dropped it would orphan the document.
    const replaced: Doc = structuredCloneDoc(update);
    if (doc._id !== undefined) replaced._id = doc._id;
    return replaced;
  }

  const next = structuredCloneDoc(doc);

  for (const [operator, payload] of Object.entries(update)) {
    if (!operator.startsWith('$')) {
      throw new Error(`Mixed operator and plain field in update: ${operator}`);
    }
    if (!SUPPORTED.has(operator)) {
      throw new Error(`Unsupported update operator: ${operator}`);
    }
    applyOperator(next, operator, payload as Record<string, unknown>, isInsert);
  }

  return next;
}

function applyOperator(doc: Doc, operator: string, payload: Record<string, unknown>, isInsert: boolean): void {
  switch (operator) {
    case '$setOnInsert':
      if (!isInsert) return;
    // falls through — on insert it behaves exactly as $set
    case '$set':
      for (const [path, value] of Object.entries(payload)) {
        // Mongoose drops undefined rather than storing it; matching that keeps a
        // `{ $set: { x: undefined } }` from creating a key Mongo would not have.
        if (value === undefined) continue;
        setPath(doc, path, value);
      }
      return;

    case '$unset':
      for (const path of Object.keys(payload)) unsetPath(doc, path);
      return;

    case '$inc':
      for (const [path, delta] of Object.entries(payload)) {
        const current = getPath(doc, path);
        const base = typeof current === 'number' ? current : 0;
        setPath(doc, path, base + Number(delta));
      }
      return;

    case '$min':
    case '$max':
      for (const [path, operand] of Object.entries(payload)) {
        const current = getPath(doc, path);
        if (current === undefined) {
          setPath(doc, path, operand);
          continue;
        }
        const cmp = orderingCompare(operand, current);
        if (cmp === null) continue;
        const wins = operator === '$min' ? cmp < 0 : cmp > 0;
        if (wins) setPath(doc, path, operand);
      }
      return;

    case '$push':
      for (const [path, operand] of Object.entries(payload)) {
        const target = ensureArray(doc, path);
        if (isPlainObject(operand) && '$each' in operand) {
          const each = operand.$each;
          if (!Array.isArray(each)) throw new Error('$each expects an array');
          target.push(...each);
          applyPushModifiers(doc, path, target, operand);
        } else {
          target.push(operand);
        }
        setPath(doc, path, target);
      }
      return;

    case '$addToSet':
      for (const [path, operand] of Object.entries(payload)) {
        const target = ensureArray(doc, path);
        const additions =
          isPlainObject(operand) && '$each' in operand && Array.isArray(operand.$each)
            ? operand.$each
            : [operand];
        for (const item of additions) {
          if (!target.some((existing) => valuesEqual(existing, item))) target.push(item);
        }
        setPath(doc, path, target);
      }
      return;

    case '$pull':
      for (const [path, criteria] of Object.entries(payload)) {
        const current = getPath(doc, path);
        if (!Array.isArray(current)) continue;
        const kept = current.filter((element) => !pullMatches(element, criteria));
        setPath(doc, path, kept);
      }
      return;

    default:
      throw new Error(`Unsupported update operator: ${operator}`);
  }
}

function applyPushModifiers(doc: Doc, path: string, target: unknown[], operand: Record<string, unknown>): void {
  if ('$slice' in operand) {
    const slice = Number(operand.$slice);
    if (Number.isInteger(slice)) {
      const sliced = slice >= 0 ? target.slice(0, slice) : target.slice(slice);
      target.length = 0;
      target.push(...sliced);
    }
  }
}

function ensureArray(doc: Doc, path: string): unknown[] {
  const current = getPath(doc, path);
  if (Array.isArray(current)) return current;
  return [];
}

/**
 * `$pull` takes either a value to match by equality or a filter to match elements
 * against — including bare operator objects like `{ $in: [...] }`, which apply to
 * the element itself rather than to a field of it.
 */
function pullMatches(element: unknown, criteria: unknown): boolean {
  if (isPlainObject(criteria)) {
    const keys = Object.keys(criteria);
    if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
      return matchesFilter({ __value: element } as Doc, { __value: criteria } as Filter);
    }
    if (isPlainObject(element)) return matchesFilter(element, criteria as Filter);
    return false;
  }
  return valuesEqual(element, criteria);
}

/**
 * Deep copy that preserves Date instances. structuredClone would do it, but it
 * throws on values this codebase legitimately stores (undefined inside objects is
 * fine, but functions and class instances from callers are not worth the risk),
 * so the traversal is explicit.
 */
export function structuredCloneDoc<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => structuredCloneDoc(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = structuredCloneDoc(item);
  }
  return out as T;
}
