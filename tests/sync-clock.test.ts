import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HybridClock, compareStamps, formatStamp, parseStamp, stampNode, stampWall } from '../src/sync/clock.ts';

describe('hybrid logical clock', () => {
  it('mints strictly increasing stamps even when wall time stalls or goes backwards', () => {
    let wall = 5000;
    const clock = new HybridClock('a', () => wall);
    const first = clock.tick();
    const second = clock.tick(); // same ms
    wall = 4000; // clock stepped back
    const third = clock.tick();
    assert.ok(first < second);
    assert.ok(second < third);
    assert.equal(stampWall(third), 5000);
  });

  it('orders after any observed remote stamp, so causality beats a slow wall clock', () => {
    const fast = new HybridClock('fast', () => 9_000_000);
    const slow = new HybridClock('slow', () => 1_000);
    const remote = fast.tick();
    slow.observe(remote);
    const reply = slow.tick();
    assert.ok(reply > remote);
  });

  it('breaks exact ties by node id, deterministically', () => {
    const a = formatStamp(100, 0, 'a');
    const b = formatStamp(100, 0, 'b');
    assert.equal(compareStamps(a, b), -1);
    assert.equal(compareStamps(b, a), 1);
    assert.equal(compareStamps(a, a), 0);
  });

  it('round-trips through parse and exposes the node', () => {
    const t = formatStamp(1_760_000_000_123, 255, 'dev-1');
    assert.deepEqual(parseStamp(t), { wall: 1_760_000_000_123, counter: 255, node: 'dev-1' });
    assert.equal(stampNode(t), 'dev-1');
  });

  it('string order equals numeric order across counter and wall rollovers', () => {
    const stamps = [
      formatStamp(99, 0xffff, 'a'),
      formatStamp(100, 0, 'a'),
      formatStamp(100, 1, 'a'),
      formatStamp(100, 0x10, 'a'),
      formatStamp(1_000_000_000_000, 0, 'a'),
    ];
    const sorted = [...stamps].sort(compareStamps);
    assert.deepEqual(sorted, [stamps[0], stamps[1], stamps[2], stamps[3], stamps[4]]);
  });

  it('resumes from a persisted stamp without reissuing it', () => {
    const clock = new HybridClock('a', () => 10);
    const last = clock.tick();
    const restarted = new HybridClock('a', () => 5, last);
    assert.ok(restarted.tick() > last);
  });
});
