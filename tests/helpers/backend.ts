/**
 * Which backend the suite is running on, for the few tests that are about MongoDB itself.
 *
 * `npm test` runs on Mongo; `npm run test:kdb` runs the same files on KDB (see
 * useKdbBackend.ts). A test that asserts a Mongo index definition, or the exact Mongoose query
 * a service issues, has no meaning on KDB - the KDB equivalents are covered by
 * tests/data-kdb-*.test.ts - so it declares that instead of failing.
 */

export const onKdb = process.env.QTASK_TEST_BACKEND === 'kdb';

/** Pass as `{ skip: MONGO_ONLY }` to a `describe` or `it`. */
export const MONGO_ONLY: string | false = onKdb
  ? 'asserts a MongoDB-specific shape (index definitions or Mongoose query calls); not applicable on KDB'
  : false;

/**
 * Pass as `{ skip: OWN_BACKENDS }` to a suite that starts its own mongod (and kdb-service) to test
 * the two side by side - the migration tool, shadow mode, the Mongo conformance run. Under
 * `npm run test:kdb` the preload sends Mongoose model calls to KDB, so such a suite would seed the
 * wrong store; it already runs against a real kdb-service in `npm test`, which is where it belongs.
 */
export const OWN_BACKENDS: string | false = onKdb
  ? 'starts its own MongoDB and kdb-service; runs in `npm test`, where Mongoose still talks to MongoDB'
  : false;
