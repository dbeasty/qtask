#!/usr/bin/env npx tsx
/**
 * Diagnose why a shared project may appear empty to a collaborator.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/diagnose-project-share.ts --project-name "My Project"
 *   MONGODB_URI=... npx tsx scripts/diagnose-project-share.ts --project-id 507f1f77bcf86cd799439011
 *   MONGODB_URI=... npx tsx scripts/diagnose-project-share.ts --project-id ... --collaborator-email bob@example.com
 */
import mongoose from 'mongoose';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      args[key.slice(2)] = value;
      i++;
    }
  }
  return args;
}

async function getDescendantIds(
  Project: mongoose.Model<unknown>,
  rootId: string
): Promise<string[]> {
  const descendants: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await Project.find({
      parentId: { $in: frontier },
      staging: { $exists: false },
    })
      .select('_id name parentId collaborators')
      .lean();
    const childIds = children.map((c) => String((c as { _id: unknown })._id));
    descendants.push(...childIds);
    frontier = childIds;
  }
  return descendants;
}

async function countTasksForProject(
  Task: mongoose.Model<unknown>,
  projectId: string
): Promise<number> {
  return Task.countDocuments({
    staging: { $exists: false },
    $or: [{ projectIds: projectId }, { projectId: projectId }],
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Set MONGODB_URI');
    process.exit(1);
  }

  if (!args['project-name'] && !args['project-id']) {
    console.error('Provide --project-name or --project-id');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const Project = mongoose.model(
    'Project',
    new mongoose.Schema({}, { strict: false }),
    'projects'
  );
  const Task = mongoose.model('Task', new mongoose.Schema({}, { strict: false }), 'tasks');
  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');

  const projectQuery = args['project-id']
    ? { _id: new mongoose.Types.ObjectId(args['project-id']) }
    : { name: args['project-name'] };

  const project = (await Project.findOne(projectQuery).lean()) as {
    _id: unknown;
    name: string;
    userId: string;
    parentId?: string | null;
    collaborators?: Array<{ userId: string; role: string }>;
  } | null;

  if (!project) {
    console.error('Project not found');
    process.exit(1);
  }

  const projectId = String(project._id);
  const owner = (await User.findById(project.userId).select('email').lean()) as {
    email?: string;
  } | null;

  console.log('\n=== Project ===');
  console.log(JSON.stringify({ id: projectId, name: project.name, ownerEmail: owner?.email }, null, 2));
  console.log('Collaborators:', project.collaborators ?? []);

  const descendantIds = await getDescendantIds(Project, projectId);
  const directTasks = await countTasksForProject(Task, projectId);
  let descendantTasks = 0;
  for (const childId of descendantIds) {
    descendantTasks += await countTasksForProject(Task, childId);
  }

  const stagedTasks = await Task.countDocuments({
    staging: { $exists: true },
    $or: [{ projectIds: projectId }, { projectId: projectId }],
  });

  console.log('\n=== Task counts ===');
  console.log({
    directTasksInProject: directTasks,
    descendantProjects: descendantIds.length,
    tasksInDescendantProjects: descendantTasks,
    stagedTasksHiddenFromCollaborators: stagedTasks,
  });

  if (descendantIds.length > 0) {
    console.log('\n=== Descendant projects ===');
    for (const childId of descendantIds) {
      const child = (await Project.findById(childId).select('name collaborators').lean()) as {
        name?: string;
        collaborators?: unknown[];
      } | null;
      const taskCount = await countTasksForProject(Task, childId);
      console.log({
        id: childId,
        name: child?.name,
        taskCount,
        collaboratorCount: (child?.collaborators ?? []).length,
      });
    }
  }

  if (args['collaborator-email']) {
    const email = args['collaborator-email'].trim().toLowerCase();
    const user = (await User.findOne({ email }).select('_id email').lean()) as {
      _id: unknown;
      email: string;
    } | null;
    console.log('\n=== Collaborator access check ===');
    if (!user) {
      console.log({ email, registered: false });
    } else {
      const userId = String(user._id);
      const onProject = (project.collaborators ?? []).some((c) => c.userId === userId);
      const accessibleProjectIds = [projectId, ...descendantIds].filter(async (id) => {
        const p = (await Project.findById(id).select('collaborators userId').lean()) as {
          userId: string;
          collaborators?: Array<{ userId: string }>;
        } | null;
        return p?.userId === userId || (p?.collaborators ?? []).some((c) => c.userId === userId);
      });
      // sync check for root only (pre-cascade diagnosis)
      console.log({
        email,
        userId,
        collaboratorOnSharedProject: onProject,
        likelyDiagnosis:
          directTasks === 0 && descendantTasks > 0
            ? 'Tasks are in sub-projects; collaborator may lack access to child projects (fixed by cascade on accept)'
            : directTasks === 0 && descendantTasks === 0 && stagedTasks > 0
              ? 'Tasks are still in agent staging'
              : directTasks === 0 && descendantTasks === 0
                ? 'No tasks linked to this project tree — tasks may be in a different project'
                : 'Tasks exist; check collaborator membership and API access',
      });
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
