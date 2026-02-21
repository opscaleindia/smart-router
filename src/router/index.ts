/**
 * Smart Router — Entry Point
 *
 * Orchestrates: classify → override checks → select model
 *
 * Usage:
 *   import { route } from '@openclaw/smart-router';
 *   const decision = route("What is the capital of France?");
 *   console.log(decision.model); // "google/gemini-2.0-flash-001"
 */

import type { RoutingDecision, RouteOptions, RoutingConfig } from "./types.js";
import { classifyByRules, estimateTokens } from "./rules.js";
import { selectModel } from "./selector.js";
import { DEFAULT_ROUTING_CONFIG } from "./config.js";

/**
 * Route a prompt to the optimal model.
 *
 * @param prompt - The user's prompt text.
 * @param systemPrompt - Optional system prompt.
 * @param maxOutputTokens - Expected max output tokens (default 4096).
 * @param options - Routing options (profile, forceTier, inputTokens).
 * @param config - Full routing config (uses defaults if omitted).
 * @returns A RoutingDecision with model, tier, scoring, fallbacks, and cost.
 */
export function route(
  prompt: string,
  systemPrompt: string = "",
  maxOutputTokens: number = 4096,
  options: RouteOptions = {},
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): RoutingDecision {
  const profile = options.profile ?? "auto";
  const inputTokens = options.inputTokens ?? estimateTokens(prompt + systemPrompt);

  // Step 1: Classify the request
  const scoring = classifyByRules(prompt, systemPrompt, maxOutputTokens, config.scoring);

  // Step 2: Apply forced tier override if specified
  const tier = options.forceTier ?? scoring.tier;

  // Step 3: Select model for the tier + profile
  const selection = selectModel(tier, profile, inputTokens, maxOutputTokens, config);

  return {
    model: selection.model,
    tier,
    scoring: { ...scoring, tier }, // reflect any forced tier
    fallbacks: selection.fallbacks,
    cost: selection.cost,
    profile,
  };
}

// Re-export everything needed by consumers
export { classifyByRules, estimateTokens } from "./rules.js";
export { selectModel } from "./selector.js";
export {
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_SCORING_CONFIG,
  MODEL_REGISTRY,
  BASELINE_MODEL_ID,
} from "./config.js";
export { Tier, DEFAULT_PROXY_FEATURES, DEFAULT_CACHE_CONFIG } from "./types.js";
export type {
  RoutingDecision,
  RouteOptions,
  RoutingConfig,
  RoutingProfile,
  ScoringResult,
  ScoringConfig,
  DimensionSignal,
  ScoringDimension,
  TierConfig,
  ProfileConfig,
  ModelInfo,
  CostEstimate,
  TierBoundaries,
  UpstreamResult,
  ProxyFeatureFlags,
  DegradedCheckResult,
  CacheConfig,
} from "./types.js";
