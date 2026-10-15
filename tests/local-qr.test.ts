/**
 * The pairing QR encoder (src/local/qr.ts), checked against Apple's CoreImage QR
 * detector through tests/helpers/qr-decode.swift. The decoder part skips off macOS or
 * without a Swift toolchain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeQr, qrSvg, MAX_VERSION } from '../src/local/qr.ts';

const swiftc = process.platform === 'darwin' ? spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }) : null;
const skip = swiftc && swiftc.status === 0 ? undefined : 'needs macOS with swiftc (CoreImage decoder)';

function samples(): string[] {
  const out = ['A', 'hello', 'qtask://pair?h=127.0.0.1:1234'];
  // A realistic pairing link (about 170 bytes), and lengths that cross version boundaries.
  out.push(
    `qtask://pair?h=192.168.178.20:52344&id=${'a1'.repeat(16)}&fp=${'0f'.repeat(32)}&s=${'Zz9_-'.repeat(4)}ab`
  );
  for (const n of [14, 15, 26, 27, 42, 43, 60, 61, 84, 85, 106, 107, 122, 152, 180, 213, 230, 271, 321, 367, 412]) {
    out.push(Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join(''));
  }
  return out;
}

describe('pairing QR codes', () => {
  it('picks the smallest version, and refuses what does not fit', () => {
    assert.equal(encodeQr('A').version, 1);
    assert.equal(encodeQr('x'.repeat(14)).version, 1);
    assert.equal(encodeQr('x'.repeat(15)).version, 2);
    assert.equal(encodeQr('x'.repeat(412)).version, MAX_VERSION);
    assert.throws(() => encodeQr('x'.repeat(413)), /too long/);
    assert.match(qrSvg('hello'), /^<svg [^>]*viewBox="0 0 174 174"/);
  });

  it('decodes with CoreImage to the same text, for every mask and many versions', { skip }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qtask-qr-'));
    try {
      const bin = path.join(dir, 'qr-decode');
      execFileSync('xcrun', ['swiftc', '-O', path.join(import.meta.dirname, 'helpers/qr-decode.swift'), '-o', bin], { stdio: 'pipe' });
      const cases: Array<{ text: string; mask?: number }> = samples().map((text) => ({ text }));
      for (let mask = 0; mask < 8; mask++) cases.push({ text: samples()[3]!, mask });
      const input = cases
        .map(({ text, mask }) => {
          const qr = encodeQr(text, mask === undefined ? {} : { mask });
          return `${qr.size} ${qr.modules.map((row) => row.join('')).join('')}`;
        })
        .join('\n');
      const out = execFileSync(bin, { input: input + '\n', encoding: 'utf8' }).trimEnd().split('\n');
      const failed = cases
        .map(({ text, mask }, i) => (out[i] === text ? null : `len ${text.length} v${encodeQr(text).version} mask ${mask ?? 'auto'}`))
        .filter(Boolean);
      assert.deepEqual(failed, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
