/**
 * Pins the deployment default: Mongo unless a deployment explicitly asks for KDB.
 *
 * The KDB backend passes the same conformance suite, but it has had no production
 * exposure — so "which backend does an unconfigured deployment get" is a decision
 * that should fail a test if it ever changes by accident, rather than being noticed
 * after a rollout.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDataBackend, shadowWritesEnabled } from '../src/data/index.ts';

describe('data backend selection', () => {
  it('defaults to mongo when neither flag is set', () => {
    assert.equal(resolveDataBackend({}), 'mongo');
  });

  it('defaults to mongo when the flags are present but not "true"', () => {
    assert.equal(resolveDataBackend({ DATA_MONGO: 'false', DATA_KDB: 'false' }), 'mongo');
    assert.equal(resolveDataBackend({ DATA_KDB: '1' }), 'mongo');
    assert.equal(resolveDataBackend({ DATA_KDB: 'yes' }), 'mongo');
  });

  it('selects mongo explicitly', () => {
    assert.equal(resolveDataBackend({ DATA_MONGO: 'true' }), 'mongo');
  });

  it('selects kdb only on an exact opt-in', () => {
    assert.equal(resolveDataBackend({ DATA_KDB: 'true' }), 'kdb');
  });

  it('refuses to guess when both are set', () => {
    assert.throws(
      () => resolveDataBackend({ DATA_MONGO: 'true', DATA_KDB: 'true' }),
      /mutually exclusive/
    );
  });

  it('has shadow writes off unless explicitly enabled', () => {
    assert.equal(shadowWritesEnabled({}), false);
    assert.equal(shadowWritesEnabled({ DATA_SHADOW_WRITES: 'false' }), false);
    assert.equal(shadowWritesEnabled({ DATA_SHADOW_WRITES: '1' }), false);
    assert.equal(shadowWritesEnabled({ DATA_SHADOW_WRITES: 'yes' }), false);
    assert.equal(shadowWritesEnabled({ DATA_SHADOW_WRITES: 'true' }), true);
  });

  it('reads process.env when no environment is passed', () => {
    const previous = { mongo: process.env.DATA_MONGO, kdb: process.env.DATA_KDB };
    try {
      delete process.env.DATA_MONGO;
      delete process.env.DATA_KDB;
      assert.equal(resolveDataBackend(), 'mongo');
    } finally {
      if (previous.mongo === undefined) delete process.env.DATA_MONGO;
      else process.env.DATA_MONGO = previous.mongo;
      if (previous.kdb === undefined) delete process.env.DATA_KDB;
      else process.env.DATA_KDB = previous.kdb;
    }
  });
});
