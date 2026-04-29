/**
 * In-flight request coalescer — eliminates the thundering herd problem.
 *
 * When N concurrent requests arrive for the same cache key and all miss the
 * processed-image LRU cache, without coalescing each of them independently
 * downloads from GCS and runs the full Sharp + TF.js pipeline. The last write
 * wins and all intermediate work is wasted.
 *
 * This module maintains a Map of in-progress promises keyed by the normalized
 * cache key. The first request starts the work and registers its promise.
 * Every subsequent request for the same key awaits the same promise. When the
 * work completes the key is removed so future requests go through normally.
 *
 * Usage:
 *   const result = await coalescer.getOrRun(cacheKey, () => doExpensiveWork());
 */

export interface CoalescerResult<T> {
  value: T;
  /** true if this caller did the work; false if it rode along on an in-flight promise */
  leader: boolean;
}

export class RequestCoalescer<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * If a promise is already running for `key`, await it and return its result.
   * Otherwise run `fn`, register the promise, and return its result.
   */
  async getOrRun(key: string, fn: () => Promise<T>): Promise<CoalescerResult<T>> {
    const existing = this.inFlight.get(key);
    if (existing) {
      const value = await existing;
      return { value, leader: false };
    }

    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);

    const value = await promise;
    return { value, leader: true };
  }

  /** Number of currently in-flight requests. */
  get size(): number {
    return this.inFlight.size;
  }
}

/** Singleton — shared across all requests within one container. */
export const requestCoalescer = new RequestCoalescer<{
  buffer: Buffer;
  contentType: string;
}>();
