import { config } from '../config/index.js';

export async function fetchAiStackVersion(): Promise<string | null> {
  const gpuUrl = config.resourceMonitoring.jetsonGpuStatsUrl;
  if (!gpuUrl) return null;

  const versionUrl = gpuUrl.replace(/\/gpu\/?$/, '/version');
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' && body.version.length > 0 ? body.version : null;
  } catch {
    return null;
  }
}
