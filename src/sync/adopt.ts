/**
 * Adopt-account flow (plan D4): on first sign-in, documents the device created under
 * its local user are re-owned to the account's user id, so they replicate into the
 * account's scope on the hub.
 *
 * Re-owning is done as ordinary edits through the tracked store, so each document
 * gets a stamp for its new `userId` and the next sync carries it. Calling this again
 * is harmless: once nothing is owned by the local user there is nothing to change.
 */

import type { Doc } from '../data/types.js';
import type { SyncEngine } from './engine.js';
import { OWNER_FIELDS, REPLICATED_COLLECTIONS } from './policy.js';

export interface AdoptResult {
  /** Documents whose owner field changed, by collection. */
  reowned: Record<string, number>;
  total: number;
}

export async function adoptLocalAccount(
  engine: SyncEngine,
  localUserId: string,
  accountUserId: string
): Promise<AdoptResult> {
  if (!localUserId || !accountUserId) throw new Error('both user ids are required');
  const reowned: Record<string, number> = {};
  let total = 0;
  if (localUserId === accountUserId) return { reowned, total };

  // Pending edits first, so they are stamped under the old identity and not mixed in.
  await engine.capture();

  for (const coll of REPLICATED_COLLECTIONS) {
    const collection = engine.store.collection(coll);
    const touched = new Set<string>();

    for (const field of OWNER_FIELDS[coll]) {
      const matching = await collection.find({ [field]: localUserId }, { select: '_id' });
      if (matching.length === 0) continue;
      await collection.updateMany({ [field]: localUserId }, { $set: { [field]: accountUserId } });
      for (const doc of matching) touched.add(String(doc._id));
    }

    if (coll === 'projects') {
      const shared = await collection.find({ 'collaborators.userId': localUserId });
      for (const project of shared) {
        const collaborators = (project.collaborators as Array<{ userId: string; role: string }>).map((c) =>
          c.userId === localUserId ? { ...c, userId: accountUserId } : c
        );
        await collection.updateOne({ _id: String(project._id) }, { $set: { collaborators } as Doc });
        touched.add(String(project._id));
      }
    }

    if (touched.size > 0) {
      reowned[coll] = touched.size;
      total += touched.size;
    }
  }

  await engine.capture();
  return { reowned, total };
}
