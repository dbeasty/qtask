/**
 * Process-wide database lifecycle.
 *
 * These names are kept because every entry point already calls them; what changed is
 * that they now open whichever backend `DATA_MONGO` / `DATA_KDB` selects, rather than
 * Mongoose directly. The Mongoose models still have to be imported for the Mongo
 * store to find them in the connection registry, which is what the side-effect import
 * below is for.
 */

import { connectData, disconnectData } from '../data/index.js';

export async function connectDb(): Promise<void> {
  // Registers every Mongoose model. Harmless under DATA_KDB — defining a schema
  // opens no connection — and required under DATA_MONGO.
  await import('../models/index.js');
  await connectData();
}

export async function disconnectDb(): Promise<void> {
  await disconnectData();
}
