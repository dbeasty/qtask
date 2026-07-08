import 'dotenv/config';

function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value) return value;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
  return devFallback;
}

function requireSmtpHost(): string | undefined {
  const host = process.env.SMTP_HOST;
  if (host) return host;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error('SMTP_HOST is required when NODE_ENV=production');
  }
  return undefined;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/qtask',
  jwtSecret: requireSecret('JWT_SECRET', process.env.JWT_SECRET, 'dev-jwt-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  trustProxy: process.env.TRUST_PROXY === 'true',
  serveClient: process.env.SERVE_CLIENT !== 'false',
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  smtp: {
    host: requireSmtpHost(),
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? 'noreply@qtask.local',
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.1',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
  },
} as const;
