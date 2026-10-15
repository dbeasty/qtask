/**
 * A small QR code encoder for pairing links (ISO/IEC 18004): byte mode, error
 * correction level M, versions 1 to 15 (up to 412 bytes, far more than a
 * `qtask://pair` link needs). It returns the module matrix and an SVG rendering.
 *
 * Why not a package: the client has no QR dependency, the app must not fetch one at
 * run time, and pairing links are short and fixed in shape. The output is checked
 * against Apple's own decoder (CoreImage) in tests/local-qr.test.ts when that test
 * runs on a Mac.
 */

// Error correction level M: [ec codewords per block, [blocks, data codewords]...] per version.
const EC_M: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]> = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
  [30, [[1, 50], [4, 51]]],
  [22, [[6, 36], [2, 37]]],
  [22, [[8, 37], [1, 38]]],
  [24, [[4, 40], [5, 41]]],
  [24, [[5, 41], [5, 42]]],
];

const ALIGN: ReadonlyArray<readonly number[]> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
];

export const MAX_VERSION = 15;

// --- Reed-Solomon over GF(256), polynomial 0x11d ---------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const out = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(gen[i + 1]!, factor);
  }
  return out;
}

// --- data encoding ---------------------------------------------------------------------------

function capacity(version: number): number {
  const [, groups] = EC_M[version]!;
  return groups.reduce((sum, [blocks, data]) => sum + blocks * data, 0);
}

function chooseVersion(bytes: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes * 8 <= capacity(v) * 8) return v;
  }
  throw new Error(`QR payload of ${bytes} bytes is too long`);
}

function encodeData(payload: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(payload.length, version < 10 ? 8 : 16);
  for (const b of payload) put(b, 8);
  const total = capacity(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    bytes.push(v);
  }
  for (let pad = 0; bytes.length < total / 8; pad++) bytes.push(pad % 2 === 0 ? 0xec : 0x11);
  return bytes;
}

function interleave(data: number[], version: number): number[] {
  const [ecLen, groups] = EC_M[version]!;
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(offset, offset + len));
      offset += len;
    }
  }
  const ecBlocks = blocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

// --- matrix --------------------------------------------------------------------------------

type Grid = Array<Array<number>>; // 0/1 module values
type Mask = Array<Array<boolean>>; // true = function module (not data)

function bchFormat(data: number): number {
  let v = data << 10;
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  return ((data << 10) | v) ^ 0x5412;
}

function bchVersion(version: number): number {
  let v = version << 12;
  for (let i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= 0x1f25 << (i - 12);
  return (version << 12) | v;
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function baseMatrix(version: number): { grid: Grid; fixed: Mask } {
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const fixed: Mask = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: number) => {
    grid[r]![c] = v;
    fixed[r]![c] = true;
  };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  const centers = ALIGN[version]!;
  const last = centers.length - 1;
  for (const [i, r] of centers.entries()) {
    for (const [j, c] of centers.entries()) {
      // The three corners that would overlap a finder pattern are left out. The others
      // may cross the timing patterns, and replace them there.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
        }
      }
    }
  }
  // Reserve the format areas (written later) and the dark module.
  for (let i = 0; i <= 8; i++) {
    fixed[8]![i] = true;
    fixed[i]![8] = true;
    if (i < 8) {
      fixed[8]![size - 1 - i] = true;
      fixed[size - 1 - i]![8] = true;
    }
  }
  set(size - 8, 8, 1);
  if (version >= 7) {
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  return { grid, fixed };
}

function placeData(grid: Grid, fixed: Mask, codewords: number[]): void {
  const size = grid.length;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let k = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let n = 0; n < size; n++) {
      const r = upward ? size - 1 - n : n;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (fixed[r]![c]) continue;
        grid[r]![c] = k < bits.length ? bits[k]! : 0; // remainder bits are 0
        k++;
      }
    }
    upward = !upward;
  }
}

function applyMask(grid: Grid, fixed: Mask, mask: number): Grid {
  const fn = MASKS[mask]!;
  return grid.map((row, r) => row.map((v, c) => (!fixed[r]![c] && fn(r, c) ? v ^ 1 : v)));
}

function writeFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = bchFormat((0b00 << 3) | mask); // level M = 00
  const bit = (i: number) => (bits >>> i) & 1;
  // Around the top-left finder: down column 8, then along row 8.
  for (let i = 0; i <= 5; i++) grid[i]![8] = bit(i);
  grid[7]![8] = bit(6);
  grid[8]![8] = bit(7);
  grid[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) grid[8]![14 - i] = bit(i);
  // The second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) grid[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) grid[size - 15 + i]![8] = bit(i);
  grid[size - 8]![8] = 1;
}

function penalty(grid: Grid): number {
  const size = grid.length;
  let score = 0;
  // Rule 1: runs of five or more.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const prev = pass === 0 ? grid[a]![b - 1] : grid[b - 1]![a];
        const cur = pass === 0 ? grid[a]![b] : grid[b]![a];
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }
  // Rule 3: finder-like patterns.
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 6 < size; b++) {
      for (let pass = 0; pass < 2; pass++) {
        const at = (i: number) => (pass === 0 ? grid[a]![b + i] : grid[b + i]![a]);
        if (!pattern.every((p, i) => at(i) === p)) continue;
        const light = (from: number) => {
          for (let i = from; i < from + 4; i++) {
            if (i < 0 || i >= size) continue;
            const v = pass === 0 ? grid[a]![i] : grid[i]![a];
            if (v !== 0) return false;
          }
          return true;
        };
        if (light(b - 4) || light(b + 7)) score += 40;
      }
    }
  }
  // Rule 4: balance of dark modules.
  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export interface QrCode {
  version: number;
  mask: number;
  size: number;
  /** modules[row][col], 1 = dark. */
  modules: number[][];
}

export function encodeQr(text: string, options: { mask?: number } = {}): QrCode {
  const payload = new TextEncoder().encode(text);
  const version = chooseVersion(payload.length);
  const codewords = interleave(encodeData(payload, version), version);
  const { grid, fixed } = baseMatrix(version);
  placeData(grid, fixed, codewords);
  let best: { grid: Grid; mask: number; score: number } | undefined;
  const masks = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  for (const mask of masks) {
    const candidate = applyMask(grid, fixed, mask);
    writeFormat(candidate, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { grid: candidate, mask, score };
  }
  return { version, mask: best!.mask, size: best!.grid.length, modules: best!.grid };
}

/** An SVG of the code with a four-module quiet zone, dark on light regardless of theme. */
export function qrSvg(text: string, moduleSize = 6): string {
  const qr = encodeQr(text);
  const quiet = 4;
  const dim = (qr.size + quiet * 2) * moduleSize;
  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]![c]) path += `M${(c + quiet) * moduleSize} ${(r + quiet) * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/></svg>`
  );
}
