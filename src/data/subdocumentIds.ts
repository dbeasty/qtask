/**
 * Gives every new sub-document in a write its `_id` before the write reaches a store.
 *
 * Each backend mints the ids of sub-documents a write creates (a pushed subtask, a new
 * collaborator) on its own: Mongoose an ObjectId, the KDB store one of the same shape. While two
 * stores receive the same writes - shadow mode, during the migration - they would hold the same
 * sub-document under two ids, and a later "update the step with this id" would find it on one
 * side only. Minting the id once, here, and handing both stores the same payload keeps them
 * identical: neither store mints an id for a sub-document that already has one.
 *
 * The rule for which objects are sub-documents is the stores' own: an element of an array of
 * sub-documents, or a single nested sub-document, gets an `_id` unless its schema sets
 * `_id: false`. Anything else - Mixed values, plain nested objects, arrays of scalars - is left
 * exactly as given. Returns a copy; the caller's update is not modified.
 */

import type { Schema } from 'mongoose';
import { generateObjectId } from './kdb/ids.js';
import type { Doc } from './types.js';

type SchemaTypeLike = {
  instance?: string;
  schema?: Schema;
  $isMongooseDocumentArray?: boolean;
  $isSingleNested?: boolean;
};

/** The operators whose values can introduce sub-documents. */
const INTRODUCING = new Set(['$set', '$setOnInsert', '$push', '$addToSet']);

export function presetSubdocumentIds<U extends Doc>(schema: Schema, update: U): U {
  const copy = structuredClone(update);
  const isOperatorUpdate = Object.keys(copy).some((key) => key.startsWith('$'));
  if (!isOperatorUpdate) {
    // A replacement document: the whole thing is checked against the schema.
    fillObject(schema, copy);
    return copy;
  }
  for (const [operator, fields] of Object.entries(copy)) {
    if (!INTRODUCING.has(operator) || !fields || typeof fields !== 'object') continue;
    for (const [path, value] of Object.entries(fields as Doc)) {
      fillAtPath(schema, path, value, operator === '$push' || operator === '$addToSet');
    }
  }
  return copy;
}

/**
 * `value` is written at `path` (dotted, possibly through array positions). `appending` is a
 * $push/$addToSet, whose value is one element, or `{ $each: [...] }`.
 */
function fillAtPath(schema: Schema, path: string, value: unknown, appending: boolean): void {
  const segments = path.split('.');
  // Positional segments (`3`, `$`, `$[]`, `$[name]`) address an element; the schema knows the
  // path without them.
  const isPosition = (segment: string) => /^\d+$/.test(segment) || segment.startsWith('$');
  const elementTarget = isPosition(segments[segments.length - 1]!);
  const schemaPath = segments.filter((segment) => !isPosition(segment)).join('.');
  if (!schemaPath) return;

  const type = schema.path(schemaPath) as unknown as SchemaTypeLike | undefined;
  if (type?.$isMongooseDocumentArray && type.schema) {
    const elements = appending
      ? isEach(value) ? value.$each : [value]
      : elementTarget ? [value] : Array.isArray(value) ? value : [];
    for (const element of elements) fillSubdocument(type.schema, element);
    return;
  }
  if (type?.$isSingleNested && type.schema) {
    fillSubdocument(type.schema, value);
    return;
  }
  if (!type && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    // A plain nested object (`$set: { preferences: {...} }` where preferences is not its own
    // schema): its children may be sub-documents.
    for (const [key, inner] of Object.entries(value as Doc)) fillAtPath(schema, `${schemaPath}.${key}`, inner, false);
  }
}

function isEach(value: unknown): value is { $each: unknown[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { $each?: unknown }).$each);
}

function fillSubdocument(schema: Schema, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return;
  const doc = value as Doc;
  const idDisabled = (schema as unknown as { options?: { _id?: unknown } }).options?._id === false;
  if (!idDisabled && (doc._id === undefined || doc._id === null)) doc._id = generateObjectId();
  fillObject(schema, doc);
}

/** Every sub-document inside a document (or sub-document) shaped by `schema`. */
function fillObject(schema: Schema, doc: Doc): void {
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') continue;
    fillAtPath(schema, key, value, false);
  }
}
