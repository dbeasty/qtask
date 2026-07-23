export type AdminAuthMode = 'password' | 'mtls';

export interface AdminFeatures {
  deleteConfirmEmail: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  authMode: AdminAuthMode;
  identity?: string;
  csrfToken?: string;
  features: AdminFeatures;
}

export interface LoginResponse {
  identity: string;
  csrfToken: string;
  features: AdminFeatures;
}

export interface AdminStats {
  users: number;
  tasks: number;
  projects: number;
  conversations: number;
  activities: number;
  totalDataBytes: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
  lastActiveAt?: string | null;
  taskCount: number;
  projectCount: number;
  conversationCount: number;
  storageBytes: number;
}

export interface UsersResponse {
  page: number;
  limit: number;
  total: number;
  users: AdminUser[];
}

export interface OllamaTagModel {
  name: string;
  size?: number;
  modified_at?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaRunningModel {
  name: string;
  size?: number;
  size_vram?: number;
}

export interface DockerResources {
  available: boolean;
  reason?: string;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
}

export interface GpuOllamaStats {
  modelVramMiB?: number;
  gpuOffloadPercent?: number;
}

export interface GpuResources {
  available: boolean;
  source?: 'jetson_sysfs' | 'dcgm' | 'ollama_ps';
  reason?: string;
  utilizationPercent?: number;
  memoryUsedMiB?: number;
  memoryFreeMiB?: number;
  memoryTotalMiB?: number;
  temperatureC?: number;
  powerWatts?: number;
  ollama?: GpuOllamaStats;
}

export interface OllamaStatusResponse {
  available: boolean;
  configuredModels: { agent: string; embedding: string };
  version: { version?: string; error?: string };
  tags: { models?: OllamaTagModel[]; error?: string };
  running: { models?: OllamaRunningModel[]; error?: string };
  embeddingQueue: Record<string, number>;
  resources: DockerResources;
}

export interface OllamaStatus {
  reachable: boolean;
  baseUrl?: string;
  version?: string;
  defaultModel?: string;
  embeddingModel?: string;
  models: Array<{
    name: string;
    sizeBytes?: number;
    parameterSize?: string;
    quantization?: string;
  }>;
  runningModels: OllamaRunningModel[];
  embeddingQueue: Record<string, number>;
  resources: {
    available: boolean;
    reason?: string;
    cpuPercent?: number;
    memoryUsedBytes?: number;
    memoryTotalBytes?: number;
    gpuPercent?: number;
    gpuMemoryUsedMiB?: number;
    gpuMemoryFreeMiB?: number;
    gpuTemperatureC?: number;
  };
}

export interface OllamaSummaryGroup {
  _id: { callType: string; model: string };
  calls: number;
  successes: number;
  failures: number;
  degradedFallbacks: number;
  promptTokens: number;
  evalTokens: number;
  averageDurationMs: number | null;
  /** p50 / p95 / p99 duration in ms. */
  percentiles?: number[];
}

export interface OllamaSummaryResponse {
  from: string;
  to: string;
  groups: OllamaSummaryGroup[];
}

export interface OllamaSummary {
  calls: number;
  successes: number;
  failures: number;
  degradedFallbacks: number;
  promptTokens: number;
  evalTokens: number;
  avgDurationMs?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p99DurationMs?: number;
  groups: OllamaSummaryGroup[];
}

export interface OllamaTimeseriesPoint {
  /** Bucket start time (ISO). */
  _id: string;
  calls: number;
  failures: number;
  durationMs: number | null;
  promptTokens: number;
  evalTokens: number;
}

export interface OllamaTimeseriesResponse {
  from: string;
  to: string;
  interval: string;
  points: OllamaTimeseriesPoint[];
}

export interface OllamaCall {
  requestId: string;
  callType: string;
  source: string;
  model: string;
  userEmail?: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  degradedFallback?: boolean;
  httpStatus?: number;
  errorCategory?: string;
  errorMessage?: string;
  promptEvalCount?: number;
  evalCount?: number;
}

export interface OllamaCallsResponse {
  page: number;
  limit: number;
  total: number;
  calls: OllamaCall[];
}
