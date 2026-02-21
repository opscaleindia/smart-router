/**
 * Tier → Model Mapping Configuration
 *
 * Defines 4 routing profiles (auto, eco, premium, free), each mapping
 * the 4 tiers to OpenRouter model IDs with fallback chains.
 * Also contains the default scoring config and model pricing registry.
 *
 * IMPORTANT: All models MUST support tool/function calling on OpenRouter.
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
// Model registry — OpenRouter model IDs with pricing
// All models verified to support tool/function calling.
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // --- Cheap / Simple tier models ---
  "google/gemini-2.0-flash-001": {
    id: "google/gemini-2.0-flash-001",
    name: "Gemini 2.0 Flash",
    inputPrice: 0.10,
    outputPrice: 0.40,
    contextWindow: 1048576,
    maxOutput: 8192,
  },
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputPrice: 0.15,
    outputPrice: 0.60,
    contextWindow: 1048576,
    maxOutput: 65536,
  },
  "deepseek/deepseek-chat-v3-0324": {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3 0324",
    inputPrice: 0.27,
    outputPrice: 1.10,
    contextWindow: 64000,
    maxOutput: 8192,
  },

  // --- Mid-tier / Medium models ---
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.60,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  "anthropic/claude-3.5-haiku": {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    inputPrice: 0.80,
    outputPrice: 4.00,
    contextWindow: 200000,
    maxOutput: 8192,
  },

  // --- Premium / Complex tier models ---
  "openai/gpt-4o": {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.50,
    outputPrice: 10.00,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  "anthropic/claude-sonnet-4": {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    inputPrice: 3.00,
    outputPrice: 15.00,
    contextWindow: 200000,
    maxOutput: 8192,
  },
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputPrice: 2.50,
    outputPrice: 15.00,
    contextWindow: 1048576,
    maxOutput: 65536,
  },
  "anthropic/claude-sonnet-4-6": {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    inputPrice: 3.00,
    outputPrice: 15.00,
    contextWindow: 200000,
    maxOutput: 16384,
  },

  // --- Reasoning tier models ---
  "openai/o3": {
    id: "openai/o3",
    name: "OpenAI o3",
    inputPrice: 10.00,
    outputPrice: 40.00,
    contextWindow: 200000,
    maxOutput: 100000,
  },
  "deepseek/deepseek-r1-0528": {
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek R1 0528",
    inputPrice: 0.55,
    outputPrice: 2.19,
    contextWindow: 64000,
    maxOutput: 8192,
  },
  "openai/o3-mini": {
    id: "openai/o3-mini",
    name: "OpenAI o3-mini",
    inputPrice: 1.10,
    outputPrice: 4.40,
    contextWindow: 200000,
    maxOutput: 100000,
  },

  // --- Baseline (for savings comparison) ---
  "anthropic/claude-opus-4": {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15.00,
    outputPrice: 75.00,
    contextWindow: 200000,
    maxOutput: 32000,
  },

  // --- Free tier models (all with tool calling support) ---
  "meta-llama/llama-3.3-70b-instruct:free": {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Llama 3.3 70B (Free)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 4096,
  },
  "qwen/qwen3-4b:free": {
    id: "qwen/qwen3-4b:free",
    name: "Qwen3 4B (Free)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 32768,
    maxOutput: 4096,
  },
  "stepfun/step-3.5-flash:free": {
    id: "stepfun/step-3.5-flash:free",
    name: "Step 3.5 Flash (Free)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 32768,
    maxOutput: 4096,
  },
  "arcee-ai/trinity-large-preview:free": {
    id: "arcee-ai/trinity-large-preview:free",
    name: "Trinity Large Preview (Free)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 32768,
    maxOutput: 4096,
  },
};

// ---------------------------------------------------------------------------
// Profile configurations
// ---------------------------------------------------------------------------

const AUTO_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "google/gemini-2.0-flash-001",
    fallbacks: [
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat-v3-0324",
      "openai/gpt-4o-mini",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "openai/gpt-4o-mini",
    fallbacks: [
      "google/gemini-2.5-flash",
      "anthropic/claude-3.5-haiku",
      "deepseek/deepseek-chat-v3-0324",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "google/gemini-2.5-pro",
    fallbacks: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-6",
    ],
  },
  [Tier.REASONING]: {
    primary: "deepseek/deepseek-r1-0528",
    fallbacks: [
      "openai/o3-mini",
      "openai/o3",
    ],
  },
};

const ECO_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "google/gemini-2.0-flash-001",
    fallbacks: [
      "deepseek/deepseek-chat-v3-0324",
      "google/gemini-2.5-flash",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "deepseek/deepseek-chat-v3-0324",
    fallbacks: [
      "google/gemini-2.5-flash",
      "openai/gpt-4o-mini",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "google/gemini-2.5-flash",
    fallbacks: [
      "deepseek/deepseek-chat-v3-0324",
      "openai/gpt-4o-mini",
    ],
  },
  [Tier.REASONING]: {
    primary: "deepseek/deepseek-r1-0528",
    fallbacks: [
      "openai/o3-mini",
    ],
  },
};

const PREMIUM_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "openai/gpt-4o-mini",
    fallbacks: [
      "anthropic/claude-3.5-haiku",
      "google/gemini-2.5-flash",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "anthropic/claude-sonnet-4",
    fallbacks: [
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "anthropic/claude-sonnet-4-6",
    fallbacks: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
    ],
  },
  [Tier.REASONING]: {
    primary: "openai/o3",
    fallbacks: [
      "deepseek/deepseek-r1-0528",
      "openai/o3-mini",
    ],
  },
};

const FREE_PROFILE: ProfileConfig = {
  [Tier.SIMPLE]: {
    primary: "meta-llama/llama-3.3-70b-instruct:free",
    fallbacks: [
      "qwen/qwen3-4b:free",
      "stepfun/step-3.5-flash:free",
    ],
  },
  [Tier.MEDIUM]: {
    primary: "meta-llama/llama-3.3-70b-instruct:free",
    fallbacks: [
      "stepfun/step-3.5-flash:free",
      "arcee-ai/trinity-large-preview:free",
    ],
  },
  [Tier.COMPLEX]: {
    primary: "meta-llama/llama-3.3-70b-instruct:free",
    fallbacks: [
      "arcee-ai/trinity-large-preview:free",
      "stepfun/step-3.5-flash:free",
    ],
  },
  [Tier.REASONING]: {
    primary: "meta-llama/llama-3.3-70b-instruct:free",
    fallbacks: [
      "arcee-ai/trinity-large-preview:free",
      "qwen/qwen3-4b:free",
    ],
  },
};

// ---------------------------------------------------------------------------
// Baseline model for savings comparison
// ---------------------------------------------------------------------------

export const BASELINE_MODEL_ID = "anthropic/claude-opus-4";

// ---------------------------------------------------------------------------
// Full routing config
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  profiles: {
    auto: AUTO_PROFILE,
    eco: ECO_PROFILE,
    premium: PREMIUM_PROFILE,
    free: FREE_PROFILE,
  } as Record<RoutingProfile, ProfileConfig>,
  scoring: DEFAULT_SCORING_CONFIG,
  models: MODEL_REGISTRY,
};
