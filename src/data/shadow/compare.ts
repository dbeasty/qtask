/**
 * Comparing a primary read against the shadow's answer.
 *
 * Two things make this more than a deep-equality check.
 *
 * **Some differences are expected and mean nothing.** Shadow writes replay the
 * operation rather than copying the result, so each store stamps its own
 * `updatedAt`. Reporting that as divergence would bury the real signal under one
 * false positive per update. The ignore list is deliberately tiny and explicit:
 * every entry is a claim that the field cannot carry a real bug, and each one
 * should be argued for rather than added out of convenience.
 *
 * **Reports must not carry user data.** A divergence report names the collection,
 * the operation, the document ids and the *field names* that differ — never the
 * values. Divergence reports go to ordinary logs, and the documents involved hold
 * email addresses, task titles and comment bodies. Knowing that `title` differs on
 * three documents is enough to investigate; the log is not the place to learn what
 * the titles were.
 */

import { valuesEqual } from '../query/compare.js';
import type { Doc } from '../types.js';

/** Fields whose difference is structural, not a bug. See the module comment. */
const IGNORED_FIELDS = new Set([
  // Each store stamps its own on an update, because the shadow replays the
  // operation rather than copying the primary's result.
  'updatedAt',
]);

export interface Divergence {
  collection: string;
  operation: string;
  /** The filter and options, for reproducing the query. Values here are the
   *  caller's own query terms, which are already in logs via request paths. */
  query: unknown;
  kind: 'count' | 'order' | 'unordered' | 'missing' | 'unexpected' | 'fields' | 'value';
  summary: string;
  /** Document ids involved, capped. Ids are opaque and safe to log. */
  ids?: string[];
  /** Field names that differ — names only, never values. */
  fields?: string[];
}

const MAX_REPORTED_IDS = 10;

/**
 * Compares two document lists.
 *
 * `ordered` says whether the query asked for an order. It matters: a query with no
 * `sort` gets whatever order the backend finds convenient, and Mongo's natural order
 * is an implementation detail rather than a promise. Two backends returning the same
 * documents in different orders for such a query have not disagreed about anything —
 * but a caller that quietly depends on that order will still behave differently after
 * a flip, so it is reported as its own kind rather than either failed or hidden.
 */
export function compareDocLists(
  collection: string,
  operation: string,
  query: unknown,
  primary: Doc[],
  shadow: Doc[],
  ordered = true
): Divergence | null {
  if (primary.length !== shadow.length) {
    const primaryIds = new Set(primary.map(idOf));
    const shadowIds = new Set(shadow.map(idOf));
    const missing = [...primaryIds].filter((id) => !shadowIds.has(id));
    const unexpected = [...shadowIds].filter((id) => !primaryIds.has(id));

    return {
      collection,
      operation,
      query,
      kind: missing.length > 0 ? 'missing' : 'unexpected',
      summary: `primary returned ${primary.length}, shadow returned ${shadow.length}`,
      ids: [...missing, ...unexpected].slice(0, MAX_REPORTED_IDS),
    };
  }

  // Same set but a different order is its own bug — a caller paginating on a sort
  // gets different pages from the two backends — so it is reported separately
  // rather than folded into a field difference.
  const orderMismatch = primary.findIndex((doc, index) => idOf(doc) !== idOf(shadow[index]!));
  if (orderMismatch !== -1) {
    const primaryIds = primary.map(idOf);
    const shadowIds = shadow.map(idOf);
    if (sameSet(primaryIds, shadowIds)) {
      return {
        collection,
        operation,
        query,
        kind: ordered ? 'order' : 'unordered',
        summary: ordered
          ? `same ${primary.length} documents in a different order, first at index ${orderMismatch}`
          : `same ${primary.length} documents, different order, and the query specified no sort`,
        ids: [primaryIds[orderMismatch]!, shadowIds[orderMismatch]!],
      };
    }
    return {
      collection,
      operation,
      query,
      kind: 'missing',
      summary: `same count but different documents, first differing at index ${orderMismatch}`,
      ids: [primaryIds[orderMismatch]!, shadowIds[orderMismatch]!],
    };
  }

  const differingFields = new Set<string>();
  const differingIds: string[] = [];
  const shadowById = new Map(shadow.map((doc) => [idOf(doc), doc]));
  for (let i = 0; i < primary.length; i++) {
    // Pair by id rather than by position: for an unordered query the two lists can
    // hold the same documents in different slots, and comparing slot-for-slot would
    // report every field of every row as differing.
    const counterpart = shadowById.get(idOf(primary[i]!)) ?? shadow[i]!;
    const fields = differingFieldNames(primary[i]!, counterpart);
    if (fields.length > 0) {
      for (const field of fields) differingFields.add(field);
      if (differingIds.length < MAX_REPORTED_IDS) differingIds.push(idOf(primary[i]!));
    }
  }

  if (differingFields.size > 0) {
    return {
      collection,
      operation,
      query,
      kind: 'fields',
      summary: `${differingIds.length} document(s) differ in ${differingFields.size} field(s)`,
      ids: differingIds,
      fields: [...differingFields].sort(),
    };
  }

  return null;
}

export function compareDocs(
  collection: string,
  operation: string,
  query: unknown,
  primary: Doc | null,
  shadow: Doc | null
): Divergence | null {
  if (primary === null && shadow === null) return null;
  if (primary === null) {
    return {
      collection,
      operation,
      query,
      kind: 'unexpected',
      summary: 'primary found nothing, shadow found a document',
      ids: [idOf(shadow!)],
    };
  }
  if (shadow === null) {
    return {
      collection,
      operation,
      query,
      kind: 'missing',
      summary: 'primary found a document, shadow found nothing',
      ids: [idOf(primary)],
    };
  }
  return compareDocLists(collection, operation, query, [primary], [shadow]);
}

/** Whether a find's options asked for a specific order. */
export function queryIsOrdered(options: { sort?: Record<string, unknown> } | undefined): boolean {
  return options?.sort !== undefined && Object.keys(options.sort).length > 0;
}

export function compareCounts(
  collection: string,
  operation: string,
  query: unknown,
  primary: number,
  shadow: number
): Divergence | null {
  if (primary === shadow) return null;
  return {
    collection,
    operation,
    query,
    kind: 'count',
    summary: `primary counted ${primary}, shadow counted ${shadow}`,
  };
}

/** `distinct` is a set, so order carries no meaning. */
export function compareValueSets(
  collection: string,
  operation: string,
  query: unknown,
  primary: unknown[],
  shadow: unknown[]
): Divergence | null {
  const missing = primary.filter((value) => !shadow.some((other) => valuesEqual(value, other)));
  const unexpected = shadow.filter((value) => !primary.some((other) => valuesEqual(value, other)));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return {
    collection,
    operation,
    query,
    kind: missing.length > 0 ? 'missing' : 'unexpected',
    summary: `distinct differs: ${missing.length} missing, ${unexpected.length} unexpected`,
  };
}

/**
 * Field names on which two documents differ, ignoring the structurally-expected
 * ones. A field present on one side and absent on the other counts as differing.
 */
function differingFieldNames(primary: Doc, shadow: Doc): string[] {
  const keys = new Set([...Object.keys(primary), ...Object.keys(shadow)]);
  const out: string[] = [];
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (!valuesEqual(primary[key], shadow[key])) out.push(key);
  }
  return out.sort();
}

function idOf(doc: Doc): string {
  return String(doc._id);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}
