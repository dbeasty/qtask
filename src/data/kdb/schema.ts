/**
 * Applies Mongoose schema semantics to a plain document, for a backend that has no
 * schema engine of its own.
 *
 * The rules are *read off the existing Mongoose schemas* rather than restated here.
 * That is the whole point: defaults, enums, `trim`, `lowercase`, `required`, `min`,
 * `maxlength`, subdocument `_id` minting and `timestamps` are declared once, in
 * src/models/index.ts, and both backends obey the same declaration. A hand-written
 * second copy would drift on the first schema change, and the conformance suite
 * would only catch it if someone happened to write a case for that field.
 *
 * Mongoose is imported for its schema metadata only — this opens no connection and
 * runs no query.
 */

import type { Schema, SchemaType } from 'mongoose';
import { generateObjectId } from './ids.js';
import type { Doc } from '../types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface NormalizeOptions {
  /** A create applies defaults and required-checks; an update only casts what is present. */
  isCreate: boolean;
}

/**
 * Returns a normalized copy: defaults filled, values cast and validated, subdocument
 * ids minted, timestamps stamped.
 */
export function normalizeDocument(schema: Schema, input: Doc, options: NormalizeOptions): Doc {
  const out = applySchema(schema, { ...input }, options, '');

  if (hasTimestamps(schema)) {
    const now = new Date();
    if (options.isCreate) {
      out.createdAt = asDate(out.createdAt) ?? now;
      out.updatedAt = asDate(out.updatedAt) ?? now;
    } else {
      out.updatedAt = now;
    }
    if (timestampsUpdatedAtDisabled(schema)) delete out.updatedAt;
  }

  return out;
}

/** Stamps `updatedAt` on a document being written back, when the schema has timestamps. */
export function touchUpdatedAt(schema: Schema, doc: Doc): Doc {
  if (!hasTimestamps(schema) || timestampsUpdatedAtDisabled(schema)) return doc;
  return { ...doc, updatedAt: new Date() };
}

function hasTimestamps(schema: Schema): boolean {
  const option = (schema as unknown as { options?: Record<string, unknown> }).options?.timestamps;
  return Boolean(option);
}

function timestampsUpdatedAtDisabled(schema: Schema): boolean {
  const option = (schema as unknown as { options?: Record<string, unknown> }).options?.timestamps;
  return typeof option === 'object' && option !== null && (option as Record<string, unknown>).updatedAt === false;
}

function applySchema(schema: Schema, doc: Doc, options: NormalizeOptions, prefix: string): Doc {
  const out: Doc = { ...doc };

  for (const [path, type] of Object.entries(schema.paths)) {
    if (path === '_id' || path === '__v') continue;
    // Mongoose flattens nested objects into dotted paths; the nested-schema case is
    // handled through `type.schema` below, so a dotted path here is a leaf of one.
    if (path.includes('.')) continue;

    const present = out[path] !== undefined && out[path] !== null;

    if (!present) {
      if (options.isCreate) {
        const fallback = defaultFor(type);
        if (fallback !== undefined) {
          out[path] = fallback;
        }
      }
    }

    if (out[path] !== undefined && out[path] !== null) {
      out[path] = castValue(type, out[path], options, `${prefix}${path}`);
    }

    if (options.isCreate && isRequired(type) && (out[path] === undefined || out[path] === null || out[path] === '')) {
      throw new ValidationError(`${prefix}${path} is required`);
    }
  }

  return out;
}

function isRequired(type: SchemaType): boolean {
  return Boolean((type as unknown as { isRequired?: boolean }).isRequired);
}

function typeOptions(type: SchemaType): Record<string, unknown> {
  return ((type as unknown as { options?: Record<string, unknown> }).options ?? {}) as Record<string, unknown>;
}

function defaultFor(type: SchemaType): unknown {
  const raw = (type as unknown as { defaultValue?: unknown }).defaultValue;
  if (raw === undefined) {
    // An array path with no declared default still defaults to [], as in Mongoose.
    return instanceOf(type) === 'Array' ? [] : undefined;
  }
  return typeof raw === 'function' ? (raw as () => unknown)() : raw;
}

function instanceOf(type: SchemaType): string {
  return (type as unknown as { instance?: string }).instance ?? '';
}

