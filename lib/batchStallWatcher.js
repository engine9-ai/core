/**
 * Fail when an async batch operation exceeds a time window without completing.
 * Used by PersonWorker loadPeople / processPeople pipelines.
 */
export function batchStallKey(context) {
  return `${context.path}#${context.batchIndex ?? '?'}`;
}

export function createBatchStallWatcher({ timeoutMs, onStall }) {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      start() {},
      clear() {},
      clearAll() {},
      activeKeys() {
        return [];
      }
    };
  }

  /** @type {Map<string, { timer: ReturnType<typeof setTimeout>, rejectStall: (err: Error) => void }>} */
  const active = new Map();

  function clear(context) {
    if (!context?.path) {
      clearAll();
      return;
    }
    const key = batchStallKey(context);
    const entry = active.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    active.delete(key);
  }

  function clearAll() {
    for (const entry of active.values()) {
      clearTimeout(entry.timer);
    }
    active.clear();
  }

  function start(context) {
    const key = batchStallKey(context);
    clear(context);
    const startedAt = Date.now();
    let rejectStall;
    const stallPromise = new Promise((_, reject) => {
      rejectStall = reject;
    });

    const timer = setTimeout(() => {
      let err;
      try {
        onStall({
          ...context,
          elapsedMs: Date.now() - startedAt
        });
        err = new Error(`Batch stalled after ${Date.now() - startedAt}ms`);
      } catch (e) {
        err = e;
      }
      rejectStall(err);
      active.delete(key);
    }, timeoutMs);

    active.set(key, { timer, rejectStall });
    return stallPromise;
  }

  function activeKeys() {
    return [...active.keys()];
  }

  return { start, clear, clearAll, activeKeys };
}

export function resolveBatchStallTimeoutMs(opts = {}) {
  const fromOpts = opts.batch_stall_timeout_ms ?? opts.batchStallTimeoutMs;
  if (fromOpts !== undefined && fromOpts !== null && fromOpts !== '') {
    return parseInt(fromOpts, 10);
  }
  const fromEnv = process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS;
  if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') {
    return parseInt(fromEnv, 10);
  }
  return 60000;
}
