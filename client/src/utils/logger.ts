type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function isDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem('qtask_debug_session') === '1';
  } catch {
    return false;
  }
}

function shouldLog(level: LogLevel): boolean {
  if (level === 'debug') return isDebugEnabled();
  return true;
}

function log(level: LogLevel, module: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const entry = { level, module, message, ...meta, ts: new Date().toISOString() };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else if (level === 'debug') {
    console.debug(line);
  } else {
    console.info(line);
  }
}

export function createLogger(module: string) {
  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', module, message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', module, message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', module, message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', module, message, meta),
  };
}
