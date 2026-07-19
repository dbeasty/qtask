import { ConversationModel, ProjectModel, TaskModel } from '../models/index.js';

const DEFAULT_PROJECT_NAME = 'Project One';

/**
 * One-shot data migrations for nested projects, multi-project tasks, and scoped chats.
 */
export async function runDataMigrations(): Promise<void> {
  await migrateTaskProjectIds();
  await migrateProjectHierarchyDefaults();
  await migrateProjectProgressDefaults();
  await migrateConversationProjectIds();
}

async function migrateTaskProjectIds(): Promise<void> {
  const legacy = await TaskModel.find({
    $or: [
      { projectIds: { $exists: false } },
      { projectIds: { $size: 0 } },
      { projectIds: null },
    ],
  })
    .select('_id projectId projectIds userId')
    .lean();

  for (const task of legacy) {
    const ids: string[] = [];
    if (Array.isArray(task.projectIds) && task.projectIds.length > 0) {
      ids.push(...task.projectIds.map(String));
    } else if (task.projectId) {
      ids.push(String(task.projectId));
    }

    if (ids.length === 0 && task.userId) {
      let defaultProject = await ProjectModel.findOne({
        userId: task.userId,
        staging: { $exists: false },
      })
        .sort({ createdAt: 1 })
        .select('_id')
        .lean();
      if (!defaultProject) {
        const created = await ProjectModel.create({
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

    await TaskModel.updateOne(
      { _id: task._id },
      { $set: { projectIds: [...new Set(ids)], projectId: ids[0] } }
    );
  }
}

async function migrateProjectHierarchyDefaults(): Promise<void> {
  await ProjectModel.updateMany(
    { parentId: { $exists: false } },
    { $set: { parentId: null } }
  );
  await ProjectModel.updateMany(
    { sortOrder: { $exists: false } },
    { $set: { sortOrder: 0 } }
  );

  // Assign sibling sortOrder for projects that share a parent and all have 0.
  const parents = await ProjectModel.aggregate<{ _id: string | null; count: number }>([
    { $match: { staging: { $exists: false } } },
    { $group: { _id: '$parentId', count: { $sum: 1 } } },
  ]);

  for (const group of parents) {
    if (group.count <= 1) continue;
    const siblings = await ProjectModel.find({
      parentId: group._id,
      staging: { $exists: false },
    })
      .sort({ createdAt: 1 })
      .select('_id sortOrder')
      .lean();

    const allZero = siblings.every((s) => (s.sortOrder ?? 0) === 0);
    if (!allZero) continue;

    for (let i = 0; i < siblings.length; i++) {
      await ProjectModel.updateOne({ _id: siblings[i]!._id }, { $set: { sortOrder: i } });
    }
  }
}

async function migrateProjectProgressDefaults(): Promise<void> {
  await ProjectModel.updateMany(
    { status: { $exists: false } },
    { $set: { status: 'todo' } }
  );
  await ProjectModel.updateMany(
    { percentComplete: { $exists: false } },
    { $set: { percentComplete: 0 } }
  );

  const { projectService } = await import('../services/projectService.js');
  await projectService.recalculateAllProjects();
}

async function migrateConversationProjectIds(): Promise<void> {
  const conversations = await ConversationModel.find({
    $or: [{ projectId: { $exists: false } }, { projectId: null }, { projectId: '' }],
  })
    .select('_id userId')
    .lean();

  for (const conversation of conversations) {
    let projectId: string | null = null;
    const existing = await ProjectModel.findOne({
      userId: conversation.userId,
      staging: { $exists: false },
    })
      .sort({ createdAt: 1 })
      .select('_id')
      .lean();

    if (existing) {
      projectId = String(existing._id);
    } else {
      const created = await ProjectModel.create({
        userId: conversation.userId,
        name: DEFAULT_PROJECT_NAME,
        collaborators: [],
        parentId: null,
        sortOrder: 0,
      });
      projectId = String(created._id);
    }

    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { projectId } }
    );
  }
}
