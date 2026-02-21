/**
 * Tier → Model Mapping Configuration
 *
 * Defines 5 routing profiles (auto, eco, premium, free, agentic), each mapping
 * the 4 tiers to model IDs with fallback chains.
 *
 * IMPORTANT: Model IDs use OpenClaw key format: "provider/model-id"
 * (e.g. "openrouter/moonshotai/kimi-k2.5"). This ensures smart-router
 * only routes among models configured in OpenClaw.
 */

import {
  Tier,
  type ModelInfo,
  type ProfileConfig,
  type RoutingConfig,
  type RoutingProfile,
  type ScoringConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default scoring config
// ---------------------------------------------------------------------------

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  sigmoidSteepness: 12,
  ambiguityThreshold: 0.7,
  boundaries: {
    simple: 0.0,   // score < 0.0  → SIMPLE
    medium: 0.3,   // 0.0 ≤ score < 0.3  → MEDIUM
    complex: 0.5,  // 0.3 ≤ score < 0.5  → COMPLEX
                    // score ≥ 0.5  → REASONING
  },
};

// ---------------------------------------------------------------------------
// Model registry — OpenClaw key format (provider/model-id)
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // --- Moonshot / Kimi (via OpenRouter) ---
  "openrouter/moonshotai/kimi-k2.5": {
    id: "openrouter/moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    inputPrice: 0.50,
    outputPrice: 2.40,
    contextWindow: 262144,
    maxOutput: 8192,
  },

  // --- xAI / Grok (via OpenRouter) ---
  "openrouter/x-ai/grok-code-fast-1": {
    id: "openrouter/x-ai/grok-code-fast-1",
    name: "Grok Code Fast",
    inputPrice: 0.20,
    outputPrice: 1.50,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  "openrouter/x-ai/grok-4-1-fast": {
    id: "openrouter/x-ai/grok-4-1-fast",
    name: "Grok 4.1 Fast",
    inputPrice: 0.20,
    outputPrice: 0.50,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  "openrouter/x-ai/grok-4-0709": {
    id: "openrouter/x-ai/grok-4-0709",
    name: "Grok 4 (0709)",
    inputPrice: 0.20,
    outputPrice: 1.50,
    contextWindow: 131072,
    maxOutput: 16384,
  },

  // --- Google (via OpenRouter) ---
  "openrouter/google/gemini-3-pro-preview": {
    id: "openrouter/google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    inputPrice: 2.00,
    outputPrice: 12.00,
    contextWindow: 1050000,
    maxOutput: 65536,
  },
  "openrouter/google/gemini-2.5-pro": {
    id: "openrouter/google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputPrice: 1.25,
    outputPrice: 10.00,
    contextWindow: 1050000,
    maxOutput: 65536,
  },
  "openrouter/google/gemini-2.5-flash": {
    id: "openrouter/google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputPrice: 0.15,
    outputPrice: 0.60,
    contextWindow: 1000000,
    maxOutput: 65536,
  },

  // --- OpenAI (via OpenRouter) ---
  "openrouter/openai/gpt-5.2": {
    id: "openrouter/openai/gpt-5.2",
    name: "GPT-5.2",
    inputPrice: 1.75,
    outputPrice: 14.00,
    contextWindow: 400000,
    maxOutput: 128000,
  },
  "openrouter/openai/gpt-5.2-codex": {
    id: "openrouter/openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    inputPrice: 2.50,
    outputPrice: 12.00,
    contextWindow: 128000,
    maxOutput: 32000,
  },
  "openrouter/openai/gpt-4o": {
    id: "openrouter/openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.50,
    outputPrice: 10.00,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  "openrouter/openai/gpt-4o-mini": {
    id: "openrouter/openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.60,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  "openrouter/openai/o3": {
    id: "openrouter/openai/o3",
    name: "o3",
    inputPrice: 2.00,
    outputPrice: 8.00,
    contextWindow: 200000,
    maxOutput: 100000,
  },
  "openrouter/openai/o4-mini": {
    id: "openrouter/openai/o4-mini",
    name: "o4-mini",
    inputPrice: 1.10,
    outputPrice: 4.40,
    contextWindow: 128000,
    maxOutput: 65536,
  },

  // --- Anthropic (via OpenRouter) ---
  "openrouter/anthropic/claude-haiku-4.5": {
    id: "openrouter/anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    inputPrice: 1.00,
    outputPrice: 5.00,
    contextWindow: 200000,
    maxOutput: 8192,
  },
  "openrouter/anthropic/claude-sonnet-4": {
    id: "openrouter/anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    inputPrice: 3.00,
    outputPrice: 15.00,
    contextWindow: 200000,
    maxOutput: 64000,
  },
  "openrouter/anthropic/claude-opus-4": {
    id: "openrouter/anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15.00,
    outputPrice: 75.00,
    contextWindow: 200000,
    maxOutput: 32000,
  },

  // --- DeepSeek (via OpenRouter) ---
  "openrouter/deepseek/deepseek-chat": {
    id: "openrouter/deepseek/deepseek-chat",
    name: "DeepSeek V3 Chat",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
  },
  "openrouter/deepseek/deepseek-reasoner": {
    id: "openrouter/deepseek/deepseek-reasoner",
    name: "DeepSeek Reasoner",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
  },

  // --- NVIDIA / Free (via OpenRouter) ---
  "openrouter/openai/gpt-oss-120b:free": {
    id: "openrouter/openai/gpt-oss-120b:free",
    name: "GPT-OSS 120B (Free)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
};

// ---------------------------------------------------------------------------
// Profile configurations
// ---------------------------------------------------------------------------

const AUTO_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openrouter/moonshotai/kimi-k2.5",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/openai/gpt-oss-120b:free",
      "openrouter/deepseek/deepseek-chat",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openrouter/x-ai/grok-code-fast-1",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/deepseek/deepseek-chat",
      "openrouter/moonshotai/kimi-k2.5",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "openrouter/google/gemini-3-pro-preview",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/google/gemini-2.5-pro",
      "openrouter/deepseek/deepseek-chat",
      "openrouter/x-ai/grok-4-0709",
    ],
  },
  [Tier.REASONING]: {
    primary: "openrouter/x-ai/grok-4-1-fast",
    fallbacks: [
      "openrouter/deepseek/deepseek-reasoner",
      "openrouter/openai/o4-mini",
      "openrouter/openai/o3",
    ],
  },
};

