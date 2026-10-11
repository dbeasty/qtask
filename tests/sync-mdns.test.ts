import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  MdnsAdvertiser,
  MdnsBrowser,
  SERVICE_TYPE,
  decodeMessage,
  encodeMessage,
  type MdnsService,
} from '../src/sync/lan/mdns.ts';
import { waitFor } from './helpers/lan.ts';

describe('mDNS codec', () => {
  it('round-trips PTR/SRV/TXT/A records', () => {
    const full = `qtask-abc.${SERVICE_TYPE}`;
    const buf = encodeMessage({
      isResponse: true,
      records: [
        { name: SERVICE_TYPE, type: 12, ttl: 120, data: full },
        { name: full, type: 33, ttl: 120, data: { port: 4242, target: 'qtask-abc.local' } },
        { name: full, type: 16, ttl: 120, data: ['v=1', 'id=deadbeef'] },
        { name: 'qtask-abc.local', type: 1, ttl: 120, data: '192.168.1.9' },
      ],
    });
    const m = decodeMessage(buf)!;
    assert.equal(m.isResponse, true);
    assert.deepEqual(m.records.map((r) => r.type), [12, 33, 16, 1]);
    assert.deepEqual(m.records[1]!.data, { port: 4242, target: 'qtask-abc.local' });
    assert.deepEqual(m.records[2]!.data, ['v=1', 'id=deadbeef']);
    assert.equal(m.records[3]!.data, '192.168.1.9');
  });

  it('decodes DNS name compression', () => {
    // Header: 1 answer. Name "a.local" then a PTR whose rdata points back at it.
    const name = Buffer.from([1, 0x61, 5, ...Buffer.from('local'), 0]);
    const hdr = Buffer.alloc(12);
    hdr.writeUInt16BE(0x8400, 2);
    hdr.writeUInt16BE(1, 6);
    const rr = Buffer.alloc(10);
    rr.writeUInt16BE(12, 0);
    rr.writeUInt16BE(1, 2);
    rr.writeUInt32BE(60, 4);
    rr.writeUInt16BE(2, 8);
    const msg = Buffer.concat([hdr, name, rr, Buffer.from([0xc0, 12])]);
    const m = decodeMessage(msg)!;
    assert.equal(m.records[0]!.data, 'a.local');
  });

  it('fuzz: the decoder never throws, loops or allocates unboundedly on hostile packets', () => {
    const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12])]);
    loop.writeUInt16BE(1, 4);
    assert.equal(decodeMessage(loop), null); // compression loop
    const valid = encodeMessage({ isResponse: true, records: [{ name: SERVICE_TYPE, type: 12, ttl: 1, data: `x.${SERVICE_TYPE}` }] });
    for (let i = 0; i < 5000; i++) {
      const b = i % 2 ? randomBytes(Math.floor(Math.random() * 200)) : Buffer.from(valid);
      if (i % 2 === 0) for (let k = 0; k < 3; k++) b[Math.floor(Math.random() * b.length)] = Math.floor(Math.random() * 256);
      assert.doesNotThrow(() => decodeMessage(b));
    }
    const bigCounts = Buffer.alloc(12);
    bigCounts.writeUInt16BE(0xffff, 6);
    assert.equal(decodeMessage(bigCounts), null);
  });
});

describe('mDNS discovery on loopback', () => {
  // A private port keeps the test off the system mDNS responder; the wire format is identical.
  const opts = { port: 15353, interfaces: ['127.0.0.1'] };

  it('a browser finds an advertised service, and sees it go away on goodbye', async () => {
    const found: MdnsService[] = [];
    const gone: string[] = [];
    const browser = new MdnsBrowser(opts);
    browser.on('up', (s: MdnsService) => found.push(s));
    browser.on('down', (i: string) => gone.push(i));
    await browser.start();
    const ad = new MdnsAdvertiser({ instance: 'qtask-test1', port: 4711, txt: { v: '1', id: 'f'.repeat(32) } }, opts);
    await ad.start();
    try {
      await waitFor(() => found.length > 0, 5000, 'service discovered');
      const s = found[0]!;
      assert.equal(s.instance, 'qtask-test1');
      assert.equal(s.port, 4711);
      assert.equal(s.txt.id, 'f'.repeat(32));
      assert.equal(s.txt.v, '1');
      assert.ok(s.addresses.includes('127.0.0.1'));
      await ad.stop();
      await waitFor(() => gone.includes('qtask-test1'), 5000, 'goodbye');
    } finally {
      browser.stop();
      await ad.stop().catch(() => undefined);
    }
  });

  it('a late browser gets an answer by querying', async () => {
    const ad = new MdnsAdvertiser({ instance: 'qtask-test2', port: 4712, txt: { v: '1', id: 'e'.repeat(32) } }, opts);
    await ad.start();
    await new Promise((r) => setTimeout(r, 100));
    const found: MdnsService[] = [];
    const browser = new MdnsBrowser(opts);
    browser.on('up', (s: MdnsService) => found.push(s));
    await browser.start();
    try {
      await waitFor(() => found.some((s) => s.instance === 'qtask-test2'), 5000, 'discovery by query');
    } finally {
      browser.stop();
      await ad.stop();
    }
  });
});
