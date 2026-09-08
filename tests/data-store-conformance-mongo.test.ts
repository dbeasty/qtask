/** The conformance spec against MongoDB. See tests/helpers/dataStoreSpec.ts. */

import { MongoMemoryServer } from 'mongodb-memory-server';
import { runDataStoreConformance } from './helpers/dataStoreSpec.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

let mongo: MongoMemoryServer | undefined;

runDataStoreConformance({
  name: 'mongo',
  async start() {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri();
    process.env.DATA_MONGO = 'true';
    delete process.env.DATA_KDB;

    await import('../src/models/index.ts');
    const { MongoDataStore } = await import('../src/data/mongo/store.ts');
    const store = new MongoDataStore();
    await store.connect();
    return store;
  },
  async stop() {
    await mongo?.stop();
  },
});
