/**
 * Model Selection — Tier + Profile → Model ID + Fallback Chain
 *
 * Takes a classified tier and routing profile, resolves the primary model
 * and fallback chain, and computes cost estimates with savings vs baseline.
 */

import type {
  Tier,
  RoutingProfile,
  CostEstimate,
  RoutingConfig,
  ModelInfo,
} from "./types.js";
import { DEFAULT_ROUTING_CONFIG, BASELINE_MODEL_ID } from "./config.js";

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of a request for a given model.
 *
 * @param modelId - OpenRouter model ID.
 * @param inputTokens - Estimated input token count.
 * @param outputTokens - Estimated output token count.
 * @param models - Model pricing registry.
 * @returns Cost in USD, or 0 if model not found.
 */
function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  models: Record<string, ModelInfo>,
): number {
  const model = models[modelId];
  if (!model) return 0;
  const inputCost = (inputTokens / 1_000_000) * model.inputPrice;
  const outputCost = (outputTokens / 1_000_000) * model.outputPrice;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// Selection result
// ---------------------------------------------------------------------------

export interface SelectionResult {
  /** Primary model ID. */
  model: string;
  /** Ordered fallback models. */
  fallbacks: string[];
  /** Cost estimate. */
  cost: CostEstimate;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select a model for the given tier and profile.
 *
 * @param tier - Classified request tier.
 * @param profile - Routing profile (auto, eco, premium, free).
 * @param inputTokens - Estimated input tokens.
 * @param outputTokens - Estimated output tokens.
 * @param config - Full routing config (uses defaults if omitted).
 * @returns Model ID, fallback chain, and cost estimate.
 */
export function selectModel(
  tier: Tier,
  profile: RoutingProfile = "auto",
  inputTokens: number = 1000,
  outputTokens: number = 4096,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): SelectionResult {
  const profileConfig = config.profiles[profile];
  const tierConfig = profileConfig[tier];

  const model = tierConfig.primary;
  const fallbacks = [...tierConfig.fallbacks];

  // Cost for selected model
  const estimated = estimateCost(model, inputTokens, outputTokens, config.models);

  // Baseline cost (Claude Opus)
  const baseline = estimateCost(BASELINE_MODEL_ID, inputTokens, outputTokens, config.models);

  // Savings percentage
  const savingsPercent =
    baseline > 0 ? Math.round(((baseline - estimated) / baseline) * 100) : 0;

  return {
    model,
    fallbacks,
    cost: {
      estimated,
      baseline,
      savingsPercent,
    },
  };
}
