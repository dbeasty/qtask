/**
 * Evaluates the MongoDB query subset this application actually uses, in process.
 *
 * The Mongo adapter never calls this — MongoDB does its own matching. It exists so
 * a backend without a comparable query engine can be handed the same filter and
 * reach the same answer, and so that answer can be checked against a real mongod
 * (see tests/data-query-parity.test.ts).
 *
 * Supported: implicit equality, $eq $ne $in $nin $gt $gte $lt $lte, $exists, $regex
 * (with $options), $all, $size, $elemMatch, $not, and the logical $and $or $nor.
 * An operator outside that set throws rather than being ignored — a filter that
 * silently matches everything is how a permission check turns into a data leak.
 */

import { orderingCompare, valuesEqual } from './compare.js';
import { pathExists, resolvePathValues, type Doc } from './paths.js';

export type Filter = Record<string, unknown>;

const LOGICAL = new Set(['$and', '$or', '$nor']);

const SUPPORTED_OPERATORS = new Set([
  '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte',
  '$exists', '$regex', '$options', '$all', '$size', '$elemMatch', '$not',
]);

export function matchesFilter(doc: Doc, filter: Filter): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      if (!asFilterArray(key, condition).every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$or') {
      if (!asFilterArray(key, condition).some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$nor') {
      if (asFilterArray(key, condition).some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key.startsWith('$')) {
      throw new Error(`Unsupported top-level query operator: ${key}`);
    }
    if (!matchesField(doc, key, condition)) return false;
  }
  return true;
}

