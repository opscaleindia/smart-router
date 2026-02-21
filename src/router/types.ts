/**
 * Smart Router Type Definitions
 *
 * Core types for the 14-dimension request classifier and model routing system.
 */

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export enum Tier {
  SIMPLE = "SIMPLE",
  MEDIUM = "MEDIUM",
  COMPLEX = "COMPLEX",
  REASONING = "REASONING",
}

// ---------------------------------------------------------------------------
// Routing profiles
// ---------------------------------------------------------------------------

export type RoutingProfile = "auto" | "eco" | "premium" | "free";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Names of the 14 scoring dimensions. */
export type ScoringDimension =
  | "tokenCount"
  | "codePresence"
  | "reasoningMarkers"
  | "technicalTerms"
  | "creativeMarkers"
  | "simpleIndicators"
  | "multiStepPatterns"
  | "questionComplexity"
  | "imperativeVerbs"
  | "constraintCount"
  | "outputFormat"
  | "referenceComplexity"
  | "negationComplexity"
  | "domainSpecificity"
  | "agenticTask";

/** A single dimension's contribution to the overall score. */
export interface DimensionSignal {
  dimension: ScoringDimension;
  raw: number; // [-1, 1]
  weight: number;
  weighted: number; // raw * weight
}

/** Result returned by the classifier. */
export interface ScoringResult {
  /** Weighted sum of all dimensions. */
  score: number;
  /** Mapped tier. */
  tier: Tier;
  /** Sigmoid-calibrated confidence in [0, 1]. */
  confidence: number;
  /** Per-dimension breakdown. */
  signals: DimensionSignal[];
}

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

export interface ModelInfo {
  /** OpenRouter model ID, e.g. "openai/gpt-4o-mini". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Cost per 1 M input tokens (USD). */
  inputPrice: number;
  /** Cost per 1 M output tokens (USD). */
  outputPrice: number;
  /** Max context window in tokens. */
  contextWindow: number;
  /** Max output tokens. */
  maxOutput: number;
}

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

export interface TierConfig {
  /** Primary model for this tier. */
  primary: string;
  /** Fallback model IDs, tried in order if primary fails. */
  fallbacks: string[];
}

/** One profile's full tier→model mapping. */
export type ProfileConfig = Record<Tier, TierConfig>;

// ---------------------------------------------------------------------------
// Scoring configuration
// ---------------------------------------------------------------------------

/** Tier boundary thresholds. */
export interface TierBoundaries {
  /** Below this → SIMPLE. */
  simple: number;
  /** Below this → MEDIUM (must be > simple). */
  medium: number;
  /** Below this → COMPLEX, at or above → REASONING. */
  complex: number;
}

export interface ScoringConfig {
  /** Sigmoid steepness for confidence calibration. */
  sigmoidSteepness: number;
  /** Confidence threshold below which we default to MEDIUM. */
  ambiguityThreshold: number;
  /** Tier boundary values. */
  boundaries: TierBoundaries;
}

// ---------------------------------------------------------------------------
// Routing decision (final output)
// ---------------------------------------------------------------------------

export interface CostEstimate {
  /** Estimated cost for the selected model (USD). */
  estimated: number;
  /** What this request would cost on Claude Opus (baseline). */
  baseline: number;
  /** Savings percentage vs baseline. */
  savingsPercent: number;
}

export interface RoutingDecision {
  /** The selected OpenRouter model ID. */
  model: string;
  /** The tier the request was classified into. */
  tier: Tier;
  /** Full scoring result from the classifier. */
  scoring: ScoringResult;
  /** Ordered fallback models (excludes primary). */
  fallbacks: string[];
  /** Cost estimate for this routing decision. */
  cost: CostEstimate;
  /** Which profile was used. */
  profile: RoutingProfile;
}

// ---------------------------------------------------------------------------
// Route function options
// ---------------------------------------------------------------------------

export interface RouteOptions {
  /** Routing profile. Defaults to "auto". */
  profile?: RoutingProfile;
  /** Force a specific tier (bypasses classifier). */
  forceTier?: Tier;
  /** Estimated input token count. If omitted, estimated from prompt length. */
  inputTokens?: number;
}

// ---------------------------------------------------------------------------
// Full routing config (top-level)
// ---------------------------------------------------------------------------

export interface RoutingConfig {
  /** Per-profile tier→model mappings. */
  profiles: Record<RoutingProfile, ProfileConfig>;
  /** Scoring / classification config. */
  scoring: ScoringConfig;
  /** Model pricing registry. */
  models: Record<string, ModelInfo>;
}
