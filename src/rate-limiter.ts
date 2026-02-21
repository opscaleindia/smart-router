/**
 * Rate Limiter — Per-model 429 tracking with cooldown
 *
 * Tracks which models have returned 429 (rate limited) responses
 * and deprioritizes them in the fallback chain during the cooldown window.
 */

interface RateLimitEntry {
  /** Timestamp when the rate limit was recorded. */
  limitedAt: number;
  /** Cooldown duration in milliseconds. */
  cooldownMs: number;
}

export class RateLimiter {
  private readonly state = new Map<string, RateLimitEntry>();
  private readonly defaultCooldownMs: number;

  constructor(cooldownMs: number = 60_000) {
    this.defaultCooldownMs = cooldownMs;
  }

  /** Mark a model as rate-limited at the current time. */
  recordRateLimit(modelId: string): void {
    this.state.set(modelId, {
      limitedAt: Date.now(),
      cooldownMs: this.defaultCooldownMs,
    });
  }

  /** Check whether a model is currently within its cooldown window. */
  isRateLimited(modelId: string): boolean {
    const entry = this.state.get(modelId);
    if (!entry) return false;
    if (Date.now() - entry.limitedAt >= entry.cooldownMs) {
      this.state.delete(modelId);
      return false;
    }
    return true;
  }

  /**
   * Stable-partition a list of model IDs: non-limited models first
   * (preserving their relative order), then limited models at the end
   * (also preserving their relative order). No models are removed.
   */
  prioritizeNonRateLimited(models: string[]): string[] {
    const nonLimited: string[] = [];
    const limited: string[] = [];
    for (const m of models) {
      if (this.isRateLimited(m)) {
        limited.push(m);
      } else {
        nonLimited.push(m);
      }
    }
    return [...nonLimited, ...limited];
  }

  /** Number of currently tracked rate-limited models. */
  get size(): number {
    return this.state.size;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.state.clear();
  }
}
