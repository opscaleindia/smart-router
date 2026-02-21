/**
 * Provider Registry Tests
 *
 * Validates provider resolution from OpenClaw model keys.
 * Run: node --import tsx tests/providers.test.ts
 */

import { ProviderRegistry } from "../src/providers.js";
import type { OpenClawConfig } from "../src/openclaw-loader.js";
import assert from "node:assert";

console.log("🧪 Running provider tests...\n");

// ---------------------------------------------------------------------------
// Helper: create a mock OpenClaw config
// ---------------------------------------------------------------------------

function mockConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    providerKeys: {},
    customProviders: {},
    configDir: "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic resolution — OpenClaw key format (provider/model-id)
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig({
    providerKeys: { openrouter: "sk-or-test" },
  }));

  // OpenRouter model — provider is "openrouter", model-id is everything after
  const kimi = registry.resolve("openrouter/moonshotai/kimi-k2.5");
  assert.strictEqual(kimi.provider, "openrouter");
  assert.strictEqual(kimi.upstreamModelId, "moonshotai/kimi-k2.5");
  assert.strictEqual(kimi.hostname, "openrouter.ai");
  assert.strictEqual(kimi.apiKey, "sk-or-test");
  assert.ok(kimi.path.includes("/chat/completions"));
  console.log(`✅ openrouter/moonshotai/kimi-k2.5 → ${kimi.provider}/${kimi.upstreamModelId}`);

  const gpt = registry.resolve("openrouter/openai/gpt-5.2");
  assert.strictEqual(gpt.provider, "openrouter");
  assert.strictEqual(gpt.upstreamModelId, "openai/gpt-5.2");
  console.log(`✅ openrouter/openai/gpt-5.2 → ${gpt.provider}/${gpt.upstreamModelId}`);

  const claude = registry.resolve("openrouter/anthropic/claude-sonnet-4");
  assert.strictEqual(claude.provider, "openrouter");
  assert.strictEqual(claude.upstreamModelId, "anthropic/claude-sonnet-4");
  console.log(`✅ openrouter/anthropic/claude-sonnet-4 → ${claude.provider}/${claude.upstreamModelId}`);

  const free = registry.resolve("openrouter/openai/gpt-oss-120b:free");
  assert.strictEqual(free.provider, "openrouter");
  assert.strictEqual(free.upstreamModelId, "openai/gpt-oss-120b:free");
  console.log(`✅ openrouter/openai/gpt-oss-120b:free → ${free.provider}/${free.upstreamModelId}`);
}

// ---------------------------------------------------------------------------
// Direct provider resolution (when provider has auth)
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig({
    providerKeys: {
      openai: "sk-openai-test",
      xai: "xai-test-key",
      google: "google-test-key",
    },
  }));

  // OpenAI direct
  const gpt = registry.resolve("openai/gpt-5.2");
  assert.strictEqual(gpt.provider, "openai");
  assert.strictEqual(gpt.upstreamModelId, "gpt-5.2");
  assert.strictEqual(gpt.hostname, "api.openai.com");
  assert.strictEqual(gpt.apiKey, "sk-openai-test");
  console.log(`✅ openai/gpt-5.2 (direct) → ${gpt.provider}/${gpt.upstreamModelId} @ ${gpt.hostname}`);

  // xAI direct
  const grok = registry.resolve("xai/grok-code-fast-1");
  assert.strictEqual(grok.provider, "xai");
  assert.strictEqual(grok.upstreamModelId, "grok-code-fast-1");
  assert.strictEqual(grok.hostname, "api.x.ai");
  console.log(`✅ xai/grok-code-fast-1 (direct) → ${grok.provider}/${grok.upstreamModelId} @ ${grok.hostname}`);

  // Google direct
  const gemini = registry.resolve("google/gemini-2.5-flash");
  assert.strictEqual(gemini.provider, "google");
  assert.strictEqual(gemini.upstreamModelId, "gemini-2.5-flash");
  assert.ok(gemini.hostname.includes("googleapis.com"));
  console.log(`✅ google/gemini-2.5-flash (direct) → ${gemini.provider}/${gemini.upstreamModelId} @ ${gemini.hostname}`);
}

// ---------------------------------------------------------------------------
// Passthrough auth fallback
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig());

  const target = registry.resolve("openrouter/openai/gpt-4o", "Bearer sk-passthrough");
  assert.strictEqual(target.apiKey, "sk-passthrough");
  console.log(`✅ Passthrough auth used when no provider key configured`);
}

// ---------------------------------------------------------------------------
// No provider prefix — defaults to openrouter
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig({
    providerKeys: { openrouter: "sk-or-test" },
  }));

  const target = registry.resolve("some-model");
  assert.strictEqual(target.provider, "openrouter");
  assert.strictEqual(target.upstreamModelId, "some-model");
  console.log(`✅ No-prefix model defaults to openrouter`);
}

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig({
    providerKeys: { openrouter: "sk-test", openai: "sk-openai" },
  }));

  const status = registry.status();
  assert.strictEqual(status.openrouter, true);
  assert.strictEqual(status.openai, true);
  assert.strictEqual(status.xai, false);
  assert.strictEqual(status.google, false);
  console.log(`✅ Provider status reports correct key availability`);
}

// ---------------------------------------------------------------------------
// Custom provider from OpenClaw models.json
// ---------------------------------------------------------------------------

{
  const registry = new ProviderRegistry(mockConfig({
    providerKeys: { custom: "custom-key" },
    customProviders: {
      custom: {
        baseUrl: "http://localhost:9999/v1",
        apiKey: "custom-key",
      },
    },
  }));

  const target = registry.resolve("custom/my-model");
  assert.strictEqual(target.provider, "custom");
  assert.strictEqual(target.hostname, "localhost");
  assert.strictEqual(target.port, 9999);
  assert.strictEqual(target.useHttps, false);
  assert.strictEqual(target.upstreamModelId, "my-model");
  assert.strictEqual(target.apiKey, "custom-key");
  console.log(`✅ Custom provider from OpenClaw models.json works`);
}

console.log("\n🎉 All provider tests passed!\n");