function castValue(type: SchemaType, value: unknown, options: NormalizeOptions, path: string): unknown {
  const opts = typeOptions(type);

  switch (instanceOf(type)) {
    case 'String': {
      let text = typeof value === 'string' ? value : String(value);
      if (opts.trim) text = text.trim();
      if (opts.lowercase) text = text.toLowerCase();
      if (opts.uppercase) text = text.toUpperCase();
      const allowed = (type as unknown as { enumValues?: string[] }).enumValues;
      if (allowed && allowed.length > 0 && !allowed.includes(text)) {
        throw new ValidationError(`${path}: "${text}" is not a valid enum value`);
      }
      if (typeof opts.maxlength === 'number' && text.length > opts.maxlength) {
        throw new ValidationError(`${path} is longer than ${opts.maxlength}`);
      }
      return text;
    }

    case 'Number': {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) throw new ValidationError(`${path}: "${String(value)}" is not a number`);
      const min = numericBound(opts.min);
      const max = numericBound(opts.max);
      if (min !== undefined && num < min) throw new ValidationError(`${path} is below the minimum ${min}`);
      if (max !== undefined && num > max) throw new ValidationError(`${path} is above the maximum ${max}`);
      return num;
    }

    case 'Boolean':
      return Boolean(value);

    case 'Date': {
      const date = asDate(value);
      if (!date) throw new ValidationError(`${path}: "${String(value)}" is not a date`);
      return date;
    }

    case 'Array': {
      if (!Array.isArray(value)) return value;
      const nested = (type as unknown as { schema?: Schema }).schema;
      const caster = (type as unknown as { caster?: SchemaType }).caster;
      return value.map((element, index) => {
        if (nested) return castSubdocument(nested, element, options, `${path}.${index}`);
        if (caster && element !== null && element !== undefined) {
          return castValue(caster, element, options, `${path}.${index}`);
        }
        return element;
      });
    }

    case 'Embedded': {
      const nested = (type as unknown as { schema?: Schema }).schema;
      if (!nested || typeof value !== 'object' || value === null) return value;
      return castSubdocument(nested, value, options, path);
    }

    default:
      // Mixed and anything unmodelled passes through untouched, which is what
      // Schema.Types.Mixed means.
      return value;
  }
}

/**
 * A subdocument is normalized by its own schema, and gets an `_id` unless the schema
 * turned them off. Mongoose mints these on save; a document written straight to a
 * key/value store would otherwise come back without them, and the API serializes
 * `String(step._id)` — which would read "undefined" to every client.
 */
function castSubdocument(schema: Schema, value: unknown, options: NormalizeOptions, path: string): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const doc = applySchema(schema, { ...(value as Doc) }, { isCreate: true }, `${path}.`);

  const idDisabled = (schema as unknown as { options?: Record<string, unknown> }).options?._id === false;
  if (!idDisabled && doc._id === undefined) {
    doc._id = generateObjectId();
  }
  if (idDisabled) delete doc._id;

  if (hasTimestamps(schema)) {
    const now = new Date();
    doc.createdAt = asDate(doc.createdAt) ?? now;
    doc.updatedAt = asDate(doc.updatedAt) ?? now;
  }

  return doc;
}

function numericBound(option: unknown): number | undefined {
  if (typeof option === 'number') return option;
  if (Array.isArray(option) && typeof option[0] === 'number') return option[0];
  return undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/**
 * The unique constraints declared on a schema, as field tuples. Both the single-field
 * `unique: true` flag and compound `schema.index({...}, { unique: true })` are
 * reported the same way, since the store enforces them identically.
 */
export function uniqueConstraints(schema: Schema): Array<{ fields: string[]; sparse: boolean }> {
  const out: Array<{ fields: string[]; sparse: boolean }> = [];

  for (const [path, type] of Object.entries(schema.paths)) {
    if (typeOptions(type).unique) out.push({ fields: [path], sparse: Boolean(typeOptions(type).sparse) });
  }

  const declared = (schema as unknown as { indexes(): Array<[Record<string, unknown>, Record<string, unknown>]> }).indexes();
  for (const [fields, options] of declared) {
    if (!options?.unique) continue;
    const keys = Object.keys(fields).filter((key) => fields[key] !== 'text');
    if (keys.length === 0) continue;
    if (out.some((existing) => existing.fields.join() === keys.join())) continue;
    out.push({ fields: keys, sparse: Boolean(options.sparse) });
  }

  return out;
}
