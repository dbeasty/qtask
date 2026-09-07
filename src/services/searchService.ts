import { collection } from '../data/index.js';
import type { ProjectDoc, TaskDoc } from '../data/documents.js';
import type { SearchHit, SearchResults } from '../types/search.js';
import type { TaskSearchFilters } from '../types/task.js';
import { applyPercentComplete } from '../utils/percentComplete.js';
import { serializeTask } from '../utils/serialization.js';
import { cosineSimilarity, generateEmbedding } from './embeddingService.js';
import { escapeRegex, lexicalScore, mergeHybridSearchScores, tokenizeForSearch } from './searchUtils.js';
import type { CollectionName } from '../data/types.js';

/** Weighted text fields per collection — the equivalent of the text indexes the
 *  schemas used to declare for `$text`. */
const TASK_TEXT_FIELDS: Array<{ path: string; weight: number }> = [
  { path: 'title', weight: 3 },
  { path: 'description', weight: 1 },
  { path: 'tags', weight: 2 },
  { path: 'steps.text', weight: 1 },
];

const PROJECT_TEXT_FIELDS: Array<{ path: string; weight: number }> = [
  { path: 'name', weight: 3 },
  { path: 'description', weight: 1 },
  { path: 'notes', weight: 1 },
];

/**
 * The lexical arm of hybrid search, replacing Mongo's `$text` for both backends.
 * Loads the same bounded candidate set the semantic arm uses, scores it in process,
 * and returns the hits ranked. See lexicalScore for what this trades away.
 */
async function textSearch<T>(
  name: CollectionName,
  baseQuery: Record<string, unknown>,
  queryText: string,
  fields: Array<{ path: string; weight: number }>
): Promise<T[]> {
  const terms = tokenizeForSearch(queryText);
  if (terms.length === 0) return [];

  const candidates = await collection(name).find(baseQuery, {
    sort: { updatedAt: -1 },
    limit: MAX_CANDIDATES,
  });

  return candidates
    .map((doc) => ({ doc, score: lexicalScore(textValuesOf(doc, fields), terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.doc as T);
}

/** Flattens the weighted fields of one document into scorable text. */
function textValuesOf(
  doc: Record<string, unknown>,
  fields: Array<{ path: string; weight: number }>
): Array<{ text: string; weight: number }> {
  const out: Array<{ text: string; weight: number }> = [];
  for (const { path, weight } of fields) {
    for (const value of valuesAtPath(doc, path)) {
      if (typeof value === 'string' && value.length > 0) out.push({ text: value, weight });
    }
  }
  return out;
}

function valuesAtPath(source: unknown, path: string): unknown[] {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return [source];
  if (Array.isArray(source)) return source.flatMap((item) => valuesAtPath(item, path));
  if (typeof source !== 'object' || source === null) return [];
  const next = (source as Record<string, unknown>)[head];
  if (rest.length === 0) return Array.isArray(next) ? next : [next];
  return valuesAtPath(next, rest.join('.'));
}

const SEMANTIC_THRESHOLD = 0.6;
/** Caps how many documents a single search loads into memory for
 *  in-process cosine-similarity scoring / regex fallback matching, so a
 *  user with thousands of accessible tasks doesn't turn every search into
 *  a full-collection scan held entirely in memory. */
const MAX_CANDIDATES = 500;

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
  notes?: string;
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
    Boolean(project.description && regex.test(project.description)) ||
    Boolean(project.notes && regex.test(project.notes))
  );
}

async function resolveProjectNameMap(tasks: LeanTask[]): Promise<Map<string, string>> {
  const projectIds = new Set<string>();
  for (const task of tasks) {
    for (const id of task.projectIds ?? []) projectIds.add(String(id));
    if (task.projectId) projectIds.add(String(task.projectId));
  }

  if (projectIds.size === 0) return new Map();

  const projectDocs = await collection<ProjectDoc>('projects').find(
    { _id: { $in: [...projectIds] } },
    { select: '_id name' }
  );

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
    findCandidates: (query: Record<string, unknown>, limit: number) => Promise<T[]>;
    matchesRegex: (item: T, regex: RegExp) => boolean;
  },
  options?: { hybridSearch?: boolean }
): Promise<Array<{ item: T; score: number }>> {
  const textMatches = await model.findText(baseQuery, queryText);
  const enableSemantic = options?.hybridSearch !== false;
  const semanticMatches = enableSemantic
    ? await semanticScoreCandidates(
        userId,
        queryText,
        await model.findCandidates(
          {
            ...baseQuery,
            embedding: { $exists: true, $ne: [] },
          },
          MAX_CANDIDATES
        )
      )
    : [];
  const merged = mergeHybridSearchScores(textMatches, semanticMatches, (item) => String(item._id));

  if (merged.length > 0) return merged;

  const regex = new RegExp(escapeRegex(queryText), 'i');
  const fallbackCandidates = await model.findCandidates(baseQuery, MAX_CANDIDATES);
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
      textSearch<LeanProject>('projects', query, search, PROJECT_TEXT_FIELDS),
    findCandidates: async (query, limit) =>
      collection<ProjectDoc>('projects').find(query, {
        sort: { updatedAt: -1 },
        limit,
      }) as unknown as Promise<LeanProject[]>,
    matchesRegex: projectMatchesRegex,
  });

  return merged.slice(0, limit).map(({ item, score }) => ({
    id: String(item._id),
    type: 'project' as const,
    title: item.name,
    snippet: item.description?.trim() || item.notes?.trim() || undefined,
    score,
    status: item.status,
  }));
}

async function searchTasksInternal(
  userId: string,
  queryText: string,
  filters: TaskSearchFilters,
  limit: number,
  options?: { hybridSearch?: boolean }
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
    findText: async (query, search) => textSearch<LeanTask>('tasks', query, search, TASK_TEXT_FIELDS),
    findCandidates: async (query, limit) =>
      collection<TaskDoc>('tasks').find(query, {
        sort: { updatedAt: -1 },
        limit,
      }) as unknown as Promise<LeanTask[]>,
    matchesRegex: taskMatchesRegex,
  }, options);

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
    limit?: number,
    options?: { hybridSearch?: boolean }
  ): Promise<Array<Record<string, unknown>>> {
    const queryText = filters.query?.trim();
    if (!queryText) {
      return [];
    }

    const hits = await searchTasksInternal(
      userId,
      queryText,
      filters,
      limit ?? Number.MAX_SAFE_INTEGER,
      options
    );
    if (hits.length === 0) return [];

    const tasks = await collection<TaskDoc>('tasks').find({
      _id: { $in: hits.map((hit) => hit.id) },
    });
    const taskMap = new Map(tasks.map((task) => [String(task._id), task]));
    const ordered = hits
      .map((hit) => taskMap.get(hit.id))
      .filter(Boolean)
      .map((task) =>
        serializeTask(
          applyPercentComplete(task as unknown as Parameters<typeof applyPercentComplete>[0]) as unknown as Record<
            string,
            unknown
          >
        )
      );

    return ordered;
  }
}

export const searchService = new SearchService();
