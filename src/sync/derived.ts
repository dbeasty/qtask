/**
 * Post-merge recomputation of derived fields (plan section 5.5).
 *
 * `percentComplete` on tasks, and `percentComplete` / `status` / `trackingRollup` on
 * projects, are functions of other fields. They are excluded from sync records
 * (policy.ts), so a merge never copies one peer's stale figure over another's; after
 * documents change they are recomputed here from the merged inputs, with the same
 * pure functions the services use. Writes go through the tracked store: if a derived
 * `status` actually changes, that is an ordinary local edit.
 */

import { canonicalJson } from './codec.js';
import type { DerivedRecompute } from './engine.js';
import type { SyncDataStore } from './tracker.js';
import type { ReplicatedCollection } from './types.js';
import type { Doc } from '../data/types.js';
import { applyPercentComplete, type PercentCompleteNode } from '../utils/percentComplete.js';
import { computeLeafProjectProgress, computeParentProjectProgress } from '../utils/projectProgress.js';
import {
  computeLeafProjectTracking,
  computeParentProjectTracking,
  toStoredTrackingRollup,
} from '../utils/projectTracking.js';
import type { ProjectStatus } from '../types/project.js';

export interface TouchedDoc {
  coll: ReplicatedCollection;
  id: string;
  /** Projects the document belonged to before it was changed or deleted. */
  projectHints?: string[];
}

function projectIdsOf(doc: Doc | null | undefined): string[] {
  if (!doc) return [];
  const ids = new Set<string>();
  if (typeof doc.projectId === 'string' && doc.projectId) ids.add(doc.projectId);
  if (Array.isArray(doc.projectIds)) {
    for (const id of doc.projectIds) if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

export function projectHintsFor(coll: ReplicatedCollection, id: string, doc: Doc | null | undefined): string[] {
  if (coll === 'projects') return [id];
  if (coll === 'tasks') return projectIdsOf(doc);
  return [];
}

export function createDefaultDerived(): DerivedRecompute {
  return {
    async recompute(store, touched) {
      const projectIds = new Set<string>();

      const taskIds = touched.filter((t) => t.coll === 'tasks').map((t) => t.id);
      for (let i = 0; i < taskIds.length; i += 500) {
        const chunk = taskIds.slice(i, i + 500);
        const tasks = await store.collection('tasks').find({ _id: { $in: chunk } });
        for (const task of tasks) {
          await recomputeTask(store, task);
          for (const id of projectIdsOf(task)) projectIds.add(id);
        }
      }
      for (const t of touched) {
        for (const hint of (t as TouchedDoc).projectHints ?? []) projectIds.add(hint);
        if (t.coll === 'projects') projectIds.add(t.id);
      }
      await recomputeProjects(store, [...projectIds]);
    },
  };
}

async function recomputeTask(store: SyncDataStore, task: Doc): Promise<void> {
  const node = task as unknown as PercentCompleteNode & Doc;
  // Stored tasks always carry a percentComplete (schema default); tolerate one that does not.
  const computed = applyPercentComplete({ ...node, percentComplete: node.percentComplete ?? 0 }) as unknown as Doc;
  const set: Doc = {};
  if (computed.percentComplete !== task.percentComplete) set.percentComplete = computed.percentComplete;
  if (computed.status !== task.status) set.status = computed.status;
  if (canonicalJson(computed.subtasks ?? []) !== canonicalJson(task.subtasks ?? [])) set.subtasks = computed.subtasks;
  if (Object.keys(set).length > 0) await store.collection('tasks').updateOne({ _id: String(task._id) }, { $set: set });
}

/** Recomputes the given projects and their ancestors, children before parents. */
export async function recomputeProjects(store: SyncDataStore, projectIds: string[]): Promise<void> {
  const projects = store.collection('projects');
  const chain = new Set<string>();
  const depthOf = new Map<string, number>();
  for (const start of projectIds) {
    let cursor: string | undefined | null = start;
    const walk: string[] = [];
    while (cursor && !chain.has(cursor) && !walk.includes(cursor)) {
      const project: Doc | null = await projects.findById(cursor, { select: '_id parentId' });
      if (!project) break;
      walk.push(cursor);
      cursor = typeof project.parentId === 'string' ? project.parentId : null;
    }
    walk.forEach((id, index) => {
      chain.add(id);
      // Distance from the start: smaller runs first, ancestors later.
      depthOf.set(id, Math.min(depthOf.get(id) ?? Infinity, index));
    });
  }
  const ordered = [...chain].sort((a, b) => (depthOf.get(a) ?? 0) - (depthOf.get(b) ?? 0));
  for (const id of ordered) await recomputeProject(store, id);
}

async function recomputeProject(store: SyncDataStore, projectId: string): Promise<void> {
  const projects = store.collection('projects');
  const tasks = store.collection('tasks');
  const project = await projects.findById(projectId);
  if (!project) return;

  const children = await projects.find({ parentId: projectId, staging: { $exists: false } });
  let percentComplete: number;
  let status: ProjectStatus;
  let totals;
  const rates = { hourlyRate: (project.hourlyRate as number | null | undefined) ?? undefined };

  if (children.length > 0) {
    const progress = computeParentProjectProgress(
      children.map((child) => ({
        status: ((child.status as ProjectStatus) ?? 'todo'),
        percentComplete: (child.percentComplete as number) ?? 0,
        progressShare: child.progressShare as number | undefined,
      }))
    );
    percentComplete = progress.percentComplete;
    status = progress.status;
    totals = computeParentProjectTracking(
      children.map((child) => ({
        progressShare: child.progressShare as number | undefined,
        trackingRollup: child.trackingRollup
          ? {
              hoursSpent: (child.trackingRollup as Doc).hoursSpent as number ?? 0,
              hoursRemaining: (child.trackingRollup as Doc).hoursRemaining as number ?? 0,
              materialsTotal: (child.trackingRollup as Doc).materialsTotal as number ?? 0,
              laborCost: (child.trackingRollup as Doc).laborCost as number ?? 0,
              totalCost: (child.trackingRollup as Doc).totalCost as number ?? 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined,
      })),
      rates
    ).totals;
  } else {
    const linked = await tasks.find({
      staging: { $exists: false },
      $or: [{ projectIds: projectId }, { projectId }],
    });
    const progress = computeLeafProjectProgress(
      linked.map((task) => ({
        status: ((task.status as ProjectStatus) ?? 'todo'),
        percentComplete: (task.percentComplete as number) ?? 0,
      }))
    );
    percentComplete = progress.percentComplete;
    status = progress.status;
    totals = computeLeafProjectTracking(linked as Doc[], rates).totals;
  }

  if (project.doneOverride) {
    status = 'done';
    percentComplete = 100;
  }

  const rollup = toStoredTrackingRollup(totals);
  const previous = (project.trackingRollup ?? {}) as Doc;
  const sameTotals = (['hoursSpent', 'hoursRemaining', 'materialsTotal', 'laborCost', 'totalCost'] as const).every(
    (key) => (previous[key] ?? 0) === (rollup[key] ?? 0)
  );
  const set: Doc = {};
  if (project.status !== status) set.status = status;
  if (project.percentComplete !== percentComplete) set.percentComplete = percentComplete;
  if (!sameTotals || !project.trackingRollup) {
    set.trackingRollup = { ...rollup, updatedAt: new Date(rollup.updatedAt) };
  }
  if (Object.keys(set).length > 0) await projects.updateOne({ _id: projectId }, { $set: set });
}
