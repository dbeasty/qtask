/**
 * Sorting and projection — the two things a find() does to a result set after
 * filtering.
 */

import { compareValues } from './compare.js';
import { getPath, type Doc } from './paths.js';

export type Sort = Record<string, 1 | -1>;

/**
 * Stable sort by the given keys. Node's sort is already stable, so documents that
 * compare equal keep their input order, which is what makes paginated reads
 * repeatable when the sort key has ties.
 */
export function applySort<T extends Doc>(docs: T[], sort: Sort | undefined): T[] {
  if (!sort || Object.keys(sort).length === 0) return docs;
  const keys = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [path, direction] of keys) {
      const cmp = compareValues(getPath(a, path), getPath(b, path));
      if (cmp !== 0) return direction === -1 ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * Mongoose's space-separated projection string: `'email displayName'` keeps those
 * fields, `'-embedding'` drops one. Mixing the two forms is an error in Mongo (other
 * than excluding _id), and is an error here rather than a silent choice.
 */
export function parseProjection(select: string | undefined): { fields: string[]; exclude: boolean } | undefined {
  if (!select) return undefined;
  const tokens = select.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  const excluded = tokens.filter((token) => token.startsWith('-'));
  const included = tokens.filter((token) => !token.startsWith('-'));

  if (excluded.length > 0 && included.length > 0) {
    throw new Error(`Projection mixes inclusion and exclusion: ${select}`);
  }
  if (excluded.length > 0) {
    return { fields: excluded.map((token) => token.slice(1)), exclude: true };
  }
  return { fields: included, exclude: false };
}

/** Applies a parsed projection to one document. `_id` survives inclusion projections
 *  unless it was explicitly excluded, matching Mongo. */
export function applyProjection(doc: Doc, select: string | undefined): Doc {
  const projection = parseProjection(select);
  if (!projection) return doc;

  if (projection.exclude) {
    const out: Doc = { ...doc };
    for (const field of projection.fields) deletePath(out, field);
    return out;
  }

  const out: Doc = {};
  const fields = projection.fields.includes('_id')
    ? projection.fields
    : ['_id', ...projection.fields];
  for (const field of fields) {
    const value = getPath(doc, field);
    if (value !== undefined) setShallow(out, field, value);
  }
  return out;
}

function setShallow(target: Doc, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (typeof current[segment] !== 'object' || current[segment] === null) current[segment] = {};
    current = current[segment] as Doc;
  }
  current[segments[segments.length - 1]!] = value;
}

function deletePath(target: Doc, path: string): void {
  const segments = path.split('.');
  let current: Doc = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]!];
    if (typeof next !== 'object' || next === null) return;
    current = next as Doc;
  }
  delete current[segments[segments.length - 1]!];
}
