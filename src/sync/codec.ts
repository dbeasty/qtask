/**
 * Wire encoding of document values and the content hash used for change detection.
 *
 * Documents hold `Date`s, which JSON flattens to strings that cannot be told apart
 * from real strings on the way back. They are therefore written as `{"$date": iso}`.
 * Everything else a document holds (strings, numbers, booleans, null, arrays, plain
 * objects) is already JSON.
 */

export function encodeValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = encodeValue(item);
    }
    return out;
  }
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === '$date' && typeof record.$date === 'string') {
      return new Date(record.$date);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = decodeValue(record[key]);
    return out;
  }
  return value;
}

/** JSON with object keys sorted, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 53-bit string hash (cyrb53). Not cryptographic: it only decides "did this field's
 * value change since I last looked", where a collision means ~1 in 9e15.
 */
export function hashString(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Hash of an already-encoded value. */
export function hashEncoded(encoded: unknown): number {
  return hashString(canonicalJson(encoded));
}
