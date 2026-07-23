import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AuthError,
  fetchOllamaGpu,
  fetchOllamaStatus,
  fetchOllamaSummary,
  fetchOllamaTimeseries,
  listOllamaCalls,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Pagination } from '../components/Pagination';
import { StatCard } from '../components/StatCard';
import { TimeSeriesChart } from '../components/TimeSeriesChart';
import {
  formatBytes,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatPercent,
} from '../utils/format';
import type {
  GpuResources,
  OllamaCall,
  OllamaStatusResponse,
  OllamaSummaryGroup,
  OllamaTimeseriesPoint,
} from '../types';

const PAGE_SIZE = 20;
const GPU_POLL_STORAGE_KEY = 'qtask.admin.gpuPollIntervalMs';
const GPU_POLL_OPTIONS = [
  { label: 'Off', ms: 0 },
  { label: '1s', ms: 1_000 },
  { label: '2s', ms: 2_000 },
  { label: '5s', ms: 5_000 },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
] as const;

function readGpuPollIntervalMs(): number {
  try {
    const stored = localStorage.getItem(GPU_POLL_STORAGE_KEY);
    if (stored == null) return 1_000;
    const parsed = Number(stored);
    return GPU_POLL_OPTIONS.some((option) => option.ms === parsed) ? parsed : 1_000;
  } catch {
    return 1_000;
  }
}

