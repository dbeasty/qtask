import { ProjectModel, TaskModel } from '../models/index.js';
import type { SearchHit, SearchResults } from '../types/search.js';
import type { TaskSearchFilters } from '../types/task.js';
import { applyPercentComplete } from '../utils/percentComplete.js';
import { serializeTask } from '../utils/serialization.js';
import { cosineSimilarity, generateEmbedding } from './embeddingService.js';
import { escapeRegex, mergeHybridSearchScores } from './searchUtils.js';

const SEMANTIC_THRESHOLD = 0.3;

type LeanTask = Record<string, unknown> & {
  _id: unknown;
  title: string;
  description?: string;
  tags?: string[];
  steps?: Array<{ text: string }>;
  status?: string;
  projectIds?: string[];
  projectId?: string;
  embedding?: number[];
};

type LeanProject = Record<string, unknown> & {
  _id: unknown;
  name: string;
  description?: string;
  status?: string;
  embedding?: number[];
};

async function projects() {
  const { projectService } = await import('./projectService.js');
  return projectService;
}

async function accessibleTaskQuery(userId: string): Promise<Record<string, unknown>> {
  const projectIds = await (await projects()).listAccessibleProjectIds(userId);
  if (projectIds.length === 0) {
    return { userId };
  }
  return {
    $or: [{ userId }, { projectIds: { $in: projectIds } }, { projectId: { $in: projectIds } }],
  };
}

function buildTaskBaseQuery(userId: string, filters: TaskSearchFilters = {}): Record<string, unknown> {
  const query: Record<string, unknown> = {
    staging: { $exists: false },
  };

  if (filters.status) {
    query.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
  }
  if (filters.priority) {
    query.priority = Array.isArray(filters.priority) ? { $in: filters.priority } : filters.priority;
  }
  if (filters.projectId) {
    query.$and = [
      ...(Array.isArray(query.$and) ? (query.$and as unknown[]) : []),
      {
        $or: [{ projectIds: filters.projectId }, { projectId: filters.projectId }],
      },
    ];
  }
  if (filters.assigneeId) query.assigneeId = filters.assigneeId;
  if (filters.tags?.length) query.tags = { $all: filters.tags };
  if (filters.dueBefore || filters.dueAfter) {
    query.dueDate = {};
    if (filters.dueBefore) (query.dueDate as Record<string, Date>).$lte = new Date(filters.dueBefore);
    if (filters.dueAfter) (query.dueDate as Record<string, Date>).$gte = new Date(filters.dueAfter);
  }

  return query;
}

