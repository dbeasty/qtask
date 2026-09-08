/**
 * Dotted-path access with MongoDB's array-traversal semantics.
 *
 * The subtlety that makes this its own module: in MongoDB a dotted path crossing
 * an array fans out across its elements rather than failing. `collaborators.userId`
 * on `{ collaborators: [{ userId: 'a' }, { userId: 'b' }] }` yields *both* ids, and
 * a predicate matches if any one of them matches. Numeric segments are ambiguous by
 * design — `steps.0.text` indexes, but `steps.0` against an array of objects each
 * having a `0` key would address the field — and Mongo tries the index first.
 */

export type Doc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Every value a path addresses. Returns several when the path crosses an array —
 * callers that need "does any of them match" (filters) want all of them; callers
 * that need a single value (sorting) take the first.
 */
export function resolvePathValues(doc: unknown, path: string): unknown[] {
  return resolveSegments(doc, path.split('.'));
}

function resolveSegments(current: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) return [current];
  const [head, ...rest] = segments;
  if (head === undefined) return [current];

  if (Array.isArray(current)) {
    const index = Number(head);
    // An integer segment addresses the element when one exists there. Mongo prefers
    // the index reading, and only falls back to fanning out across elements.
    if (Number.isInteger(index) && index >= 0 && index < current.length) {
      return resolveSegments(current[index], rest);
    }
    const out: unknown[] = [];
    for (const element of current) {
      if (isPlainObject(element)) out.push(...resolveSegments(element, segments));
    }
    return out;
  }

  if (isPlainObject(current)) {
    if (!(head in current)) return [];
    return resolveSegments(current[head], rest);
  }

  return [];
}

/** The single value at a path, for sorting and projection. Undefined when absent. */
export function getPath(doc: unknown, path: string): unknown {
  const values = resolvePathValues(doc, path);
  return values.length > 0 ? values[0] : undefined;
}

/** Whether the path addresses anything at all — `$exists` semantics, where an
 *  explicit null counts as present but a missing key does not. */
export function pathExists(doc: unknown, path: string): boolean {
  return resolvePathValues(doc, path).length > 0;
}

/**
 * Sets a dotted path, creating intermediate objects as it goes. Mirrors `$set`:
 * a numeric segment under an array writes that element, and an absent
 * intermediate becomes an object.
 */
export function setPath(doc: Doc, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: unknown = doc;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const next = segments[i + 1]!;

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return;
      if (current[index] === undefined) current[index] = isIndexSegment(next) ? [] : {};
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return;
    if (!isPlainObject(current[segment]) && !Array.isArray(current[segment])) {
      current[segment] = isIndexSegment(next) ? [] : {};
    }
    current = current[segment];
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const index = Number(last);
    if (Number.isInteger(index) && index >= 0) current[index] = value;
    return;
  }
  if (isPlainObject(current)) current[last] = value;
}

/** Removes a dotted path — `$unset`. Absent paths are a no-op, as in Mongo. */
export function unsetPath(doc: Doc, path: string): void {
  const segments = path.split('.');
  let current: unknown = doc;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return;
    current = current[segment];
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const index = Number(last);
    // Mongo leaves a null hole rather than shortening the array, so indexes of
    // later elements do not shift under a concurrent reader.
    if (Number.isInteger(index) && index >= 0 && index < current.length) current[index] = null;
    return;
  }
  if (isPlainObject(current)) delete current[last];
}

function isIndexSegment(segment: string): boolean {
  const n = Number(segment);
  return Number.isInteger(n) && n >= 0;
}

export { isPlainObject };
