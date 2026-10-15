/**
 * Who owns the data on this device.
 *
 * Every document carries a `userId`. On a device with no account that is the one local
 * user, and every device must use the *same* id for it, otherwise a task created on one
 * Mac would arrive on another owned by a stranger and be invisible there. So the local
 * user's id is a constant (`LOCAL_OWNER_ID`), the same on every install.
 *
 * Signing in to the cloud *adopts* the account (plan D4): local documents are re-owned to
 * the account's id and the device's owner becomes that id. Paired devices learn the
 * owner of their peer in the sync hello and follow the same rule:
 *
 *   local  + local     -> nothing to do
 *   local  + account X -> the local side adopts X
 *   account X + account X -> nothing to do
 *   account X + account Y -> refuse to sync (two people's data must not mix peer to peer)
 *
 * The owner lives in `<dataDir>/sync/owner.json`. The users collection is never
 * replicated; each device keeps its own user document under the owner's id.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DataStore, Doc } from '../data/types.js';
import { writeJsonPrivate } from './files.js';

/** The local user's id on every device that has not signed in ("qtasklocal01" in hex). */
export const LOCAL_OWNER_ID = '717461736b6c6f63616c3031';

/** Fixed e-mail of the local user. It is not a mailbox and never receives mail. */
export const LOCAL_USER_EMAIL = 'local@device.qtask.invalid';

export interface OwnerState {
  ownerId: string;
  /** Present once the device signed in to a cloud account. */
  account?: { hubUrl: string; email?: string };
}

export function ownerFile(dataDir: string): string {
  return path.join(dataDir, 'sync', 'owner.json');
}

export function loadOwner(dataDir: string): OwnerState {
  try {
    const parsed = JSON.parse(readFileSync(ownerFile(dataDir), 'utf8')) as OwnerState;
    if (typeof parsed.ownerId === 'string' && /^[0-9a-f]{24}$/.test(parsed.ownerId)) return parsed;
  } catch {
    // missing or unreadable: the default
  }
  return { ownerId: LOCAL_OWNER_ID };
}

export async function saveOwner(dataDir: string, state: OwnerState): Promise<void> {
  await writeJsonPrivate(ownerFile(dataDir), state);
}

/** What to do when a peer reports its owner. */
export function ownerDecision(mine: string, theirs: string | undefined): 'same' | 'adopt' | 'keep' | 'refuse' {
  if (!theirs || theirs === mine) return 'same';
  if (mine === LOCAL_OWNER_ID) return 'adopt';
  if (theirs === LOCAL_OWNER_ID) return 'keep';
  return 'refuse';
}

/**
 * Id of the default project a device creates for `userId`. Deterministic, so two devices
 * that each created their default project before they paired end up with one project,
 * not two "Project One"s.
 */
export function defaultProjectIdFor(userId: string): string {
  return createHash('sha256').update(`qtask-default-project:${userId}`).digest('hex').slice(0, 24);
}

/** Fixed creation time of that project, so both devices' copies are identical. */
export const DEFAULT_PROJECT_CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

/**
 * Makes `ownerId` the device's user document: creates it (copying the profile of the
 * previous local user, if any) and retires every other local user document by renaming
 * its e-mail, so `LOCAL_USER_EMAIL` keeps pointing at exactly one user. Sessions issued
 * for a retired id stay valid but see no data; the client asks for a new session when
 * the owner changes (GET /api/local-sync/revision reports it).
 */
export async function installOwnerUser(store: DataStore, ownerId: string, previousIds: string[] = []): Promise<void> {
  const users = store.collection<Doc>('users');
  const existing = await users.findById(ownerId);
  const others = (await users.find({ email: LOCAL_USER_EMAIL })).filter((u) => String(u._id) !== ownerId);
  const template = others[0] ?? (previousIds.length ? await users.findById(previousIds[0]!) : null);
  for (const other of others) {
    await users.updateOne({ _id: String(other._id) }, { $set: { email: `retired-${String(other._id)}@device.qtask.invalid` } });
  }
  if (existing) {
    if (existing.email !== LOCAL_USER_EMAIL) await users.updateOne({ _id: ownerId }, { $set: { email: LOCAL_USER_EMAIL } });
    return;
  }
  await users.create({
    _id: ownerId,
    email: LOCAL_USER_EMAIL,
    displayName: (template?.displayName as string | undefined) ?? 'Me',
    emailVerified: true,
    ...(template?.preferences ? { preferences: template.preferences } : {}),
    ...(template?.hourlyRate !== undefined ? { hourlyRate: template.hourlyRate } : {}),
  });
}