function asFilterArray(key: string, value: unknown): Filter[] {
  if (!Array.isArray(value)) throw new Error(`${key} expects an array of filters`);
  return value as Filter[];
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function matchesField(doc: Doc, path: string, condition: unknown): boolean {
  const values = resolvePathValues(doc, path);

  if (!isOperatorObject(condition)) {
    return matchesEquality(values, condition, doc, path);
  }

  for (const [operator, operand] of Object.entries(condition)) {
    if (operator === '$options') continue; // consumed by $regex
    if (!SUPPORTED_OPERATORS.has(operator)) {
      throw new Error(`Unsupported query operator: ${operator}`);
    }
    if (!matchesOperator(doc, path, values, operator, operand, condition)) return false;
  }
  return true;
}

/**
 * Implicit equality. The array rule is the one worth stating: a scalar operand
 * matches when the field *is* that value or is an array *containing* it, which is
 * what lets `{ projectIds: 'p1' }` and `{ tags: 'ops' }` work without $in. An array
 * operand matches the whole array, or an element that is itself that array.
 */
function matchesEquality(values: unknown[], operand: unknown, doc: Doc, path: string): boolean {
  if (values.length === 0) {
    // An absent field equals null, and equals nothing else.
    return operand === null;
  }
  return values.some((value) => {
    if (valuesEqual(value, operand)) return true;
    if (Array.isArray(value) && !Array.isArray(operand)) {
      return value.some((element) => valuesEqual(element, operand));
    }
    return false;
  });
}

function matchesOperator(
  doc: Doc,
  path: string,
  values: unknown[],
  operator: string,
  operand: unknown,
  condition: Record<string, unknown>
): boolean {
  switch (operator) {
    case '$eq':
      return matchesEquality(values, operand, doc, path);

    case '$ne':
      return !matchesEquality(values, operand, doc, path);

    case '$in':
      return asArray(operator, operand).some((candidate) =>
        candidate instanceof RegExp
          ? values.some((value) => matchesRegExp(value, candidate))
          : matchesEquality(values, candidate, doc, path)
      );

    case '$nin':
      return !asArray(operator, operand).some((candidate) =>
        matchesEquality(values, candidate, doc, path)
      );

    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
      return values.some((value) => matchesOrdering(value, operator, operand));

    case '$exists':
      return pathExists(doc, path) === Boolean(operand);

    case '$regex': {
      const regex = buildRegExp(operand, condition.$options);
      return values.some((value) => matchesRegExp(value, regex));
    }

    case '$all': {
      const wanted = asArray(operator, operand);
      return values.some(
        (value) =>
          Array.isArray(value) &&
          wanted.every((item) => value.some((element) => valuesEqual(element, item)))
      );
    }

    case '$size':
      return values.some((value) => Array.isArray(value) && value.length === Number(operand));

    case '$elemMatch': {
      const sub = operand as Filter;
      return values.some(
        (value) =>
          Array.isArray(value) &&
          value.some((element) =>
            isOperatorObject(sub)
              ? matchesField({ __value: element } as Doc, '__value', sub)
              : typeof element === 'object' && element !== null
                ? matchesFilter(element as Doc, sub)
                : false
          )
      );
    }

    case '$not': {
      const sub = operand as Record<string, unknown>;
      if (sub instanceof RegExp) return !values.some((value) => matchesRegExp(value, sub));
      return !matchesField(doc, path, sub);
    }

    default:
      throw new Error(`Unsupported query operator: ${operator}`);
  }
}

function matchesOrdering(value: unknown, operator: string, operand: unknown): boolean {
  // A range operator against an array matches when any element is in range.
  if (Array.isArray(value)) {
    return value.some((element) => matchesOrdering(element, operator, operand));
  }
  const cmp = orderingCompare(value, operand);
  if (cmp === null) return false;
  switch (operator) {
    case '$gt':
      return cmp > 0;
    case '$gte':
      return cmp >= 0;
    case '$lt':
      return cmp < 0;
    case '$lte':
      return cmp <= 0;
    default:
      return false;
  }
}

function matchesRegExp(value: unknown, regex: RegExp): boolean {
  if (Array.isArray(value)) return value.some((element) => matchesRegExp(element, regex));
  if (typeof value !== 'string') return false;
  // A global regex carries lastIndex between calls, which would make the same
  // document match or not depending on what was tested before it.
  regex.lastIndex = 0;
  return regex.test(value);
}

function buildRegExp(operand: unknown, options: unknown): RegExp {
  if (operand instanceof RegExp) {
    const flags = typeof options === 'string' ? mergeFlags(operand.flags, options) : operand.flags;
    return new RegExp(operand.source, flags);
  }
  if (typeof operand === 'string') {
    return new RegExp(operand, typeof options === 'string' ? options : '');
  }
  throw new Error('$regex expects a string or RegExp');
}

function mergeFlags(a: string, b: string): string {
  return [...new Set([...a, ...b])].join('');
}

function asArray(operator: string, operand: unknown): unknown[] {
  if (!Array.isArray(operand)) throw new Error(`${operator} expects an array`);
  return operand;
}


/**
 * The index the positional operator (`array.$.field`) stands for: the first element of
 * `arrayPath` that the query matched, taken from the filter's own conditions on that array
 * (`'array.field': value`, or `array: { $elemMatch: {...} }`). Returns null when the filter says
 * nothing about the array - the case MongoDB rejects as "the positional operator did not find
 * the match needed from the query".
 *
 * An element must satisfy every condition on it; if no single element does (conditions that
 * different elements satisfied), the first one satisfying any condition is used, which is where
 * MongoDB points the operator too.
 */
export function positionalIndex(doc: Doc, filter: Filter, arrayPath: string): number | null {
  const array = resolvePathValues(doc, arrayPath).find(Array.isArray) as unknown[] | undefined;
  if (!array) return null;

  const conditions: Array<(element: unknown) => boolean> = [];
  const collect = (clauses: Filter) => {
    for (const [key, condition] of Object.entries(clauses)) {
      if (key === '$and' && Array.isArray(condition)) {
        for (const sub of condition) collect(sub as Filter);
      } else if (key === arrayPath) {
        if (isOperatorObject(condition) && '$elemMatch' in condition) {
          const sub = condition.$elemMatch as Filter;
          conditions.push((el) => isObject(el) && matchesFilter(el as Doc, sub));
        } else {
          conditions.push((el) => matchesFilter({ v: el }, { v: condition }));
        }
      } else if (key.startsWith(`${arrayPath}.`)) {
        const rest = key.slice(arrayPath.length + 1);
        conditions.push((el) => isObject(el) && matchesFilter(el as Doc, { [rest]: condition }));
      }
    }
  };
  collect(filter);
  if (conditions.length === 0) return null;

  const all = array.findIndex((el) => conditions.every((c) => c(el)));
  if (all >= 0) return all;
  const any = array.findIndex((el) => conditions.some((c) => c(el)));
  return any >= 0 ? any : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
