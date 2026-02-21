/**
 * Request Deduplication — Coalesce duplicate in-flight requests
 *
 * When multiple identical requests arrive while one is already being processed,
 * subsequent callers wait for the first request's result instead of making
 * redundant upstream calls.
 */

import { createHash } from "node:crypto";
import type { UpstreamResult } from "./router/types.js";

/** Fields used to compute the dedup key (same as cache). */
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

interface Waiter {
  resolve: (result: UpstreamResult) => void;
  reject: (error: Error) => void;
}

interface DedupEntry {
  waiters: Waiter[];
  createdAt: number;
}

export type AcquireResult =
  | { status: "new" }
  | { status: "waiting"; promise: Promise<UpstreamResult> };

export class RequestDedup {
  private readonly inflight = new Map<string, DedupEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 30_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Compute a SHA-256 dedup key from a normalized subset of the request body.
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

  /**
   * Try to acquire a dedup slot.
   * - Returns `{ status: "new" }` if this is the first request (caller proceeds).
   * - Returns `{ status: "waiting", promise }` if another request is in-flight
   *   (caller should await the promise for the coalesced result).
   */
  acquire(key: string): AcquireResult {
    this.prune();

    const existing = this.inflight.get(key);
    if (existing) {
      const promise = new Promise<UpstreamResult>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
      return { status: "waiting", promise };
    }

    this.inflight.set(key, { waiters: [], createdAt: Date.now() });
    return { status: "new" };
  }

  /** Deliver a result to all waiters and clear the dedup entry. */
  resolve(key: string, result: UpstreamResult): void {
    const entry = this.inflight.get(key);
    if (!entry) return;
    this.inflight.delete(key);
    for (const waiter of entry.waiters) {
      waiter.resolve(result);
    }
  }

  /** Reject all waiters with an error and clear the dedup entry. */
  reject(key: string, error: Error): void {
    const entry = this.inflight.get(key);
    if (!entry) return;
    this.inflight.delete(key);
    for (const waiter of entry.waiters) {
      waiter.reject(error);
    }
  }

  /** Remove stale entries that have exceeded the TTL. */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.inflight) {
      if (now - entry.createdAt >= this.ttlMs) {
        // Reject stale waiters
        for (const waiter of entry.waiters) {
          waiter.reject(new Error("Dedup entry expired"));
        }
        this.inflight.delete(key);
      }
    }
  }

  /** Number of in-flight dedup entries. */
  get size(): number {
    return this.inflight.size;
  }

  /** Clear all state. */
  clear(): void {
    this.inflight.clear();
  }
}