const ECO_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openrouter/openai/gpt-oss-120b:free",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/deepseek/deepseek-chat",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openrouter/google/gemini-2.5-flash",
    fallbacks: [
      "openrouter/deepseek/deepseek-chat",
      "openrouter/openai/gpt-oss-120b:free",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "openrouter/google/gemini-2.5-flash",
    fallbacks: [
      "openrouter/deepseek/deepseek-chat",
      "openrouter/x-ai/grok-4-0709",
    ],
  },
  [Tier.REASONING]: {
    primary: "openrouter/x-ai/grok-4-1-fast",
    fallbacks: [
      "openrouter/deepseek/deepseek-reasoner",
    ],
  },
};

const PREMIUM_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openrouter/moonshotai/kimi-k2.5",
    fallbacks: [
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/google/gemini-2.5-flash",
      "openrouter/x-ai/grok-code-fast-1",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openrouter/openai/gpt-5.2-codex",
    fallbacks: [
      "openrouter/moonshotai/kimi-k2.5",
      "openrouter/google/gemini-2.5-pro",
      "openrouter/x-ai/grok-4-0709",
      "openrouter/anthropic/claude-sonnet-4",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "openrouter/anthropic/claude-opus-4",
    fallbacks: [
      "openrouter/openai/gpt-5.2-codex",
      "openrouter/anthropic/claude-sonnet-4",
      "openrouter/google/gemini-3-pro-preview",
      "openrouter/moonshotai/kimi-k2.5",
    ],
  },
  [Tier.REASONING]: {
    primary: "openrouter/anthropic/claude-sonnet-4",
    fallbacks: [
      "openrouter/anthropic/claude-opus-4",
      "openrouter/openai/o4-mini",
      "openrouter/openai/o3",
      "openrouter/x-ai/grok-4-1-fast",
    ],
  },
};

const FREE_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openrouter/openai/gpt-oss-120b:free",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/deepseek/deepseek-chat",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openrouter/openai/gpt-oss-120b:free",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/deepseek/deepseek-chat",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "openrouter/openai/gpt-oss-120b:free",
    fallbacks: [
      "openrouter/google/gemini-2.5-flash",
      "openrouter/deepseek/deepseek-chat",
    ],
  },
  [Tier.REASONING]: {
    primary: "openrouter/openai/gpt-oss-120b:free",
    fallbacks: [
      "openrouter/deepseek/deepseek-reasoner",
    ],
  },
};

const AGENTIC_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openrouter/moonshotai/kimi-k2.5",
    fallbacks: [
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/x-ai/grok-code-fast-1",
      "openrouter/openai/gpt-4o-mini",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openrouter/x-ai/grok-code-fast-1",
    fallbacks: [
      "openrouter/moonshotai/kimi-k2.5",
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/anthropic/claude-sonnet-4",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "openrouter/anthropic/claude-sonnet-4",
    fallbacks: [
      "openrouter/anthropic/claude-opus-4",
      "openrouter/openai/gpt-5.2",
      "openrouter/google/gemini-3-pro-preview",
      "openrouter/x-ai/grok-4-0709",
    ],
  },
  [Tier.REASONING]: {
    primary: "openrouter/anthropic/claude-sonnet-4",
    fallbacks: [
      "openrouter/anthropic/claude-opus-4",
      "openrouter/x-ai/grok-4-1-fast",
      "openrouter/deepseek/deepseek-reasoner",
    ],
  },
};

// ---------------------------------------------------------------------------
// Baseline model for savings comparison
// ---------------------------------------------------------------------------

export const BASELINE_MODEL_ID = "openrouter/anthropic/claude-opus-4";

// ---------------------------------------------------------------------------
// Full routing config
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  profiles: {
    auto: AUTO_PROFILE,
    eco: ECO_PROFILE,
    premium: PREMIUM_PROFILE,
    free: FREE_PROFILE,
    agentic: AGENTIC_PROFILE,
  } as Record<RoutingProfile, ProfileConfig>,
  scoring: DEFAULT_SCORING_CONFIG,
  models: MODEL_REGISTRY,
};
