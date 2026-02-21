/**
 * Request Dedup Tests
 *
 * Run: node --import tsx tests/dedup.test.ts
 */

import assert from "node:assert";
import { RequestDedup } from "../src/dedup.js";
import type { UpstreamResult } from "../src/router/types.js";

console.log("🧪 Running dedup tests...\n");

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

// First acquire returns "new"
{
  const dedup = new RequestDedup();
  const slot = dedup.acquire("key-1");
  assert.strictEqual(slot.status, "new");
  assert.strictEqual(dedup.size, 1);
  dedup.clear();
  console.log("✅ First acquire returns 'new'");
}

// Second acquire returns "waiting"
{
  const dedup = new RequestDedup();
  const slot1 = dedup.acquire("key-1");
  assert.strictEqual(slot1.status, "new");

  const slot2 = dedup.acquire("key-1");
  assert.strictEqual(slot2.status, "waiting");
  assert.strictEqual(dedup.size, 1);
  dedup.clear();
  console.log("✅ Second acquire returns 'waiting'");
}

// Resolve delivers result to all waiters
{
  const dedup = new RequestDedup();
  dedup.acquire("key-1"); // "new" — owner

  const slot2 = dedup.acquire("key-1");
  assert.strictEqual(slot2.status, "waiting");

  const slot3 = dedup.acquire("key-1");
  assert.strictEqual(slot3.status, "waiting");

  const result = makeResult();

  // Resolve in next tick to let promises attach
  setTimeout(() => dedup.resolve("key-1", result), 1);

  if (slot2.status === "waiting" && slot3.status === "waiting") {
    const [r2, r3] = await Promise.all([slot2.promise, slot3.promise]);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(r2.model, "openai/gpt-4o");
  }
  assert.strictEqual(dedup.size, 0);
  console.log("✅ Resolve delivers result to all waiters");
}

// Reject propagates error to waiters
{
  const dedup = new RequestDedup();
  dedup.acquire("key-2");

  const slot2 = dedup.acquire("key-2");
  assert.strictEqual(slot2.status, "waiting");

  const error = new Error("upstream failed");
  setTimeout(() => dedup.reject("key-2", error), 1);

  if (slot2.status === "waiting") {
    try {
      await slot2.promise;
      assert.fail("Should have rejected");
    } catch (err: any) {
      assert.strictEqual(err.message, "upstream failed");
    }
  }
  assert.strictEqual(dedup.size, 0);
  console.log("✅ Reject propagates error to waiters");
}

// Different keys are independent
{
  const dedup = new RequestDedup();
  const slot1 = dedup.acquire("key-a");
  const slot2 = dedup.acquire("key-b");
  assert.strictEqual(slot1.status, "new");
  assert.strictEqual(slot2.status, "new");
  assert.strictEqual(dedup.size, 2);
  dedup.clear();
  console.log("✅ Different keys are independent");
}

// Prune stale entries
{
  const dedup = new RequestDedup(50); // 50ms TTL
  dedup.acquire("stale-key");
  assert.strictEqual(dedup.size, 1);

  await new Promise((r) => setTimeout(r, 60));

  // Next acquire triggers prune
  dedup.acquire("new-key");
  // stale-key should be pruned, new-key added
  assert.strictEqual(dedup.size, 1);
  console.log("✅ Prune removes stale entries");
}

// computeKey normalization
{
  const dedup = new RequestDedup();
  const key1 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  const key2 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.strictEqual(key1, key2);
  console.log("✅ computeKey normalizes request body");
}

// Timestamp stripping — same content with different timestamps produce same key
{
  const dedup = new RequestDedup();
  const key1 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 2+2?" }],
  });
  const key2 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[MON 2026-02-08 14:45 EST] What is 2+2?" }],
  });
  assert.strictEqual(key1, key2);
  console.log("✅ Timestamp stripping produces same dedup key");
}

// Timestamp stripping — different content still produces different keys
{
  const dedup = new RequestDedup();
  const key1 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 2+2?" }],
  });
  const key2 = dedup.computeKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "[SUN 2026-02-07 13:30 PST] What is 3+3?" }],
  });
  assert.notStrictEqual(key1, key2);
  console.log("✅ Different content with timestamps still produces different keys");
}

console.log("\n🎉 All dedup tests passed!\n");
