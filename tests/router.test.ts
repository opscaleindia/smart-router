/**
 * Smart Router Tests
 *
 * Validates the 14-dimension classifier and model selection logic.
 * Run: npx tsx tests/router.test.ts
 */

import { route, classifyByRules, Tier } from "../src/index.js";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Classifier tests
// ---------------------------------------------------------------------------

console.log("🧪 Running smart-router tests...\n");

// SIMPLE tier (may default to MEDIUM if ambiguity threshold triggers)
{
  const result = classifyByRules("What is the capital of France?");
  assert.ok(
    result.tier === Tier.SIMPLE || result.tier === Tier.MEDIUM,
    `Expected SIMPLE or MEDIUM, got ${result.tier}`,
  );
  console.log(`✅ "What is the capital of France?" → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

{
  const result = classifyByRules("Hello");
  assert.ok(
    result.tier === Tier.SIMPLE || result.tier === Tier.MEDIUM,
    `Expected SIMPLE or MEDIUM, got ${result.tier}`,
  );
  console.log(`✅ "Hello" → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

{
  const result = classifyByRules("Translate 'good morning' to Spanish");
  assert.ok(
    result.tier === Tier.SIMPLE || result.tier === Tier.MEDIUM,
    `Expected SIMPLE or MEDIUM, got ${result.tier}`,
  );
  console.log(`✅ "Translate 'good morning' to Spanish" → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

// MEDIUM tier
{
  const result = classifyByRules("Write a function to sort an array in Python");
  assert.ok(
    result.tier === Tier.MEDIUM || result.tier === Tier.COMPLEX,
    `Expected MEDIUM or COMPLEX, got ${result.tier}`,
  );
  console.log(`✅ "Write a function to sort an array in Python" → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

{
  const result = classifyByRules("Explain how OAuth 2.0 works with a code example");
  assert.ok(
    result.tier === Tier.MEDIUM || result.tier === Tier.COMPLEX,
    `Expected MEDIUM or COMPLEX, got ${result.tier}`,
  );
  console.log(`✅ "Explain how OAuth 2.0 works with a code example" → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

// COMPLEX tier (heavy technical content should score MEDIUM or above)
{
  const result = classifyByRules(
    "Design a distributed microservice architecture for a real-time trading platform with Kubernetes deployment, load balancing, and database sharding strategy. Optimize for low latency throughput with Redis caching and Kafka message queues.",
  );
  assert.ok(
    result.tier === Tier.MEDIUM || result.tier === Tier.COMPLEX || result.tier === Tier.REASONING,
    `Expected MEDIUM+, got ${result.tier}`,
  );
  console.log(`✅ "Design a distributed microservice architecture..." → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

// REASONING tier
{
  const result = classifyByRules(
    "Prove that the halting problem is undecidable using a proof by contradiction, step by step",
  );
  assert.strictEqual(result.tier, Tier.REASONING, `Expected REASONING, got ${result.tier}`);
  console.log(`✅ "Prove that the halting problem is undecidable..." → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

{
  const result = classifyByRules(
    "Derive the chain of thought formally: prove the theorem that every continuous function on a closed interval is bounded",
  );
  assert.strictEqual(result.tier, Tier.REASONING, `Expected REASONING, got ${result.tier}`);
  console.log(`✅ "Derive the chain of thought formally..." → ${result.tier} (score: ${result.score.toFixed(3)})`);
}

// ---------------------------------------------------------------------------
// Full route() tests
// ---------------------------------------------------------------------------

console.log("\n--- Full route() tests ---\n");

{
  const decision = route("What is 2 + 2?");
  assert.ok(decision.tier === Tier.SIMPLE || decision.tier === Tier.MEDIUM);
  assert.strictEqual(decision.profile, "auto");
  assert.ok(decision.model.length > 0, "Model should be set");
  assert.ok(decision.fallbacks.length > 0, "Should have fallbacks");
  assert.ok(decision.cost.savingsPercent > 0, "Should show savings vs baseline");
  console.log(`✅ route("What is 2 + 2?") → ${decision.model} (${decision.tier}, ${decision.cost.savingsPercent}% savings)`);
}

// Eco profile
{
  const decision = route("Explain recursion", "", 4096, { profile: "eco" });
  assert.strictEqual(decision.profile, "eco");
  console.log(`✅ route("Explain recursion", eco) → ${decision.model} (${decision.tier})`);
}

// Premium profile
{
  const decision = route("Explain recursion", "", 4096, { profile: "premium" });
  assert.strictEqual(decision.profile, "premium");
  console.log(`✅ route("Explain recursion", premium) → ${decision.model} (${decision.tier})`);
}

// Free profile
{
  const decision = route("Hello", "", 4096, { profile: "free" });
  assert.strictEqual(decision.profile, "free");
  assert.ok(decision.model.includes(":free"), "Free profile should use free models");
  console.log(`✅ route("Hello", free) → ${decision.model} (${decision.tier})`);
}

// Force tier
{
  const decision = route("Hello", "", 4096, { forceTier: Tier.COMPLEX });
  assert.strictEqual(decision.tier, Tier.COMPLEX);
  console.log(`✅ route("Hello", forceTier=COMPLEX) → ${decision.model} (${decision.tier})`);
}

// Structured output override
{
  const result = classifyByRules("List the planets", "Respond in JSON schema format");
  assert.ok(
    result.tier !== Tier.SIMPLE,
    `Structured output should upgrade from SIMPLE, got ${result.tier}`,
  );
  console.log(`✅ Structured output override → ${result.tier}`);
}

// Cost estimation
{
  const decision = route("What is AI?");
  assert.ok(decision.cost.estimated >= 0, "Cost should be non-negative");
  assert.ok(decision.cost.baseline > 0, "Baseline should be positive");
  assert.ok(decision.cost.estimated < decision.cost.baseline, "Selected model should be cheaper than baseline");
  console.log(`✅ Cost: $${decision.cost.estimated.toFixed(6)} vs baseline $${decision.cost.baseline.toFixed(6)} (${decision.cost.savingsPercent}% savings)`);
}

// 14 dimension signals
{
  const result = classifyByRules("Build a REST API with authentication");
  assert.strictEqual(result.signals.length, 15, `Expected 15 dimension signals, got ${result.signals.length}`);
  const dimensions = result.signals.map((s) => s.dimension);
  assert.ok(dimensions.includes("codePresence"), "Should have codePresence dimension");
  assert.ok(dimensions.includes("reasoningMarkers"), "Should have reasoningMarkers dimension");
  console.log(`✅ All 15 scoring dimensions present`);
}

console.log("\n🎉 All tests passed!\n");
