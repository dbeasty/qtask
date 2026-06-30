import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/qtask',
  defaultUserId: process.env.DEFAULT_USER_ID ?? 'local-user',
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.2',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
  },
} as const;