async function semanticScoreCandidates<T extends { embedding?: number[] }>(
  userId: string,
  queryText: string,
  candidates: T[]
): Promise<Array<{ item: T; score: number }>> {
  try {
    const queryEmbedding = await generateEmbedding(queryText, {
      userId,
      source: 'semantic_search',
      degradedFallback: true,
    });

    return candidates
      .map((item) => ({
        item,
        score: cosineSimilarity(queryEmbedding, item.embedding ?? []),
      }))
      .filter((entry) => entry.score > SEMANTIC_THRESHOLD)
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

function taskMatchesRegex(task: LeanTask, regex: RegExp): boolean {
  return (
    regex.test(task.title) ||
    Boolean(task.description && regex.test(task.description)) ||
    (task.tags ?? []).some((tag) => regex.test(tag)) ||
    (task.steps ?? []).some((step) => regex.test(step.text))
  );
}

function projectMatchesRegex(project: LeanProject, regex: RegExp): boolean {
  return (
    regex.test(project.name) ||
    Boolean(project.description && regex.test(project.description))
  );
}

async function resolveProjectNameMap(tasks: LeanTask[]): Promise<Map<string, string>> {
  const projectIds = new Set<string>();
  for (const task of tasks) {
    for (const id of task.projectIds ?? []) projectIds.add(String(id));
    if (task.projectId) projectIds.add(String(task.projectId));
  }

  if (projectIds.size === 0) return new Map();

  const projectDocs = await ProjectModel.find({ _id: { $in: [...projectIds] } })
    .select('_id name')
    .lean();

  return new Map(projectDocs.map((project) => [String(project._id), project.name]));
}

function taskProjectNames(task: LeanTask, projectNameMap: Map<string, string>): string[] {
  const ids = [
    ...(task.projectIds ?? []).map(String),
    ...(task.projectId ? [String(task.projectId)] : []),
  ];
  const names = ids.map((id) => projectNameMap.get(id)).filter(Boolean) as string[];
  return [...new Set(names)];
}

function buildTaskSnippet(task: LeanTask, projectNames: string[]): string | undefined {
  const parts: string[] = [];
  if (task.description?.trim()) parts.push(task.description.trim());
  if (projectNames.length > 0) parts.push(`Projects: ${projectNames.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

async function hybridSearch<T extends { _id: unknown; embedding?: number[] }>(
  userId: string,
  queryText: string,
  baseQuery: Record<string, unknown>,
  model: {
    findText: (query: Record<string, unknown>, search: string) => Promise<T[]>;
    findCandidates: (query: Record<string, unknown>) => Promise<T[]>;
    matchesRegex: (item: T, regex: RegExp) => boolean;
  }
): Promise<Array<{ item: T; score: number }>> {
  const textMatches = await model.findText(baseQuery, queryText);
  const candidates = await model.findCandidates({
    ...baseQuery,
    embedding: { $exists: true, $ne: [] },
  });
  const semanticMatches = await semanticScoreCandidates(userId, queryText, candidates);
  const merged = mergeHybridSearchScores(textMatches, semanticMatches, (item) => String(item._id));

  if (merged.length > 0) return merged;

  const regex = new RegExp(escapeRegex(queryText), 'i');
  const fallbackCandidates = await model.findCandidates(baseQuery);
  return fallbackCandidates
    .filter((item) => model.matchesRegex(item, regex))
    .map((item, index) => ({ item, score: 0.5 - index * 0.01 }));
}

async function searchProjectsInternal(
  userId: string,
  queryText: string,
  limit: number
): Promise<SearchHit[]> {
  const baseQuery = (await projects()).accessibleProjectFilter(userId);

  const merged = await hybridSearch<LeanProject>(userId, queryText, baseQuery, {
    findText: async (query, search) =>
      ProjectModel.find({ ...query, $text: { $search: search } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .lean() as Promise<LeanProject[]>,
    findCandidates: async (query) => ProjectModel.find(query).lean() as Promise<LeanProject[]>,
    matchesRegex: projectMatchesRegex,
  });

  return merged.slice(0, limit).map(({ item, score }) => ({
    id: String(item._id),
    type: 'project' as const,
    title: item.name,
    snippet: item.description?.trim() || undefined,
    score,
    status: item.status,
  }));
}

async function searchTasksInternal(
  userId: string,
  queryText: string,
  filters: TaskSearchFilters,
  limit: number
): Promise<SearchHit[]> {
  if (filters.projectId) {
    await (await projects()).assertProjectAccess(userId, filters.projectId, 'viewer');
  }

  const accessQuery = await accessibleTaskQuery(userId);
  const baseQuery = {
    ...accessQuery,
    ...buildTaskBaseQuery(userId, filters),
  };

  const merged = await hybridSearch<LeanTask>(userId, queryText, baseQuery, {
    findText: async (query, search) =>
      TaskModel.find({ ...query, $text: { $search: search } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .lean() as Promise<LeanTask[]>,
    findCandidates: async (query) => TaskModel.find(query).lean() as Promise<LeanTask[]>,
    matchesRegex: taskMatchesRegex,
  });

  const topMatches = merged.slice(0, limit).map(({ item }) => item);
  const projectNameMap = await resolveProjectNameMap(topMatches);

  return merged.slice(0, limit).map(({ item, score }) => {
    const names = taskProjectNames(item, projectNameMap);
    return {
      id: String(item._id),
      type: 'task' as const,
      title: item.title,
      snippet: buildTaskSnippet(item, names),
      score,
      projectNames: names.length > 0 ? names : undefined,
      status: item.status,
    };
  });
}

class SearchService {
  async search(
    userId: string,
    query: string,
    options?: { projectLimit?: number; taskLimit?: number }
  ): Promise<SearchResults> {
    const queryText = query.trim();
    if (!queryText) {
      return { projects: [], tasks: [] };
    }

    const [projects, tasks] = await Promise.all([
      searchProjectsInternal(userId, queryText, options?.projectLimit ?? 10),
      searchTasksInternal(userId, queryText, {}, options?.taskLimit ?? 20),
    ]);

    return { projects, tasks };
  }

  async searchTasksWithFilters(
    userId: string,
    filters: TaskSearchFilters,
    limit?: number
  ): Promise<Array<Record<string, unknown>>> {
    const queryText = filters.query?.trim();
    if (!queryText) {
      return [];
    }

    const hits = await searchTasksInternal(
      userId,
      queryText,
      filters,
      limit ?? Number.MAX_SAFE_INTEGER
    );
    if (hits.length === 0) return [];

    const tasks = await TaskModel.find({ _id: { $in: hits.map((hit) => hit.id) } }).lean();
    const taskMap = new Map(tasks.map((task) => [String(task._id), task]));
    const ordered = hits
      .map((hit) => taskMap.get(hit.id))
      .filter(Boolean)
      .map((task) =>
        serializeTask(
          applyPercentComplete(task as Parameters<typeof applyPercentComplete>[0]) as unknown as Record<
            string,
            unknown
          >
        )
      );

    return ordered;
  }
}

export const searchService = new SearchService();
