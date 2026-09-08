import { collection } from '../data/index.js';
import type { ConversationDoc, ProjectDoc, TaskDoc } from '../data/documents.js';

function projectDocs() {
  return collection<ProjectDoc>('projects');
}

function taskDocs() {
  return collection<TaskDoc>('tasks');
}

function conversationDocs() {
  return collection<ConversationDoc>('conversations');
}

function callMetrics() {
  return collection('llmCallMetrics');
}

function dailyMetrics() {
  return collection('llmDailyMetrics');
}
import mongoose from 'mongoose';

const DEFAULT_PROJECT_NAME = 'Project One';

/**
 * One-shot data migrations for nested projects, multi-project tasks, and scoped agent sessions.
 */
export async function runDataMigrations(): Promise<void> {
  await migrateTaskProjectIds();
  await migrateProjectHierarchyDefaults();
  await migrateProjectProgressDefaults();
  await migrateConversationProjectIds();
  await migrateSearchEmbeddingBackfill();
  await migrateLlmMetricsCallTypes();
}

async function migrateTaskProjectIds(): Promise<void> {
  const legacy = await taskDocs().find({
    $or: [
      { projectIds: { $exists: false } },
      { projectIds: { $size: 0 } },
      { projectIds: null },
    ],
  }, { select: '_id projectId projectIds userId' });

  for (const task of legacy) {
    const ids: string[] = [];
    if (Array.isArray(task.projectIds) && task.projectIds.length > 0) {
      ids.push(...task.projectIds.map(String));
    } else if (task.projectId) {
      ids.push(String(task.projectId));
    }

    if (ids.length === 0 && task.userId) {
      let defaultProject = await projectDocs().findOne({
        userId: task.userId,
        staging: { $exists: false },
      }, { sort: { createdAt: 1 }, select: '_id' });
      if (!defaultProject) {
        const created = await projectDocs().create({
          userId: task.userId,
          name: DEFAULT_PROJECT_NAME,
          collaborators: [],
          parentId: null,
          sortOrder: 0,
        });
        ids.push(String(created._id));
      } else {
        ids.push(String(defaultProject._id));
      }
    }

    await taskDocs().updateOne(
      { _id: task._id },
      { $set: { projectIds: [...new Set(ids)], projectId: ids[0] } }
    );
  }
}

async function migrateProjectHierarchyDefaults(): Promise<void> {
  await projectDocs().updateMany(
    { parentId: { $exists: false } },
    { $set: { parentId: null } }
  );
  await projectDocs().updateMany(
    { sortOrder: { $exists: false } },
    { $set: { sortOrder: 0 } }
  );

  // Assign sibling sortOrder for projects that share a parent and all have 0.
  // Was a $group aggregation. The data layer has no pipeline, and counting in
  // process over one startup migration is the same work without a second query
  // dialect to support on both backends.
  const unstaged = await projectDocs().find(
    { staging: { $exists: false } },
    { select: '_id parentId' }
  );
  const countByParent = new Map<string | null, number>();
  for (const project of unstaged) {
    const parentId = (project.parentId ?? null) as string | null;
    countByParent.set(parentId, (countByParent.get(parentId) ?? 0) + 1);
  }
  const parents = [...countByParent].map(([_id, count]) => ({ _id, count }));

  for (const group of parents) {
    if (group.count <= 1) continue;
    const siblings = await projectDocs().find({
      parentId: group._id,
      staging: { $exists: false },
    }, { sort: { createdAt: 1 }, select: '_id sortOrder' });

    const allZero = siblings.every((s) => (s.sortOrder ?? 0) === 0);
    if (!allZero) continue;

    for (let i = 0; i < siblings.length; i++) {
      await projectDocs().updateOne({ _id: siblings[i]!._id }, { $set: { sortOrder: i } });
    }
  }
}

async function migrateProjectProgressDefaults(): Promise<void> {
  await projectDocs().updateMany(
    { status: { $exists: false } },
    { $set: { status: 'todo' } }
  );
  await projectDocs().updateMany(
    { percentComplete: { $exists: false } },
    { $set: { percentComplete: 0 } }
  );

  const { projectService } = await import('../services/projectService.js');
  await projectService.recalculateAllProjects();
}

async function migrateConversationProjectIds(): Promise<void> {
  const conversations = await conversationDocs().find({
    $or: [{ projectId: { $exists: false } }, { projectId: null }, { projectId: '' }],
  }, { select: '_id userId' });

  for (const conversation of conversations) {
    let projectId: string | null = null;
    const existing = await projectDocs().findOne({
      userId: conversation.userId,
      staging: { $exists: false },
    }, { sort: { createdAt: 1 }, select: '_id' });

    if (existing) {
      projectId = String(existing._id);
    } else {
      const created = await projectDocs().create({
        userId: conversation.userId,
        name: DEFAULT_PROJECT_NAME,
        collaborators: [],
        parentId: null,
        sortOrder: 0,
      });
      projectId = String(created._id);
    }

    await conversationDocs().updateOne(
      { _id: conversation._id },
      { $set: { projectId } }
    );
  }
}

async function migrateSearchEmbeddingBackfill(): Promise<void> {
  const meta = await mongoose.connection.collection('app_meta').findOne({ key: 'search_embedding_v1' });
  if (meta) return;

  const { enqueueEmbeddingJob, enqueueProjectEmbeddingJob } = await import(
    '../services/embeddingQueue.js'
  );

  const [tasks, projects] = await Promise.all([
    taskDocs().find({ staging: { $exists: false } }, { select: '_id' }),
    projectDocs().find({ staging: { $exists: false } }, { select: '_id' }),
  ]);

  await Promise.all([
    ...tasks.map((task) => enqueueEmbeddingJob(String(task._id))),
    ...projects.map((project) => enqueueProjectEmbeddingJob(String(project._id))),
  ]);

  await mongoose.connection.collection('app_meta').insertOne({
    key: 'search_embedding_v1',
    at: new Date(),
  });
}

async function migrateLlmMetricsCallTypes(): Promise<void> {
  const key = 'llm_metrics_agent_call_type_v1';
  const done = await mongoose.connection.collection('app_meta').findOne({ key });
  if (done) return;

  await Promise.all([
    callMetrics().updateMany({ callType: 'chat' }, { $set: { callType: 'agent' } }),
    callMetrics().updateMany({ source: 'chat_loop' }, { $set: { source: 'agent_loop' } }),
    dailyMetrics().updateMany({ callType: 'chat' }, { $set: { callType: 'agent' } }),
  ]);

  await mongoose.connection.collection('app_meta').insertOne({ key, at: new Date() });
}
