/** Tiny promise-based helpers: semaphore, deferred, retry, and chunked piping. */

/** Limits how many async operations run at once (per user or globally). */
export function createSemaphore(limit = 1) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    const { resolve } = queue.shift();
    active += 1;
    resolve();
  };
  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    get limit() {
      return limit;
    },
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => queue.push({ resolve }));
    },
    release() {
      active = Math.max(0, active - 1);
      next();
    },
    /** Runs `fn` with a slot held for its duration. */
    async run(fn) {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries `fn` with exponential backoff. `shouldRetry(err, attempt)` decides.
 */
export async function retry(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000, shouldRetry = () => true, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Averages/rate-limits progress callbacks so we don't spam SSE clients. */
export function throttleProgress(intervalMs = 250) {
  let last = 0;
  let lastValue = null;
  return (value, force = false) => {
    const now = Date.now();
    if (!force && now - last < intervalMs && value?.percent === lastValue?.percent) return null;
    last = now;
    lastValue = value;
    return value;
  };
}

export function clampPercent(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

/** Splits [start,end] into aligned chunks (used for parallel part uploads). */
export function rangeChunks(total, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    chunks.push({ start: offset, end: Math.min(offset + chunkSize, total) - 1 });
  }
  return chunks;
}