function formatGpuHint(gpu: GpuResources | null): string | undefined {
  if (!gpu) return undefined;
  if (!gpu.available) return gpu.reason;

  const parts: string[] = [];
  if (gpu.memoryUsedMiB != null) {
    parts.push(
      gpu.memoryTotalMiB != null
        ? `${formatNumber(gpu.memoryUsedMiB)} / ${formatNumber(gpu.memoryTotalMiB)} MiB RAM`
        : `${formatNumber(gpu.memoryUsedMiB)} MiB used`
    );
  }
  if (gpu.temperatureC != null) {
    parts.push(`${gpu.temperatureC}°C`);
  }
  if (gpu.source === 'ollama_ps') {
    parts.push('Ollama offload only');
  } else if (gpu.source) {
    parts.push(gpu.source);
  }
  if (gpu.ollama?.gpuOffloadPercent != null) {
    parts.push(`${gpu.ollama.gpuOffloadPercent}% model on GPU`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
const WINDOW_OPTIONS = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
];

interface SummaryTotals {
  calls: number;
  successes: number;
  failures: number;
  degradedFallbacks: number;
  promptTokens: number;
  evalTokens: number;
  avgDurationMs: number | null;
}

function summarize(groups: OllamaSummaryGroup[]): SummaryTotals {
  const totals: SummaryTotals = {
    calls: 0,
    successes: 0,
    failures: 0,
    degradedFallbacks: 0,
    promptTokens: 0,
    evalTokens: 0,
    avgDurationMs: null,
  };
  let weightedDuration = 0;
  for (const group of groups) {
    totals.calls += group.calls;
    totals.successes += group.successes;
    totals.failures += group.failures;
    totals.degradedFallbacks += group.degradedFallbacks;
    totals.promptTokens += group.promptTokens;
    totals.evalTokens += group.evalTokens;
    weightedDuration += (group.averageDurationMs ?? 0) * group.calls;
  }
  if (totals.calls > 0) {
    totals.avgDurationMs = weightedDuration / totals.calls;
  }
  return totals;
}

export function OllamaPage() {
  const { handleSessionExpired } = useAuth();
  const [status, setStatus] = useState<OllamaStatusResponse | null>(null);
  const [gpu, setGpu] = useState<GpuResources | null>(null);
  const [gpuPollIntervalMs, setGpuPollIntervalMs] = useState(readGpuPollIntervalMs);
  const [groups, setGroups] = useState<OllamaSummaryGroup[]>([]);
  const [points, setPoints] = useState<OllamaTimeseriesPoint[]>([]);
  const [calls, setCalls] = useState<OllamaCall[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [windowHours, setWindowHours] = useState(24);
  const [loadingCalls, setLoadingCalls] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof AuthError) {
        handleSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
    },
    [handleSessionExpired]
  );

  useEffect(() => {
    setError(null);
    fetchOllamaStatus().then(setStatus).catch(handleError);
  }, [handleError, refreshKey]);

  useEffect(() => {
    let cancelled = false;

    const loadGpu = () => {
      fetchOllamaGpu()
        .then((result) => {
          if (!cancelled) setGpu(result);
        })
        .catch((err) => {
          if (!cancelled) handleError(err);
        });
    };

    loadGpu();

    if (gpuPollIntervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(loadGpu, gpuPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [handleError, refreshKey, gpuPollIntervalMs]);

  const handleGpuPollChange = (ms: number) => {
    setGpuPollIntervalMs(ms);
    try {
      localStorage.setItem(GPU_POLL_STORAGE_KEY, String(ms));
    } catch {
      // ignore storage failures
    }
  };

  useEffect(() => {
    fetchOllamaSummary(windowHours)
      .then((result) => setGroups(result.groups))
      .catch(handleError);
    fetchOllamaTimeseries(windowHours)
      .then((result) => setPoints(result.points))
      .catch(handleError);
  }, [windowHours, handleError, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoadingCalls(true);
    listOllamaCalls({ page, limit: PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setCalls(result.calls);
        setTotal(result.total);
      })
      .catch((err) => {
        if (!cancelled) handleError(err);
      })
      .finally(() => {
        if (!cancelled) setLoadingCalls(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, handleError, refreshKey]);

  const totals = useMemo(() => summarize(groups), [groups]);
  const successRate = totals.calls > 0 ? (totals.successes / totals.calls) * 100 : null;

  const models = status?.tags.models ?? [];
  const runningNames = new Set((status?.running.models ?? []).map((model) => model.name));
  const queue = status?.embeddingQueue ?? {};
  const queuePending = (queue.pending ?? 0) + (queue.processing ?? 0);
  const docker = status?.resources;

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-header">
          <h2>Ollama status</h2>
          <div className="panel-header-actions">
            <label className="gpu-poll-control">
              <span className="muted">GPU refresh</span>
              <select
                value={gpuPollIntervalMs}
                onChange={(event) => handleGpuPollChange(Number(event.target.value))}
              >
                {GPU_POLL_OPTIONS.map((option) => (
                  <option key={option.ms} value={option.ms}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
              Refresh
            </button>
          </div>
        </div>
        {error && <p className="panel-error">{error}</p>}
        <div className="stat-grid">
          <StatCard
            label="Server"
            value={status == null ? '…' : status.available ? 'Online' : 'Unreachable'}
            hint={status?.version.version ? `v${status.version.version}` : undefined}
            tone={status == null ? 'default' : status.available ? 'ok' : 'bad'}
          />
          <StatCard
            label="Models installed"
            value={formatNumber(models.length)}
            hint={status ? `agent: ${status.configuredModels.agent}` : undefined}
          />
          <StatCard
            label="Embedding queue"
            value={formatNumber(queuePending)}
            hint={queue.failed ? `${formatNumber(queue.failed)} failed` : undefined}
            tone={queue.failed ? 'warn' : 'default'}
          />
          <StatCard
            label="CPU"
            value={docker?.available ? formatPercent(docker.cpuPercent) : '—'}
            hint={
              docker?.available
                ? `${formatBytes(docker.memoryBytes)} of ${formatBytes(docker.memoryLimitBytes)} RAM`
                : docker?.reason
            }
          />
          <StatCard
            label="GPU"
            value={
              gpu == null
                ? '…'
                : gpu.available
                  ? gpu.utilizationPercent != null
                    ? formatPercent(gpu.utilizationPercent)
                    : gpu.ollama?.gpuOffloadPercent != null
                      ? `${gpu.ollama.gpuOffloadPercent}% offload`
                      : '—'
                  : '—'
            }
            hint={formatGpuHint(gpu)}
          />
        </div>

        {models.length > 0 && (
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>Model</th>
                <th>Parameters</th>
                <th>Quantization</th>
                <th className="num">Size</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.name}>
                  <td>{model.name}</td>
                  <td>{model.details?.parameter_size ?? '—'}</td>
                  <td>{model.details?.quantization_level ?? '—'}</td>
                  <td className="num">{formatBytes(model.size)}</td>
                  <td>
                    {runningNames.has(model.name) ? (
                      <span className="badge badge--ok">Loaded</span>
                    ) : (
                      <span className="muted">idle</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Usage</h2>
          <div className="window-toggle" role="group" aria-label="Time window">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option.hours}
                type="button"
                className={windowHours === option.hours ? 'nav-active' : ''}
                onClick={() => setWindowHours(option.hours)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="stat-grid">
          <StatCard label="Calls" value={formatNumber(totals.calls)} />
          <StatCard
            label="Success rate"
            value={successRate == null ? '—' : `${successRate.toFixed(1)}%`}
            tone={
              successRate == null
                ? 'default'
                : successRate >= 99
                  ? 'ok'
                  : successRate >= 90
                    ? 'warn'
                    : 'bad'
            }
            hint={totals.calls > 0 ? `${formatNumber(totals.failures)} failed` : undefined}
          />
          <StatCard label="Avg latency" value={formatDurationMs(totals.avgDurationMs)} />
          <StatCard
            label="Tokens"
            value={formatNumber(totals.promptTokens + totals.evalTokens)}
            hint={`${formatNumber(totals.promptTokens)} prompt / ${formatNumber(totals.evalTokens)} eval`}
          />
          <StatCard
            label="Degraded fallbacks"
            value={formatNumber(totals.degradedFallbacks)}
            tone={totals.degradedFallbacks > 0 ? 'warn' : 'default'}
          />
        </div>

        <TimeSeriesChart points={points} />

        {groups.length > 0 && (
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>Type</th>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th className="num">Avg</th>
                <th className="num">p95</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={`${group._id.callType}-${group._id.model}`}>
                  <td>{group._id.callType}</td>
                  <td>{group._id.model}</td>
                  <td className="num">{formatNumber(group.calls)}</td>
                  <td className="num">{formatNumber(group.failures)}</td>
                  <td className="num">{formatDurationMs(group.averageDurationMs)}</td>
                  <td className="num">{formatDurationMs(group.percentiles?.[1])}</td>
                  <td className="num">
                    {formatNumber(group.promptTokens + group.evalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Recent calls</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Source</th>
              <th>Model</th>
              <th>User</th>
              <th className="num">Duration</th>
              <th className="num">Tokens</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {loadingCalls && calls.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted table-status">
                  Loading…
                </td>
              </tr>
            ) : calls.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted table-status">
                  No calls recorded.
                </td>
              </tr>
            ) : (
              calls.map((call) => (
                <tr key={call.requestId}>
                  <td>{formatDateTime(call.startedAt)}</td>
                  <td>{call.callType}</td>
                  <td>{call.source}</td>
                  <td>{call.model}</td>
                  <td>{call.userEmail ?? <span className="muted">—</span>}</td>
                  <td className="num">{formatDurationMs(call.durationMs)}</td>
                  <td className="num">
                    {formatNumber((call.promptEvalCount ?? 0) + (call.evalCount ?? 0))}
                  </td>
                  <td>
                    {call.success ? (
                      <span className="badge badge--ok">OK</span>
                    ) : (
                      <span className="badge badge--bad" title={call.errorMessage ?? undefined}>
                        {call.errorCategory ?? 'error'}
                      </span>
                    )}
                    {call.degradedFallback && (
                      <span className="badge badge--warn" title="Served a degraded fallback">
                        fallback
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          disabled={loadingCalls}
        />
      </section>
    </div>
  );
}
