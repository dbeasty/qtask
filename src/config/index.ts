import dotenv from 'dotenv';
import { SITE_URL } from '../constants/brand.js';
import { loadSecrets, resolveSecretsBackend } from './secrets.js';

export {
  loadSecrets,
  resolveSecretsBackend,
  SECRET_ENV_KEYS,
  type SecretsBackend,
} from './secrets.js';

// Test processes set NODE_ENV before importing config and must not inherit
// developer/production secrets from local dotenv files.
if (process.env.NODE_ENV !== 'test' && process.env.QTASK_SKIP_DOTENV !== 'true') {
  dotenv.config();
  dotenv.config({ path: '.env.local', override: true });
}

// Optional Vault merge into process.env (no-op when SECRETS_BACKEND=env, the default).
await loadSecrets();

function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value) return value;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'test') {
    return devFallback;
  }
  throw new Error(`${name} is required when NODE_ENV=${nodeEnv}`);
}

export type MailProvider = 'resend' | 'smtp' | 'none';
export type AdminAuthMode = 'password' | 'mtls';

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
const adminAuthMode: AdminAuthMode = process.env.ADMIN_AUTH_MODE === 'mtls' ? 'mtls' : 'password';
const secretsBackend = resolveSecretsBackend();

/** Ollama keep_alive: -1 (forever), 0 (unload), duration string, or integer seconds. */
function parseOllamaKeepAlive(value: string | undefined, fallback: string): string | number {
  const raw = value ?? fallback;
  if (raw === '-1') return -1;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

export const config = {
  secretsBackend,
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/qtask',
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
    /** Feedback screenshot validation — defaults to OLLAMA_BASE_URL when unset. */
    visionBaseUrl:
      process.env.OLLAMA_VISION_BASE_URL ??
      process.env.OLLAMA_BASE_URL ??
      'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'qwen3.5:2b',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text',
    visionModel: process.env.OLLAMA_VISION_MODEL ?? 'moondream',
    keepAlive: parseOllamaKeepAlive(process.env.OLLAMA_KEEP_ALIVE, '-1'),
    embeddingKeepAlive: parseOllamaKeepAlive(process.env.OLLAMA_EMBEDDING_KEEP_ALIVE, '-1'),
    embeddingNumGpu: parseInt(process.env.OLLAMA_EMBEDDING_NUM_GPU ?? '0', 10),
  },
  storage: {
    backend: process.env.STORAGE_BACKEND === 's3' ? ('s3' as const) : ('local' as const),
    localPath: process.env.STORAGE_LOCAL_PATH ?? './data/uploads',
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  },
  feedback: {
    maxAttachmentBytes: Math.max(
      1,
      parseInt(process.env.FEEDBACK_MAX_ATTACHMENT_BYTES ?? '5242880', 10)
    ),
    maxAttachments: Math.max(1, parseInt(process.env.FEEDBACK_MAX_ATTACHMENTS ?? '3', 10)),
    visionMinConfidence: Math.min(
      1,
      Math.max(0, parseFloat(process.env.FEEDBACK_VISION_MIN_CONFIDENCE ?? '0.7'))
    ),
  },
  features: {
    /** When false, agent find_tasks skips Ollama embeddings (text/regex search only). */
    agentHybridSearch: process.env.AGENT_HYBRID_SEARCH !== 'false',
    /** When false, feedback UI and POST /api/feedback are disabled. */
    feedbackEnabled: process.env.FEEDBACK_ENABLED !== 'false',
    /** When false, feedback is text-only (no screenshot uploads or vision validation). */
    feedbackImagesEnabled: process.env.FEEDBACK_IMAGES_ENABLED !== 'false',
  },
  admin: {
    host: process.env.ADMIN_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ADMIN_PORT ?? '3004', 10),
    authMode: adminAuthMode,
    hashAdminPassword: process.env.HASH_ADMIN_PASSWORD === 'true',
    password: process.env.ADMIN_PASSWORD,
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
    jwtSecret:
      process.env.ADMIN_JWT_SECRET ??
      ((process.env.NODE_ENV ?? 'development') === 'production'
        ? ''
        : 'dev-admin-jwt-secret-change-me'),
    proxySecret: process.env.ADMIN_PROXY_SECRET,
    cookieSecure:
      process.env.ADMIN_COOKIE_SECURE === 'true' ||
      (process.env.ADMIN_COOKIE_SECURE !== 'false' && (process.env.NODE_ENV ?? 'development') === 'production'),
    clientDist: process.env.ADMIN_CLIENT_DIST,
    /** When true, admin delete-user requires typing the account email to confirm. */
    deleteConfirmEmail: process.env.ADMIN_DELETE_CONFIRM_EMAIL === 'true',
  },
  llmMetrics: {
    retentionDays: Math.max(1, parseInt(process.env.LLM_METRICS_RETENTION_DAYS ?? '30', 10)),
  },
  resourceMonitoring: {
    dockerApiUrl: process.env.OLLAMA_DOCKER_STATS_URL,
    dockerContainer: process.env.OLLAMA_DOCKER_CONTAINER ?? 'qtask-ollama-1',
    dcgmMetricsUrl: process.env.DCGM_METRICS_URL,
    jetsonGpuStatsUrl: process.env.JETSON_GPU_STATS_URL,
  },
  mongoEncryptAtRest: process.env.MONGO_ENCRYPT_AT_REST === 'true',
  mongoEncryptMount: process.env.MONGO_ENCRYPT_MOUNT ?? '/var/lib/qtask/mongo-data',
  deployment: {
    readOnlyMode: process.env.READ_ONLY_MODE === 'true',
    message:
      process.env.DEPLOYMENT_MESSAGE ??
      'Edits are temporarily disabled while we deploy a major update.',
    phase: parseDeploymentPhase(process.env.DEPLOYMENT_PHASE),
  },
  /** When false, embedding worker does not start (used on read-only live stack during major deploy). */
  embeddingWorkerEnabled: process.env.EMBEDDING_WORKER_ENABLED !== 'false',
  /** When false, feedback vision worker does not start (requires feedbackImagesEnabled). */
  feedbackVisionWorkerEnabled:
    process.env.FEEDBACK_VISION_WORKER_ENABLED !== 'false' &&
    process.env.FEEDBACK_IMAGES_ENABLED !== 'false',
  mcpOAuth: {
    enabled: process.env.MCP_OAUTH_ENABLED !== 'false',
    jwtSecret: requireSecret(
      'MCP_OAUTH_JWT_SECRET',
      process.env.MCP_OAUTH_JWT_SECRET,
      'dev-mcp-oauth-jwt-secret-change-me'
    ),
    accessTokenTtlSec: Math.max(
      60,
      parseInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SEC ?? '3600', 10)
    ),
  },
} as const;

export function getHealthFeaturesPayload(): {
  feedback: boolean;
  feedbackImages: boolean;
} {
  return {
    feedback: process.env.FEEDBACK_ENABLED !== 'false',
    feedbackImages: process.env.FEEDBACK_IMAGES_ENABLED !== 'false',
  };
}

export function getMcpPublicConfig(): {
  url: string;
  cloudUrl: string;
  authHeader: 'Authorization';
  authScheme: 'Bearer';
  isLocalhost: boolean;
} {
  const url =
    config.nodeEnv === 'production'
      ? `${new URL(config.appUrl).origin}/api/mcp`
      : `http://localhost:${config.port}/api/mcp`;
  const cloudUrl =
    config.nodeEnv === 'production' ? url : `${SITE_URL}/api/mcp`;
  return {
    url,
    cloudUrl,
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    isLocalhost: config.nodeEnv !== 'production',
  };
}

export type DeploymentPhase = 'normal' | 'major-deploy' | 'candidate';

function parseDeploymentPhase(value: string | undefined): DeploymentPhase {
  if (value === 'major-deploy' || value === 'candidate') return value;
  return 'normal';
}
