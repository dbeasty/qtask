/**
 * Field-level three-way merge of a local sync record with an incoming one.
 *
 * The "base" of the three-way merge is not a stored snapshot: each field's stamp
 * carries a dot `(node, counter)`, and each document a version vector. A side's
 * edit is *newer than the other's knowledge* exactly when its dot is not covered by
 * the other side's vector. So for a field present on both sides:
 *
 *   - identical stamp                      -> same write, nothing to do
 *   - remote dot already in local vv       -> remote is a stale ancestor, keep local
 *   - local dot already in remote vv       -> local is an ancestor, take remote
 *   - neither                              -> concurrent edits of the same field:
 *                                             a real conflict
 *
 * The *winner* is always the greater HLC stamp, whether or not it was a conflict.
 * Because the stamp order is total and an edit that saw another always carries the
 * greater stamp, this is the same as "descendant wins, concurrent resolved by later
 * updatedAt", and it makes the merge commutative, associative and idempotent: the
 * merged state is the per-field maximum, so any order of exchange converges.
 *
 * A tombstone is the maximum of both tombstones and kills the whole document: delete
 * wins over a concurrent edit regardless of which is later, because the alternative
 * rebuilds a document from only the fields written since. An id that has been deleted
 * stays deleted (application ids are never reused).
 */

import { hashEncoded } from './codec.js';
import { stampNode, stampWall } from './clock.js';
import type { DocRec, FieldRec } from './meta.js';
import type { WireDoc, WireField } from './types.js';

export interface FieldConflict {
  field: string;
  /** Which side's value survived. */
  winner: 'local' | 'remote';
  localT: string;
  remoteT: string;
}

export interface MergeOutcome {
  fields: Record<string, FieldRec>;
  vv: Record<string, number>;
  del?: { t: string; c: number };
  /** Fields whose value (or removal) must be copied from the incoming document. */
  takeRemote: string[];
  /** Local fields killed by a tombstone and to be dropped from the stored document. */
  dropLocal: string[];
  /** The merged document is deleted. */
  deleted: boolean;
  /** The merged record differs from the local one. */
  changed: boolean;
  /** The merged record is exactly the incoming one (so nothing needs echoing back). */
  equalsRemote: boolean;
  conflicts: FieldConflict[];
}

function seen(vv: Record<string, number>, t: string, c: number): boolean {
  return (vv[stampNode(t)] ?? 0) >= c;
}

/** Stamps minted when pre-existing data was first tracked sit at wall time zero. */
function isBaseline(t: string): boolean {
  return stampWall(t) === 0;
}

function remoteHash(field: WireField): number {
  return field.x ? 0 : hashEncoded(field.v);
}

export function mergeRecords(local: DocRec | undefined, remote: WireDoc): MergeOutcome {
  const localFields = local?.fields ?? {};
  const localVv = local?.vv ?? {};
  const localDel = local?.del;

  let del = localDel;
  if (remote.del && (!del || remote.del.t > del.t)) del = remote.del;

  const fields: Record<string, FieldRec> = {};
  const takeRemote: string[] = [];
  const dropLocal: string[] = [];
  const conflicts: FieldConflict[] = [];

  for (const [name, r] of Object.entries(remote.fields)) {
    const l = localFields[name];
    if (!l) {
      takeRemote.push(name);
      fields[name] = { t: r.t, c: r.c, h: remoteHash(r), ...(r.x ? { x: 1 as const } : {}) };
      continue;
    }
    if (l.t === r.t) {
      fields[name] = l;
      continue;
    }
    const remoteWins = r.t > l.t;
    // A baseline stamp (data that predates tracking) is not an edit, so losing to one
    // or beating one is never a conflict.
    if (!isBaseline(l.t) && !isBaseline(r.t) && !seen(localVv, r.t, r.c) && !seen(remote.vv, l.t, l.c)) {
      const rh = remoteHash(r);
      const lh = l.x ? 0 : l.h;
      if (rh !== lh || Boolean(l.x) !== Boolean(r.x)) {
        conflicts.push({
          field: name,
          winner: remoteWins ? 'remote' : 'local',
          localT: l.t,
          remoteT: r.t,
        });
      }
    }
    if (remoteWins) {
      takeRemote.push(name);
      fields[name] = { t: r.t, c: r.c, h: remoteHash(r), ...(r.x ? { x: 1 as const } : {}) };
    } else {
      fields[name] = l;
    }
  }
  for (const [name, l] of Object.entries(localFields)) {
    if (!(name in fields)) fields[name] = l;
  }

  if (del) {
    // Delete wins: a tombstone kills every field, however late a concurrent edit was
    // stamped. Letting a later edit "resurrect" would rebuild the document from only
    // the fields written since, a task with a description and no title.
    for (const name of Object.keys(fields)) {
      if (name in localFields) dropLocal.push(name);
      delete fields[name];
    }
    takeRemote.length = 0;
    conflicts.length = 0;
  }

  const vv: Record<string, number> = { ...localVv };
  for (const [node, counter] of Object.entries(remote.vv)) {
    if ((vv[node] ?? 0) < counter) vv[node] = counter;
  }

  const live = Object.keys(fields).length > 0;
  const deleted = !live;

  const localLive = local ? Object.keys(local.fields).length > 0 : false;
  const delChanged = (del?.t ?? '') !== (localDel?.t ?? '');
  const vvChanged = Object.keys(vv).some((node) => (localVv[node] ?? 0) !== vv[node]);
  const changed =
    !local || takeRemote.length > 0 || dropLocal.length > 0 || delChanged || vvChanged || localLive !== live;

  const remoteNames = Object.keys(remote.fields);
  const mergedNames = Object.keys(fields);
  let equalsRemote =
    mergedNames.length === remoteNames.length &&
    (del?.t ?? '') === (remote.del?.t ?? '') &&
    Object.keys(vv).length === Object.keys(remote.vv).length &&
    Object.entries(vv).every(([node, counter]) => remote.vv[node] === counter);
  if (equalsRemote) {
    for (const name of mergedNames) {
      if (remote.fields[name]?.t !== fields[name]!.t) {
        equalsRemote = false;
        break;
      }
    }
  }

  return { fields, vv, del, takeRemote, dropLocal, deleted, changed, equalsRemote, conflicts };
}
