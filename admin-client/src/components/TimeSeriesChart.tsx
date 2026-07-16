import type { OllamaTimeseriesPoint } from '../types';
import { formatDateTime, formatDurationMs } from '../utils/format';

interface TimeSeriesChartProps {
  points: OllamaTimeseriesPoint[];
}

/**
 * Dependency-free bar chart: one flex column per bucket, height scaled to the
 * busiest bucket, with the failed portion of each bar tinted red.
 */
export function TimeSeriesChart({ points }: TimeSeriesChartProps) {
  if (points.length === 0) {
    return <p className="muted chart-empty">No calls recorded in this window.</p>;
  }

  const maxCalls = Math.max(1, ...points.map((p) => p.calls));
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div className="chart">
      <div className="chart-bars" role="img" aria-label="Ollama calls over time">
        {points.map((point) => {
          const totalPct = (point.calls / maxCalls) * 100;
          const failPct = point.calls > 0 ? (point.failures / point.calls) * 100 : 0;
          const title = [
            formatDateTime(point._id),
            `${point.calls} calls, ${point.failures} failed`,
            `avg ${formatDurationMs(point.durationMs)}`,
            `${point.promptTokens + point.evalTokens} tokens`,
          ].join('\n');
          return (
            <div className="chart-bar-slot" key={point._id} title={title}>
              {point.calls > 0 && (
                <div className="chart-bar" style={{ height: `${Math.max(totalPct, 2)}%` }}>
                  {point.failures > 0 && (
                    <div className="chart-bar-fail" style={{ height: `${failPct}%` }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="chart-axis muted">
        <span>{formatDateTime(first._id)}</span>
        <span className="chart-legend">
          <span className="chart-swatch chart-swatch--ok" /> success
          <span className="chart-swatch chart-swatch--fail" /> failed
          <span>peak {maxCalls} calls</span>
        </span>
        <span>{formatDateTime(last._id)}</span>
      </div>
    </div>
  );
}
