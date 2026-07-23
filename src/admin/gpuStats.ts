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

export interface OllamaPsModel {
  name?: string;
  size?: number;
  size_vram?: number;
}

const GPU_LOAD_CANDIDATES = [
  '/sys/devices/gpu.0/load',
  '/sys/devices/platform/host1x/gpu.0/load',
];

export function parseJetsonGpuLoad(raw: string | number): number | undefined {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return undefined;
  return value / 10;
}

export function parseMeminfoUsedMiB(content: string): { usedMiB?: number; totalMiB?: number } {
  let totalKb: number | undefined;
  let availableKb: number | undefined;
  for (const line of content.split('\n')) {
    if (line.startsWith('MemTotal:')) {
      totalKb = Number(line.split(/\s+/)[1]);
    } else if (line.startsWith('MemAvailable:')) {
      availableKb = Number(line.split(/\s+/)[1]);
    }
  }
  if (!Number.isFinite(totalKb)) return {};
  const totalMiB = totalKb! >> 10;
  if (!Number.isFinite(availableKb)) return { totalMiB };
  const usedMiB = Math.max(0, (totalKb! - availableKb!) >> 10);
  return { usedMiB, totalMiB };
}

export function parseThermalTempMilliC(raw: string | number): number | undefined {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return undefined;
  return value / 1000;
}

export function pickGpuLoadPath(existingPaths: string[]): string | undefined {
  for (const candidate of GPU_LOAD_CANDIDATES) {
    if (existingPaths.includes(candidate)) return candidate;
  }
  return existingPaths.find((path) => /gpu.*\/load$/i.test(path));
}

export function parseDcgmMetrics(text: string): Omit<GpuResources, 'available'> {
  const metric = (name: string) => {
    const values = [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)$`, 'gm'))]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };
  return {
    source: 'dcgm',
    utilizationPercent: metric('DCGM_FI_DEV_GPU_UTIL'),
    memoryUsedMiB: metric('DCGM_FI_DEV_FB_USED'),
    memoryFreeMiB: metric('DCGM_FI_DEV_FB_FREE'),
    temperatureC: metric('DCGM_FI_DEV_GPU_TEMP'),
    powerWatts: metric('DCGM_FI_DEV_POWER_USAGE'),
  };
}

export function parseOllamaPsModels(models: OllamaPsModel[]): GpuOllamaStats {
  let modelVramBytes = 0;
  let totalSizeBytes = 0;
  let totalVramBytes = 0;

  for (const model of models) {
    const size = model.size ?? 0;
    const vram = model.size_vram ?? 0;
    modelVramBytes += vram;
    if (size > 0) {
      totalSizeBytes += size;
      totalVramBytes += vram;
    }
  }

  const gpuOffloadPercent =
    totalSizeBytes > 0 ? Math.round((totalVramBytes / totalSizeBytes) * 100) : undefined;

  return {
    modelVramMiB: modelVramBytes > 0 ? Math.round(modelVramBytes / (1024 * 1024)) : undefined,
    gpuOffloadPercent,
  };
}

export function gpuStatsFromOllamaPs(models: OllamaPsModel[]): GpuResources {
  const ollama = parseOllamaPsModels(models);
  if (!ollama.modelVramMiB && ollama.gpuOffloadPercent == null) {
    return {
      available: false,
      source: 'ollama_ps',
      reason: 'No GPU-resident models loaded in Ollama',
      ollama,
    };
  }
  return {
    available: true,
    source: 'ollama_ps',
    memoryUsedMiB: ollama.modelVramMiB,
    ollama,
  };
}

export function mergeGpuWithOllama(
  base: GpuResources,
  ollama: GpuOllamaStats | undefined
): GpuResources {
  if (!ollama) return base;
  return { ...base, ollama };
}

export async function fetchGpuStatus(input: {
  jetsonGpuStatsUrl?: string;
  dcgmMetricsUrl?: string;
  ollamaBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GpuResources> {
  const fetchFn = input.fetchImpl ?? fetch;
  const ollamaBase = input.ollamaBaseUrl?.replace(/\/$/, '');

  async function fetchOllamaEnrichment(): Promise<GpuOllamaStats | undefined> {
    if (!ollamaBase) return undefined;
    try {
      const response = await fetchFn(`${ollamaBase}/api/ps`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { models?: OllamaPsModel[] };
      return parseOllamaPsModels(data.models ?? []);
    } catch {
      return undefined;
    }
  }

  if (input.jetsonGpuStatsUrl) {
    try {
      const [response, ollama] = await Promise.all([
        fetchFn(input.jetsonGpuStatsUrl, { signal: AbortSignal.timeout(3_000) }),
        fetchOllamaEnrichment(),
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as GpuResources;
      if (data.available) {
        return mergeGpuWithOllama({ ...data, source: data.source ?? 'jetson_sysfs' }, ollama);
      }
      return mergeGpuWithOllama(
        {
          available: false,
          source: 'jetson_sysfs',
          reason: data.reason ?? 'Jetson GPU stats unavailable',
        },
        ollama
      );
    } catch (error) {
      const ollama = await fetchOllamaEnrichment();
      return mergeGpuWithOllama(
        {
          available: false,
          source: 'jetson_sysfs',
          reason: error instanceof Error ? error.message : String(error),
        },
        ollama
      );
    }
  }

  if (input.dcgmMetricsUrl) {
    try {
      const [response, ollama] = await Promise.all([
        fetchFn(input.dcgmMetricsUrl, { signal: AbortSignal.timeout(3_000) }),
        fetchOllamaEnrichment(),
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      return mergeGpuWithOllama({ available: true, ...parseDcgmMetrics(text) }, ollama);
    } catch (error) {
      const ollama = await fetchOllamaEnrichment();
      return mergeGpuWithOllama(
        {
          available: false,
          source: 'dcgm',
          reason: error instanceof Error ? error.message : String(error),
        },
        ollama
      );
    }
  }

  if (!ollamaBase) {
    return { available: false, reason: 'GPU collector is not configured' };
  }

  try {
    const response = await fetchFn(`${ollamaBase}/api/ps`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { models?: OllamaPsModel[] };
    return gpuStatsFromOllamaPs(data.models ?? []);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
