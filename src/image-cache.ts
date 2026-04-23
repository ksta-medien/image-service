/**
 * In-memory LRU cache for processed images.
 *
 * Motivation: Cloud Run serves as Akamai origin. When Akamai routes a request
 * to an edge that has no cached copy, it hits the origin. Without a container
 * cache every such request triggers a full GCS download + Sharp processing
 * round-trip, which can exceed containerConcurrency limits and cause 503s.
 *
 * The cache stores the already-processed image buffer so identical requests
 * (same path + same transformation params) are served directly from RAM.
 *
 * LRU eviction: the Map insertion-order iteration is used as a cheap FIFO/LRU
 * approximation — on a get() the entry is re-inserted at the tail, so the head
 * always holds the least recently used entry.
 *
 * Size limit is configurable via IMAGE_CACHE_MAX_MB env var (default 512 MB).
 * Single items larger than 10 % of the total limit are skipped to avoid
 * a single large image evicting everything else.
 */

export interface CacheEntry {
  buffer: Buffer;
  contentType: string;
  /** Byte size of buffer — stored once to avoid repeated .length calls */
  size: number;
}

export interface CacheStats {
  entries: number;
  sizeMB: number;
  maxMB: number;
  hits: number;
  misses: number;
  hitRate: string;
}

export class ImageCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxBytes: number;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(maxMB: number) {
    this.maxBytes = maxMB * 1024 * 1024;
    console.log(`[ImageCache] Initialized with max size ${maxMB} MB`);
  }

  /** Returns the cached entry and promotes it to MRU position, or undefined on miss. */
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    // Re-insert to make it the most-recently-used entry
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry;
  }

  /**
   * Stores a processed image in the cache.
   * Items larger than 10 % of the total cache limit are silently skipped.
   */
  set(key: string, buffer: Buffer, contentType: string): void {
    const size = buffer.length;

    // Skip oversized single items
    if (size > this.maxBytes * 0.1) {
      console.log(`[ImageCache] Skipping entry (${(size / 1024 / 1024).toFixed(1)} MB > 10% of limit)`);
      return;
    }

    // If key already exists, remove old size first
    const existing = this.cache.get(key);
    if (existing) {
      this.currentBytes -= existing.size;
      this.cache.delete(key);
    }

    // Evict LRU entries until there is room
    while (this.currentBytes + size > this.maxBytes && this.cache.size > 0) {
      const lruKey = this.cache.keys().next().value as string;
      const lruEntry = this.cache.get(lruKey)!;
      this.cache.delete(lruKey);
      this.currentBytes -= lruEntry.size;
    }

    this.cache.set(key, { buffer, contentType, size });
    this.currentBytes += size;
  }

  /** Returns human-readable cache statistics. */
  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      sizeMB: parseFloat((this.currentBytes / 1024 / 1024).toFixed(1)),
      maxMB: parseFloat((this.maxBytes / 1024 / 1024).toFixed(0)),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : 'n/a'
    };
  }
}

/**
 * Build a normalized, deterministic cache key from image path and processing params.
 * Params are sorted alphabetically so different insertion orders yield the same key.
 */
export function buildCacheKey(path: string, params: Record<string, unknown>): string {
  const paramStr = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return paramStr ? `${path}?${paramStr}` : path;
}

/** Singleton instance — shared across all requests within one container. */
const maxMB = parseInt(process.env.IMAGE_CACHE_MAX_MB ?? '512', 10);
export const imageCache = new ImageCache(maxMB);
