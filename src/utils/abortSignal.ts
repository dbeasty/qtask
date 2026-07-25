export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw new AbortError();
  }
}

export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();

  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      onAbort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}
