/**
 * Rate Limiter Tests
 *
 * Run: node --import tsx tests/rate-limiter.test.ts
 */

import assert from "node:assert";
import { RateLimiter } from "../src/rate-limiter.js";

console.log("🧪 Running rate-limiter tests...\n");

// Fresh state — nothing is rate-limited
{
  const rl = new RateLimiter();
  assert.strictEqual(rl.isRateLimited("openai/gpt-4o"), false);
  assert.strictEqual(rl.size, 0);
  console.log("✅ Fresh state: no models are rate-limited");
}

// Record + check — model is rate-limited after recording
{
  const rl = new RateLimiter();
  rl.recordRateLimit("openai/gpt-4o");
  assert.strictEqual(rl.isRateLimited("openai/gpt-4o"), true);
  assert.strictEqual(rl.isRateLimited("anthropic/claude-sonnet-4"), false);
  assert.strictEqual(rl.size, 1);
  console.log("✅ Record + check: model is rate-limited, others are not");
}

// Cooldown expiry — model is no longer rate-limited after cooldown
{
  const rl = new RateLimiter(50); // 50ms cooldown
  rl.recordRateLimit("openai/gpt-4o");
  assert.strictEqual(rl.isRateLimited("openai/gpt-4o"), true);

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(rl.isRateLimited("openai/gpt-4o"), false);
  console.log("✅ Cooldown expiry: model is cleared after cooldown window");
}

// Reorder — non-limited models first, limited at end
{
  const rl = new RateLimiter();
  const models = ["a", "b", "c", "d"];
  rl.recordRateLimit("b");
  rl.recordRateLimit("d");
  const reordered = rl.prioritizeNonRateLimited(models);
  assert.deepStrictEqual(reordered, ["a", "c", "b", "d"]);
  console.log("✅ Reorder: non-limited first, limited at end");
}

// Reorder preserves relative order within each group
{
  const rl = new RateLimiter();
  const models = ["x", "y", "z"];
  rl.recordRateLimit("x");
  const reordered = rl.prioritizeNonRateLimited(models);
  assert.deepStrictEqual(reordered, ["y", "z", "x"]);
  console.log("✅ Reorder: preserves relative order");
}

// No models removed — all models still present after reorder
{
  const rl = new RateLimiter();
  const models = ["a", "b", "c"];
  rl.recordRateLimit("a");
  rl.recordRateLimit("b");
  rl.recordRateLimit("c");
  const reordered = rl.prioritizeNonRateLimited(models);
  assert.strictEqual(reordered.length, 3);
  assert.deepStrictEqual(reordered, ["a", "b", "c"]); // all limited, order preserved
  console.log("✅ Reorder: limited models are not removed");
}

// Clear resets all state
{
  const rl = new RateLimiter();
  rl.recordRateLimit("a");
  rl.recordRateLimit("b");
  rl.clear();
  assert.strictEqual(rl.size, 0);
  assert.strictEqual(rl.isRateLimited("a"), false);
  console.log("✅ Clear: all state reset");
}

console.log("\n🎉 All rate-limiter tests passed!\n");
