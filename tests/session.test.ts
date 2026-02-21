/**
 * Session Store Tests
 *
 * Run: node --import tsx tests/session.test.ts
 */

import assert from "node:assert";
import { SessionStore, getSessionId } from "../src/session.js";

console.log("🧪 Running session tests...\n");

// Create and retrieve session
{
  const store = new SessionStore({ enabled: true, timeoutMs: 5000 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  const entry = store.getSession("sess-1");
  assert.ok(entry);
  assert.strictEqual(entry.model, "openai/gpt-4o");
  assert.strictEqual(entry.tier, "MEDIUM");
  assert.strictEqual(entry.requestCount, 1);
  store.close();
  console.log("✅ Create and retrieve session");
}

// Disabled store returns undefined
{
  const store = new SessionStore({ enabled: false });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  assert.strictEqual(store.getSession("sess-1"), undefined);
  store.close();
  console.log("✅ Disabled store returns undefined");
}

// Timeout expiry
{
  const store = new SessionStore({ enabled: true, timeoutMs: 50 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  assert.ok(store.getSession("sess-1"));

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(store.getSession("sess-1"), undefined);
  store.close();
  console.log("✅ Session expires after timeout");
}

// Touch extends session
{
  const store = new SessionStore({ enabled: true, timeoutMs: 100 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");

  await new Promise((r) => setTimeout(r, 60));
  store.touchSession("sess-1");

  await new Promise((r) => setTimeout(r, 60));
  // Should still be alive because we touched it
  const entry = store.getSession("sess-1");
  assert.ok(entry, "Session should still exist after touch");
  assert.strictEqual(entry!.requestCount, 2); // initial + touch
  store.close();
  console.log("✅ Touch extends session timeout");
}

// Model pinning — update model on set
{
  const store = new SessionStore({ enabled: true, timeoutMs: 5000 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  store.setSession("sess-1", "anthropic/claude-sonnet-4", "COMPLEX");
  const entry = store.getSession("sess-1");
  assert.ok(entry);
  assert.strictEqual(entry.model, "anthropic/claude-sonnet-4");
  assert.strictEqual(entry.requestCount, 2);
  store.close();
  console.log("✅ Model pinning updates on setSession");
}

// Header extraction
{
  const id1 = getSessionId({ "x-session-id": "abc123" });
  assert.strictEqual(id1, "abc123");

  const id2 = getSessionId({ "x-session-id": ["first", "second"] });
  assert.strictEqual(id2, "first");

  const id3 = getSessionId({});
  assert.strictEqual(id3, undefined);

  const id4 = getSessionId({ "x-session-id": "" });
  assert.strictEqual(id4, undefined);

  // Custom header name
  const id5 = getSessionId({ "x-custom": "custom-val" }, "x-custom");
  assert.strictEqual(id5, "custom-val");
  console.log("✅ Header extraction works correctly");
}

// Clear session
{
  const store = new SessionStore({ enabled: true, timeoutMs: 5000 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  store.setSession("sess-2", "openai/gpt-4o", "MEDIUM");
  store.clearSession("sess-1");
  assert.strictEqual(store.getSession("sess-1"), undefined);
  assert.ok(store.getSession("sess-2"));
  store.close();
  console.log("✅ Clear session removes specific session");
}

// Stats
{
  const store = new SessionStore({ enabled: true, timeoutMs: 5000 });
  store.setSession("sess-1", "openai/gpt-4o", "MEDIUM");
  store.setSession("sess-2", "anthropic/claude-sonnet-4", "COMPLEX");
  const stats = store.getStats();
  assert.strictEqual(stats.count, 2);
  assert.strictEqual(stats.sessions.length, 2);
  store.close();
  console.log("✅ Stats returns correct data");
}

console.log("\n🎉 All session tests passed!\n");
