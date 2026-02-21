/**
 * Response Cache — LRU cache with TTL for upstream responses
 *
 * Caches successful non-streaming responses to avoid redundant upstream calls.
 * Uses JS Map insertion-order for LRU eviction.
 */

import { createHash } from "node:crypto";
import type { UpstreamResult, CacheConfig } from "./router/types.js";
import { DEFAULT_CACHE_CONFIG } from "./router/types.js";

interface CacheEntry {
  result: UpstreamResult;
  cachedAt: number;
}

/** Fields used to compute the cache key (everything that affects the response). */
const KEY_FIELDS = ["model", "messages", "temperature", "tools", "tool_choice", "response_format"] as const;

/** OpenClaw timestamp pattern injected into message content. */
const TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;

/** Recursively strip OpenClaw timestamps from string values in `content` fields. */
function stripTimestamps(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripTimestamps);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "content" && typeof value === "string") {
        result[key] = value.replace(TIMESTAMP_PATTERN, "");
      } else {
        result[key] = stripTimestamps(value);
      }
    }
    return result;
  }
  return obj;
}

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /**
   * Compute a SHA-256 cache key from a normalized subset of the request body.
   * Strips fields that don't affect response content (stream, timestamps, etc.).
   */
  computeKey(body: Record<string, unknown>): string {
    const normalized: Record<string, unknown> = {};
    for (const field of KEY_FIELDS) {
      if (body[field] !== undefined) {
        normalized[field] = body[field];
      }
    }
    const stripped = stripTimestamps(normalized);
    const json = JSON.stringify(stripped);
    return createHash("sha256").update(json).digest("hex");
  }

  /** Retrieve a cached result. Returns null on miss or expiry. */
  get(key: string): UpstreamResult | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.cachedAt >= this.config.ttlMs) {
      this.entries.delete(key);
      return null;
    }

    // LRU refresh: delete and re-insert to move to end
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.result;
  }

  /**
   * Store a successful response in the cache.
   * Skips storage if status >= 400 or body exceeds max entry size.
   */
  set(key: string, result: UpstreamResult): void {
    // Don't cache errors
    if (result.status >= 400) return;

    // Don't cache oversized responses
    if (result.body.length > this.config.maxEntrySize) return;

    // Evict oldest if at capacity
    if (this.entries.size >= this.config.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    this.entries.set(key, { result, cachedAt: Date.now() });
  }

  /** Current number of entries (including potentially expired ones). */
  get size(): number {
    return this.entries.size;
  }

  /** Clear all cached entries. */
  clear(): void {
    this.entries.clear();
  }
}
