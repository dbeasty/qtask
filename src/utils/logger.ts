type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const configuredLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
const minLevel = LEVELS[configuredLevel] ?? LEVELS.info;

function log(level: LogLevel, module: string, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;
  const entry = { level, module, message, ...meta, ts: new Date().toISOString() };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
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
