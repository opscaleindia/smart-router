/**
 * Response Cache Tests
 *
 * Run: node --import tsx tests/cache.test.ts
 */

import assert from "node:assert";
import { ResponseCache } from "../src/cache.js";
import type { UpstreamResult } from "../src/router/types.js";

console.log("🧪 Running cache tests...\n");

function makeResult(overrides: Partial<UpstreamResult> = {}): UpstreamResult {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"choices":[]}'),
    model: "openai/gpt-4o",
    attemptIndex: 0,
    ...overrides,
  };
}

// Miss then hit round-trip
{
  const cache = new ResponseCache();
  const key = cache.computeKey({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });

  assert.strictEqual(cache.get(key), null);

  const result = makeResult();
  cache.set(key, result);
  const cached = cache.get(key);
  assert.ok(cached);
  assert.strictEqual(cached.status, 200);
  assert.strictEqual(cached.model, "openai/gpt-4o");
  assert.deepStrictEqual(cached.body, result.body);
  console.log("✅ Miss/hit round-trip works");
}

// TTL expiry
{
  const cache = new ResponseCache({ ttlMs: 50 });
  const key = "test-ttl";
  cache.set(key, makeResult());
  assert.ok(cache.get(key));

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(cache.get(key), null);
  console.log("✅ TTL expiry works");
}

// Errors not cached (status >= 400)
{
  const cache = new ResponseCache();
  const key = "error-key";
  cache.set(key, makeResult({ status: 500 }));
  assert.strictEqual(cache.get(key), null);
  assert.strictEqual(cache.size, 0);
  console.log("✅ Error responses are not cached");
}

// 429 not cached
{
  const cache = new ResponseCache();
  const key = "rate-limited";
  cache.set(key, makeResult({ status: 429 }));
  assert.strictEqual(cache.get(key), null);
  console.log("✅ 429 responses are not cached");
}

// Oversized body not cached
{
  const cache = new ResponseCache({ maxEntrySize: 100 });
  const key = "big-entry";
  const bigBody = Buffer.alloc(200, "x");
  cache.set(key, makeResult({ body: bigBody }));
  assert.strictEqual(cache.get(key), null);
  assert.strictEqual(cache.size, 0);
  console.log("✅ Oversized responses are not cached");
}

// LRU eviction
{
  const cache = new ResponseCache({ maxEntries: 3 });
  cache.set("a", makeResult());
  cache.set("b", makeResult());
  cache.set("c", makeResult());
  assert.strictEqual(cache.size, 3);

  // Adding a 4th should evict the oldest ("a")
  cache.set("d", makeResult());
  assert.strictEqual(cache.size, 3);
  assert.strictEqual(cache.get("a"), null);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
  assert.ok(cache.get("d"));
  console.log("✅ LRU eviction removes oldest entry");
}

// LRU refresh on get
{
  const cache = new ResponseCache({ maxEntries: 3 });
  cache.set("a", makeResult());
  cache.set("b", makeResult());
  cache.set("c", makeResult());

  // Access "a" to refresh it
  cache.get("a");

  // Now add "d" — should evict "b" (oldest after refresh), not "a"
  cache.set("d", makeResult());
  assert.ok(cache.get("a"), "a should still be cached after refresh");
  assert.strictEqual(cache.get("b"), null, "b should be evicted");
  console.log("✅ LRU refresh on get works");
}

// Key normalization — same content produces same key regardless of extra fields
{
  const cache = new ResponseCache();
  const key1 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    timestamp: 123,
  });
  const key2 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    timestamp: 456,
  });
  assert.strictEqual(key1, key2);
  console.log("✅ Key normalization strips non-content fields");
}

// Different content produces different keys
{
  const cache = new ResponseCache();
  const key1 = cache.computeKey({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });
  const key2 = cache.computeKey({ model: "gpt-4o", messages: [{ role: "user", content: "world" }] });
  assert.notStrictEqual(key1, key2);
  console.log("✅ Different content produces different keys");
}

// Clear
{
  const cache = new ResponseCache();
  cache.set("a", makeResult());
  cache.set("b", makeResult());
  cache.clear();
  assert.strictEqual(cache.size, 0);
  console.log("✅ Clear removes all entries");
}

// Timestamp stripping — same content with different timestamps produce same key
{
  const cache = new ResponseCache();
  const key1 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 2+2?" }],
  });
  const key2 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[MON 2026-02-08 14:45 EST] What is 2+2?" }],
  });
  assert.strictEqual(key1, key2);
  console.log("✅ Timestamp stripping produces same cache key");
}

// Timestamp stripping — different content still produces different keys
{
  const cache = new ResponseCache();
  const key1 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 2+2?" }],
  });
  const key2 = cache.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 3+3?" }],
  });
  assert.notStrictEqual(key1, key2);
  console.log("✅ Different content with timestamps still produces different keys");
}

console.log("\n🎉 All cache tests passed!\n");
