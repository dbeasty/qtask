import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value) return value;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
  return devFallback;
}

export type MailProvider = 'resend' | 'smtp' | 'none';

const DEFAULT_FROM = 'noreply@qtask.dev';

/** Resolve mail provider from env. Prefer MAIL_RESEND when both flags are set. */
export function resolveMailProvider(env: NodeJS.ProcessEnv = process.env): MailProvider {
  const mailResend = env.MAIL_RESEND === 'true';
  const mailSmtp = env.MAIL_SMTP === 'true';
  if (mailResend) return 'resend';
  if (mailSmtp) return 'smtp';
  // Backward compat: SMTP_HOST alone still enables SMTP
  if (env.SMTP_HOST) return 'smtp';
  return 'none';
}

export function resolveMailFrom(
  provider: MailProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (provider === 'resend') {
    return env.RESEND_FROM || env.SMTP_FROM || DEFAULT_FROM;
  }
  return env.SMTP_FROM || DEFAULT_FROM;
}

const mailProvider = resolveMailProvider();

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
  /** Snapshot at process start; request-time gating also checks REGISTRATION_ENABLED (see isRegistrationEnabled). */
  registrationEnabled: process.env.REGISTRATION_ENABLED !== 'false',
  mail: {
    provider: mailProvider,
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    from: resolveMailFrom(mailProvider),
  },
  smtp: {
    host: process.env.SMTP_HOST || undefined,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? DEFAULT_FROM,
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.1',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
  },
} as const;
