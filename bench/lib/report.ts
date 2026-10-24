/**
 * Turns results.json into report.md (tables) and report.html (the same tables plus SVG charts of
 * throughput and tail latency against concurrency).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const f = (n: number | undefined, d = 1) => (n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d));
const mib = (b: number | undefined) => (b === undefined ? '-' : (b / 2 ** 20).toFixed(0));
const BACKEND_LABEL: Record<string, string> = {
  mongo: 'MongoDB 7 (w:1, default journal commit)',
  'mongo-j': 'MongoDB 7 (w:1, j:true)',
  kdb: 'KDB 0.9.3 (--durability sync: acknowledged writes are fsynced, group commit)',
  'kdb-async': 'KDB 0.9.3 (--durability async: acknowledged once queued, synced every 5 ms)',
};

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderMarkdown(results: Any): string {
  let r = results;
  const out: string[] = [];
  const o = r.meta.options;
  const smoke = o.scale === 'smoke' || o.duration < 60;
  out.push(`# qtask data layer: MongoDB vs KDB (${o.scale}${Object.keys(o.overrides ?? {}).length ? ` ${JSON.stringify(o.overrides)}` : ''})`);
  out.push('');
  if (smoke) {
    out.push('> **Smoke run.** Short cells and/or a small dataset: this validates the harness, it does not measure the databases. Do not quote these numbers.');
    out.push('');
  }
  out.push(`Started ${r.meta.started}, finished ${r.meta.finished}. Each database ran alone in a container limited to **${o.cpus} CPUs and ${o.memory} RAM (no swap)**; the load generator runs as Node processes on the host (${r.meta.host.cpuModel ?? ''}, ${r.meta.host.cpus} CPUs, Node ${r.meta.host.node}) driving qtask's own data layer (\`connectData()\`), the same store code the app runs. Docker: ${r.meta.engine.os}, ${r.meta.engine.arch}, ${r.meta.engine.ncpu} CPUs, ${(r.meta.engine.memBytes / 2 ** 30).toFixed(1)} GiB.`);
  out.push('');
  out.push(`- Cells: ${o.warmup}s warmup + ${o.duration}s measured; concurrency ${o.concurrency.join(', ')}; data restored to the pristine copy before every ${o.reset}.`);
  out.push(`- MongoDB image: \`${r.meta.images.mongo}\` ${r.meta.images.mongoDigest ? `(${r.meta.images.mongoDigest})` : ''}; URIs: ${Object.entries(r.meta.mongoUri).map(([k, v]) => `${k} \`${v}\``).join(', ')}`);
  out.push(`- KDB image: \`${r.meta.images.kdb}\` - ${r.meta.images.kdbSource}; flags \`${r.meta.kdbArgs.map((a: string) => (a === '' ? '""' : a)).join(' ')}\`; app env ${Object.entries(r.meta.kdbEnv).map(([k, v]) => `\`${k}=${v}\``).join(' ')}`);
  out.push(`- Client processes per cell: up to ${o.clients} (sessions split evenly). "client CPU" is summed over them (100 = one core); "max proc" is the busiest one - near 100 means that cell measured the client, not the database.`);
  if (r.meta.fsync) out.push(`- Volume fsync probe (4 KiB dd oflag=dsync): ${r.meta.fsync.msPerSync !== undefined ? `**${f(r.meta.fsync.msPerSync, 2)} ms per synchronous write**` : `failed: ${r.meta.fsync.error}`}. Every durable commit (KDB sync, MongoDB j:true) waits for at least one.`);
  out.push(`- Background embedding worker in the workload profiles: one lane, Ollama replaced by a ${o.ollamaDelay} ms delay.`);
  out.push('');

  // dataset
  const d = r.dataset;
  out.push('## Dataset');
  out.push('');
  out.push(table(['collection', 'documents'], Object.entries(d.counts).map(([k, v]) => [k, String(v)])));
  out.push('');
  out.push(`Total ${Object.values(d.counts as Record<string, number>).reduce((a, b) => a + b, 0)} documents. On disk after load: MongoDB ${mib(d.bytes.mongo)} MiB (at small scales mostly WiredTiger's preallocated journal files), KDB ${mib(d.bytes.kdb)} MiB. MongoDB load ${f(d.mongoLoad?.seconds)} s (${f(d.mongoLoad?.docsPerSec, 0)} docs/s); KDB backfill (migrate:kdb, --durability async during load) ${f(d.kdbBackfillSeconds)} s.`);
  if (d.verify) out.push(`\`migrate:kdb verify\`: **${d.verify.ok ? 'clean' : 'DIFFERENCES'}**.`);
  if (d.crosscheck) {
    out.push('');
    out.push(`Cross-check (same query on both stores, results compared document by document; \`updatedAt\` ignored as in shadow reads): **${d.crosscheck.checks - d.crosscheck.failed}/${d.crosscheck.checks} agree**.`);
    out.push('');
    out.push(table(['query', 'checks', 'rows (Mongo)', 'disagree', 'example'], Object.entries(d.crosscheck.byQuery).map(([q, v]: [string, Any]) => [q, String(v.checks), String(v.rows), String(v.failed), v.example ?? ''])));
  }
  out.push('');

  const failed = r.cells.filter((c: Any) => c.failed);
  if (failed.length) {
    out.push('## Failed cells');
    out.push('');
    for (const c of failed) out.push(`- **${c.backend} / ${c.profile} / ${c.concurrency}**: \`${String(c.failed).split('\n')[0]!.slice(0, 300)}\``);
    out.push('');
  }
  r = { ...r, cells: r.cells.filter((c: Any) => !c.failed) };

  // limits
  const limits = new Map<string, Any>();
  for (const c of r.cells) limits.set(c.backend, c.limits);
  out.push('## Limits as applied (docker inspect)');
  out.push('');
  out.push(table(['backend', 'CPUs', 'memory', 'memory+swap', 'OOM killed'], [...limits.entries()].map(([b, l]) => [b, f(l.cpus, 2), `${mib(l.memoryBytes)} MiB`, `${mib(l.memorySwapBytes)} MiB`, String(l.oomKilled)])));
  out.push('');

  // per profile
  const profiles = [...new Set(r.cells.map((c: Any) => c.profile))] as string[];
  for (const profile of profiles) {
    const cells = r.cells.filter((c: Any) => c.profile === profile);
    out.push(`## Profile: ${profile}`);
    out.push('');
    if (profile === 'claim') {
      out.push('N workers claim from one queue (feedbackVisionJobs, the claim in feedbackVisionQueue.ts:68-72), complete the job and re-enqueue it. A "cycle" is claim + complete + re-enqueue. An empty claim is one that found nothing although jobs were pending; a double claim is two workers holding the same job.');
      out.push('');
      out.push(table(
        ['backend', 'workers', 'claims/s', 'cycle p50 ms', 'p95', 'p99', 'max', 'claim op p99 ms', 'empty claims %', 'double claims', 'stuck processing', 'errors', 'db CPU % avg/max', 'db mem MiB max', 'client CPU % (max proc)'],
        cells.map((c: Any) => {
          const op = c.ops['feedbackVisionJobs.findOneAndUpdate'];
          return [c.backend, String(c.concurrency), f(c.actionsPerSec), f(c.allActions.p50Ms, 2), f(c.allActions.p95Ms, 2), f(c.allActions.p99Ms, 2), f(c.allActions.maxMs, 1), f(op?.p99Ms, 2), f(c.emptyClaimPct, 1), String(c.doubleClaims), String(c.stuckProcessing), `${c.errorCount}${c.unfinished ? ` (+${c.unfinished} unfinished)` : ''}`, `${f(c.container.cpuPctAvg, 0)}/${f(c.container.cpuPctMax, 0)}`, mib(c.container.memBytesMax), `${f(c.clientCpuPct, 0)} (${f(c.clientCpuPctMaxProcess, 0)})`];
        })
      ));
      out.push('');
      continue;
    }
    out.push('Throughput counts user actions (one API request each, several data-layer calls); latency is per action, end to end through the store.');
    out.push('');
    out.push(table(
      ['backend', 'users', 'actions/s', 'data ops/s', 'reads:writes', 'p50 ms', 'p95', 'p99', 'max', 'errors', 'db CPU % avg/max', 'db mem MiB max', 'client CPU % (max proc)'],
      cells.map((c: Any) => [c.backend, String(c.concurrency), f(c.actionsPerSec), f(c.opsPerSec, 0), `${Math.round((100 * c.reads) / Math.max(1, c.reads + c.writes))}:${Math.round((100 * c.writes) / Math.max(1, c.reads + c.writes))}`, f(c.allActions.p50Ms, 2), f(c.allActions.p95Ms, 2), f(c.allActions.p99Ms, 2), f(c.allActions.maxMs, 1), `${c.errorCount}${c.unfinished ? ` (+${c.unfinished} unfinished)` : ''}`, `${f(c.container.cpuPctAvg, 0)}/${f(c.container.cpuPctMax, 0)}`, mib(c.container.memBytesMax), `${f(c.clientCpuPct, 0)} (${f(c.clientCpuPctMaxProcess, 0)})`])
    ));
    out.push('');
    // per action at the highest concurrency
    const top = Math.max(...cells.map((c: Any) => c.concurrency));
    const atTop = cells.filter((c: Any) => c.concurrency === top);
    const actionNames = [...new Set(atTop.flatMap((c: Any) => Object.keys(c.actions)))].sort() as string[];
    out.push(`### Per action at ${top} concurrent users (p50 / p99 ms, count)`);
    out.push('');
    out.push(table(['action', ...atTop.map((c: Any) => c.backend)], actionNames.map((a) => [a, ...atTop.map((c: Any) => (c.actions[a] ? `${f(c.actions[a].p50Ms, 2)} / ${f(c.actions[a].p99Ms, 2)} (${c.actions[a].count})` : '-'))])));
    out.push('');
    out.push(`### Slowest data-layer calls at ${top} concurrent users (by p99, top 15 per backend)`);
    out.push('');
    for (const c of atTop) {
      const ops = Object.entries(c.ops as Record<string, Any>).sort((a, b) => b[1].p99Ms - a[1].p99Ms).slice(0, 15);
      out.push(`**${c.backend}**`);
      out.push('');
      out.push(table(['call', 'count', 'p50 ms', 'p95', 'p99', 'max'], ops.map(([k, v]) => [k, String(v.count), f(v.p50Ms, 2), f(v.p95Ms, 2), f(v.p99Ms, 2), f(v.maxMs, 1)])));
      out.push('');
    }
    const errs = cells.filter((c: Any) => c.errorCount > 0);
    if (errs.length) {
      out.push('### Errors');
      out.push('');
      for (const c of errs) for (const [k, v] of Object.entries(c.errors as Record<string, Any>)) out.push(`- ${c.backend} @${c.concurrency}: ${k} x${v.count} - \`${v.sample}\``);
      out.push('');
    }
  }

  // cold
  if (Object.keys(r.cold ?? {}).length) {
    out.push('## Cold start (container start with the dataset on disk, to first answered task list)');
    out.push('');
    out.push(table(
      ['backend', 'run', 'page cache dropped', 'client process ready ms', 'connect ms (attempts)', 'first read ms', 'first task list ms', 'container start -> first list ms'],
      Object.entries(r.cold).flatMap(([b, runs]: [string, Any]) => runs.filter((x: Any) => !x.failed).map((x: Any, i: number) => [b, String(i + 1), String(x.cachesDropped), f(x.clientProcessStartupMs, 0), `${f(x.connectMs, 0)} (${x.connectAttempts})`, f(x.firstReadMs, 1), f(x.firstListMs, 1), f(x.startToFirstListMs, 0)]))
    ));
    out.push('');
    out.push('Timed from `docker start`. The client process starts in parallel with the database and retries until it answers, so "connect" includes waiting for the database to open its data; KDB connect also declares its constraints and indexes (idempotent), as the app does on every start.');
    out.push('');
  }
  if (Object.keys(r.bytesAfterRun ?? {}).length) {
    out.push('## On-disk size after each profile (MiB)');
    out.push('');
    out.push(table(['backend/profile', 'MiB'], Object.entries(r.bytesAfterRun).map(([k, v]) => [k, mib(v as number)])));
    out.push('');
  }
  out.push('## Backends');
  out.push('');
  for (const b of [...new Set(r.cells.map((c: Any) => c.backend))] as string[]) out.push(`- **${b}**: ${BACKEND_LABEL[b] ?? b}`);
  out.push('');
  return out.join('\n');
}

// --- charts -----------------------------------------------------------------------------------

const COLORS: Record<string, string> = { mongo: '#2a7ab0', 'mongo-j': '#7fb2d9', kdb: '#d1622b', 'kdb-async': '#e9a77f' };

function lineChart(title: string, series: Array<{ name: string; points: Array<[number, number]> }>, yLabel: string, logY = false): string {
  const W = 520;
  const H = 260;
  const P = { l: 56, r: 12, t: 28, b: 36 };
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const ys = series.flatMap((s) => s.points.map((p) => p[1])).filter((y) => y > 0);
  if (!xs.length || !ys.length) return '';
  const yMax = Math.max(...ys) * 1.1;
  const yMin = logY ? Math.max(0.01, Math.min(...ys) / 1.5) : 0;
  const tx = (x: number) => P.l + (xs.length === 1 ? 0.5 : xs.indexOf(x) / (xs.length - 1)) * (W - P.l - P.r);
  const ty = (y: number) => {
    const v = logY ? (Math.log10(Math.max(y, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin)) : y / yMax;
    return H - P.b - v * (H - P.t - P.b);
  };
  const ticks = logY
    ? Array.from({ length: Math.ceil(Math.log10(yMax)) - Math.floor(Math.log10(yMin)) + 1 }, (_, i) => 10 ** (Math.floor(Math.log10(yMin)) + i)).filter((v) => v >= yMin && v <= yMax)
    : Array.from({ length: 5 }, (_, i) => (yMax * i) / 4);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><text x="${P.l}" y="16" class="t">${title}</text>`];
  for (const t of ticks) parts.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${ty(t)}" y2="${ty(t)}" class="g"/><text x="${P.l - 6}" y="${ty(t) + 4}" class="a" text-anchor="end">${t >= 100 ? t.toFixed(0) : t.toPrecision(2)}</text>`);
  for (const x of xs) parts.push(`<text x="${tx(x)}" y="${H - P.b + 16}" class="a" text-anchor="middle">${x}</text>`);
  parts.push(`<text x="${(W + P.l) / 2}" y="${H - 4}" class="a" text-anchor="middle">concurrent users</text><text x="12" y="${(H) / 2}" class="a" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">${yLabel}</text>`);
  series.forEach((s, i) => {
    const color = COLORS[s.name] ?? '#666';
    const pts = s.points.map(([x, y]) => `${tx(x)},${ty(y)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`);
    for (const [x, y] of s.points) parts.push(`<circle cx="${tx(x)}" cy="${ty(y)}" r="3" fill="${color}"><title>${s.name} @${x}: ${y.toFixed(2)}</title></circle>`);
    parts.push(`<rect x="${W - P.r - 90}" y="${P.t + i * 16}" width="10" height="10" fill="${color}"/><text x="${W - P.r - 76}" y="${P.t + 9 + i * 16}" class="a">${s.name}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function charts(results: Any): string {
  const r = { ...results, cells: results.cells.filter((c: Any) => !c.failed) };
  const out: string[] = [];
  const profiles = [...new Set(r.cells.map((c: Any) => c.profile))] as string[];
  for (const profile of profiles) {
    const cells = r.cells.filter((c: Any) => c.profile === profile);
    const backends = [...new Set(cells.map((c: Any) => c.backend))] as string[];
    const series = (metric: (c: Any) => number) => backends.map((b) => ({ name: b, points: cells.filter((c: Any) => c.backend === b).map((c: Any) => [c.concurrency, metric(c)] as [number, number]) }));
    out.push(`<h3>${profile}</h3><div class="charts">`);
    out.push(lineChart(`${profile}: throughput`, series((c) => c.actionsPerSec), profile === 'claim' ? 'claims/s' : 'actions/s'));
    out.push(lineChart(`${profile}: p99 latency (log)`, series((c) => c.allActions.p99Ms), 'ms', true));
    out.push('</div>');
  }
  return out.join('\n');
}

function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = md.split('\n');
  const html: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('| ') && lines[i + 1]?.startsWith('| ---')) {
      const cells = (l: string) => l.slice(2, -2).split(' | ');
      html.push('<div class="tw"><table><thead><tr>' + cells(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i]!.startsWith('| ')) html.push('<tr>' + cells(lines[i++]!).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      i--;
      html.push('</tbody></table></div>');
    } else if (line.startsWith('### ')) html.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) html.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) html.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith('> ')) html.push(`<p class="warn">${inline(line.slice(2))}</p>`);
    else if (line.startsWith('- ')) html.push(`<li>${inline(line.slice(2))}</li>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  return html.join('\n');
}

export function writeReport(dir: string, results: Any): void {
  const md = renderMarkdown(results);
  writeFileSync(join(dir, 'report.md'), md);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>qtask DB benchmark</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e3e6;--warn:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa2;--line:#2c2c31;--warn:#3a2a12}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:16px}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12.5px}td,th{border-bottom:1px solid var(--line);padding:3px 8px;text-align:left;white-space:nowrap}
.tw{overflow-x:auto;margin:8px 0 16px}.warn{background:var(--warn);padding:8px 12px;border-radius:6px}
.charts{display:flex;flex-wrap:wrap;gap:16px}.charts svg{width:100%;max-width:520px;height:auto}
svg .t{font-weight:600;font-size:13px;fill:var(--fg)}svg .a{font-size:11px;fill:var(--mut)}svg .g{stroke:var(--line)}
code{font-size:12px}
</style></head><body>
${markdownToHtml(md)}
<h2>Charts</h2>
${charts(results)}
</body></html>`;
  writeFileSync(join(dir, 'report.html'), html);
}
