/**
 * Degraded Response Detector Tests
 *
 * Run: node --import tsx tests/degraded-detector.test.ts
 */

import assert from "node:assert";
import { checkDegraded, DEGRADED_PATTERNS } from "../src/degraded-detector.js";

console.log("🧪 Running degraded-detector tests...\n");

// Each pattern individually
{
  const cases: { input: string; expectedLabel: string }[] = [
    { input: '{"error": "billing issue"}', expectedLabel: "billing" },
    { input: "Insufficient Balance for this request", expectedLabel: "insufficient_balance" },
    { input: "Rate limit exceeded", expectedLabel: "rate_limit" },
    { input: "rate-limit reached", expectedLabel: "rate_limit" },
    { input: "The model is currently unavailable", expectedLabel: "model_unavailable" },
    { input: "model_unavailable: try later", expectedLabel: "model_unavailable" },
    { input: "Service unavailable", expectedLabel: "service_unavailable" },
    { input: "service-unavailable", expectedLabel: "service_unavailable" },
    { input: "The server is overloaded", expectedLabel: "overloaded" },
    { input: "Request too large for this model", expectedLabel: "request_too_large" },
    { input: "Payload too large", expectedLabel: "payload_too_large" },
  ];

  for (const { input, expectedLabel } of cases) {
    const result = checkDegraded(input);
    assert.strictEqual(result.isDegraded, true, `Expected degraded for "${input}"`);
    assert.strictEqual(result.matchedPattern, expectedLabel, `Expected label "${expectedLabel}" for "${input}"`);
  }
  console.log("✅ Each pattern matches individually");
}

// Case insensitivity
{
  const result = checkDegraded("BILLING ERROR");
  assert.strictEqual(result.isDegraded, true);
  assert.strictEqual(result.matchedPattern, "billing");

  const result2 = checkDegraded("OVERLOADED servers");
  assert.strictEqual(result2.isDegraded, true);
  assert.strictEqual(result2.matchedPattern, "overloaded");
  console.log("✅ Case insensitive matching works");
}

// Repetitive loop detection
{
  const repeated = "This is a repeated block!!".repeat(10);
  const result = checkDegraded(repeated);
  assert.strictEqual(result.isDegraded, true);
  assert.strictEqual(result.matchedPattern, "repetitive_loop");
  console.log("✅ Repetitive loop detection works");
}

// Normal response passes
{
  const normal = JSON.stringify({
    id: "chatcmpl-123",
    choices: [{ message: { content: "The capital of France is Paris." } }],
  });
  const result = checkDegraded(normal);
  assert.strictEqual(result.isDegraded, false);
  assert.strictEqual(result.matchedPattern, null);
  console.log("✅ Normal response is not flagged as degraded");
}

// Empty string passes
{
  const result = checkDegraded("");
  assert.strictEqual(result.isDegraded, false);
  assert.strictEqual(result.matchedPattern, null);
  console.log("✅ Empty string is not flagged as degraded");
}

// Short non-degraded response
{
  const result = checkDegraded("Hello! How can I help you today?");
  assert.strictEqual(result.isDegraded, false);
  console.log("✅ Short non-degraded response passes");
}

// Pattern list is exported and non-empty
{
  assert.ok(Array.isArray(DEGRADED_PATTERNS));
  assert.ok(DEGRADED_PATTERNS.length > 0);
  console.log("✅ DEGRADED_PATTERNS is exported and non-empty");
}

console.log("\n🎉 All degraded-detector tests passed!\n");
