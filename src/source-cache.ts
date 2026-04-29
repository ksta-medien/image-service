/**
 * In-memory LRU cache for raw (unprocessed) GCS source image buffers.
 *
 * Motivation: the processed-image cache (image-cache.ts) stores one entry per
 * unique (path + transformation params) combination. When the same source image
 * is requested at many different widths, formats or aspect-ratios, each variant
 * is a cache miss for the processed cache — but they all need the same raw GCS
 * download. This secondary cache avoids repeated GCS round-trips (~50–200 ms
 * each) for those variants.
 *
 * Key: the normalized image path only (no transformation params).
 * Value: the raw Buffer as downloaded from GCS.
 *
 * Size is configurable via GCS_SOURCE_CACHE_MAX_MB env var (default 128 MB).
 * Single items larger than 10 % of the total limit are skipped (same policy as
 * the processed-image cache).
 *
 * LRU eviction uses the same Map insertion-order trick as image-cache.ts.
 */

interface SourceEntry {
  buffer: Buffer;
  size: number;
}

class SourceCache {
  private readonly cache = new Map<string, SourceEntry>();
  private readonly maxBytes: number;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(maxMB: number) {
    this.maxBytes = maxMB * 1024 * 1024;
    console.log(`[SourceCache] Initialized with max size ${maxMB} MB`);
  }

  get(key: string): Buffer | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    // Re-insert to promote to MRU position
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.buffer;
  }

  set(key: string, buffer: Buffer): void {
    const size = buffer.length;

    // Skip oversized single items
    if (size > this.maxBytes * 0.1) {
      return;
    }

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

    this.cache.set(key, { buffer, size });
    this.currentBytes += size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      sizeMB: parseFloat((this.currentBytes / 1024 / 1024).toFixed(1)),
      maxMB: parseFloat((this.maxBytes / 1024 / 1024).toFixed(0)),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "n/a",
    };
  }
}

const maxMB = parseInt(process.env.GCS_SOURCE_CACHE_MAX_MB ?? "128", 10);
export const sourceCache = new SourceCache(maxMB);
