// Shared helpers for the Mac app's e2e and perf runs: prepare a private copy of the built
// app (own bundle id, so its web storage is separate from a real install), start it with a
// control folder, and talk to it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SOURCE_APP = process.env.QTASK_E2E_MACOS_APP || path.join(ROOT, 'client-macos/build/QTask.app');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A private copy of the built app. Two copies that run at once need different bundle ids:
 * the web view's storage (the page's session token) is per bundle id and origin.
 */
export function prepareApp(work, bundleId = 'com.qtask.mac.e2e') {
  if (!existsSync(SOURCE_APP)) throw new Error(`no app at ${SOURCE_APP}: run E2E=1 scripts/build-macos.sh first`);
  const app = path.join(work, 'QTask.app');
  mkdirSync(work, { recursive: true });
  execFileSync('cp', ['-R', SOURCE_APP, app]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, path.join(app, 'Contents/Info.plist')]);
  for (const inner of ['node', 'kdb-service']) {
    execFileSync('codesign', ['--force', '--sign', '-', path.join(app, 'Contents/Resources/backend', inner)], { stdio: 'ignore' });
  }
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

/** A running copy of the app. */
export class Instance {
  constructor(app, dataDir, ctlDir) {
    this.app = app;
    this.dataDir = dataDir;
    this.ctlDir = ctlDir;
    this.n = 1;
    this.proc = null;
    this.spawnedAt = 0;
  }

  start({ env = {} } = {}) {
    rmSync(this.ctlDir, { recursive: true, force: true });
    mkdirSync(this.ctlDir, { recursive: true });
    this.n = 1;
    this.spawnedAt = Date.now();
    this.proc = spawn(path.join(this.app, 'Contents/MacOS/QTask'), [], {
      env: { ...process.env, QTASK_DATA_DIR: this.dataDir, QTASK_E2E_CONTROL: this.ctlDir, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.exited = new Promise((r) => this.proc.once('exit', (code, sig) => r({ code, sig })));
    return this;
  }

  async command(kind, payload, timeoutMs = 180000) {
    const n = this.n++;
    // Written under another name and renamed, so the app never reads a half-written command.
    const target = path.join(this.ctlDir, `cmd-${n}.${kind}`);
    writeFileSync(`${target}.tmp`, payload);
    renameSync(`${target}.tmp`, target);
    const res = path.join(this.ctlDir, `res-${n}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(res)) {
        const r = JSON.parse(readFileSync(res, 'utf8'));
        if (!r.ok) throw new Error(`${kind} command failed: ${r.error}\n${payload.slice(0, 300)}`);
        return r.value;
      }
      await sleep(15);
    }
    throw new Error(`no answer to ${kind} command: ${payload.slice(0, 200)}`);
  }

  js(source) {
    return this.command('js', source);
  }
  native(line) {
    return this.command('native', line);
  }
  state() {
    return this.native('state');
  }

  /** Waits for the client's shell to be on screen (header rendered, past "Loading"). */
  async waitForUi(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ok = await this.js(`return !!document.querySelector('.app-shell .app-header')`);
        if (ok) return Date.now();
      } catch {
        /* the page is still loading */
      }
      if (Date.now() > deadline) throw new Error('the UI never appeared');
      await sleep(20);
    }
  }

  /** Quits through the menu path and waits for the process, then returns its exit. */
  async quit() {
    await this.native('quit').catch(() => {});
    const r = await Promise.race([this.exited, sleep(90000).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error('the app did not quit within 90 s');
    return r;
  }

  kill9() {
    this.proc.kill('SIGKILL');
    return this.exited;
  }
}

export function makeWork(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Pids of any helper processes still running from this app copy. */
export function helperPids(app) {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes(path.join(app, 'Contents/Resources/backend')))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
}

/** Resident memory (KB) per pid, from ps. */
export function rssKb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

/** Direct HTTP to the backend using the state the control folder reports (test-only). */
export function backendClient(state) {
  const base = `http://127.0.0.1:${state.port}`;
  const dev = { 'x-qtask-device-token': state.deviceToken, 'content-type': 'application/json' };
  let auth = null;
  async function session() {
    if (!auth) {
      const r = await fetch(`${base}/api/auth/local-session`, { method: 'POST', headers: dev });
      auth = (await r.json()).token;
    }
    return auth;
  }
  return {
    base,
    async call(method, p, body) {
      const t = await session();
      const t0 = performance.now();
      const r = await fetch(base + p, {
        method,
        headers: { ...dev, authorization: `Bearer ${t}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      const ms = performance.now() - t0;
      return { status: r.status, body: text ? JSON.parse(text) : null, ms };
    },
  };
}
