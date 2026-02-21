/**
 * @openclaw/smart-router
 *
 * In-house LLM smart router for OpenClaw.
 * Classifies prompt complexity using a 14-dimension weighted scorer
 * and routes to optimal models via OpenRouter.
 *
 * Usage:
 *   import { route, Tier } from '@openclaw/smart-router';
 *
 *   const decision = route("What is the capital of France?");
 *   console.log(decision.model);  // cheapest capable model
 *   console.log(decision.tier);   // "SIMPLE"
 *   console.log(decision.cost);   // { estimated, baseline, savingsPercent }
 */

export {
  route,
  classifyByRules,
  estimateTokens,
  selectModel,
  Tier,
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_SCORING_CONFIG,
  MODEL_REGISTRY,
  BASELINE_MODEL_ID,
  DEFAULT_PROXY_FEATURES,
  DEFAULT_CACHE_CONFIG,
} from "./router/index.js";

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
} from "./router/index.js";

// Proxy resilience features
export { RateLimiter } from "./rate-limiter.js";
export { checkDegraded, DEGRADED_PATTERNS } from "./degraded-detector.js";
export { ResponseCache } from "./cache.js";
export { RequestDedup } from "./dedup.js";
export { createProxyServer } from "./proxy.js";
export type { ProxyServerOptions } from "./proxy.js";
