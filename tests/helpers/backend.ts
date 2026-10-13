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
