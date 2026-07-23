import { config } from '../config/index.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';

export async function generateEmbedding(
  text: string,
  context: {
    userId?: string;
    taskId?: string;
    source: 'embedding_job' | 'semantic_search';
    degradedFallback?: boolean;
  }
): Promise<number[]> {
  const tracker = createLlmCallTracker({
    callType: 'embed',
    source: context.source,
    model: config.ollama.embeddingModel,
    userId: context.userId,
    taskId: context.taskId,
  });

  try {
    const response = await fetch(`${config.ollama.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.embeddingModel,
        prompt: text,
        keep_alive: config.ollama.embeddingKeepAlive,
        options: { num_gpu: config.ollama.embeddingNumGpu },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { embedding: number[] } & OllamaTimingFields;
    tracker.complete(response.status, data);
    return data.embedding;
  } catch (error) {
    tracker.fail(error, undefined, context.degradedFallback);
    throw error;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function buildTaskEmbeddingText(task: {
  title: string;
  description?: string;
  tags?: string[];
  projectNames?: string[];
  steps?: Array<{ text: string }>;
}): string {
  const parts = [task.title];
  if (task.description) parts.push(task.description);
  if (task.tags?.length) parts.push(`Tags: ${task.tags.join(', ')}`);
  if (task.projectNames?.length) parts.push(`Projects: ${task.projectNames.join(', ')}`);
  if (task.steps?.length) {
    parts.push('Steps:');
    for (const step of task.steps) {
      parts.push(`- ${step.text}`);
    }
  }
  return parts.join('\n');
}

export function buildProjectEmbeddingText(project: { name: string; description?: string }): string {
  const parts = [project.name];
  if (project.description) parts.push(project.description);
  return parts.join('\n');
}
