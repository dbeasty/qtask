import { config } from '../config/index.js';

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${config.ollama.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.embeddingModel,
      prompt: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
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
}): string {
  const parts = [task.title];
  if (task.description) parts.push(task.description);
  if (task.tags?.length) parts.push(`Tags: ${task.tags.join(', ')}`);
  return parts.join('\n');
}
