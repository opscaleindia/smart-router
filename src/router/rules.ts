/**
 * Request Classifier — 14-dimension weighted keyword scorer
 *
 * Each dimension analyzes the prompt text and returns a score in [-1, 1].
 * Weights sum to 1.0. The weighted sum is mapped to a tier via configurable
 * boundaries, with sigmoid-calibrated confidence.
 */

import type {
  ScoringDimension,
  DimensionSignal,
  ScoringResult,
  ScoringConfig,
  Tier,
} from "./types.js";
import { Tier as TierEnum } from "./types.js";
import { DEFAULT_SCORING_CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

const REASONING_KEYWORDS = [
  "prove", "proof", "theorem", "lemma", "corollary",
  "step by step", "chain of thought", "reason through",
  "derive", "deduce", "infer", "logical", "formally",
  "contradiction", "induction", "hypothesis", "axiom",
  "iff", "if and only if", "necessary and sufficient",
  "qed", "therefore", "hence", "thus", "implies",
  "undecidable", "computability", "reducibility",
];

const CODE_KEYWORDS = [
  "function", "class", "import", "export", "const ", "let ", "var ",
  "def ", "return", "async", "await", "interface", "struct",
  "```", "console.log", "print(", "println", "System.out",
  "=>", "->", "lambda", "fn ", "pub ", "impl ",
  "#include", "using namespace", "package main",
  ".map(", ".filter(", ".reduce(", "for (", "while (",
  "try {", "catch (", "throw ", "raise ",
];

const TECHNICAL_KEYWORDS = [
  "algorithm", "kubernetes", "docker", "distributed",
  "microservice", "database", "sql", "nosql", "api",
  "rest", "graphql", "grpc", "websocket", "tcp", "udp",
  "encryption", "authentication", "oauth", "jwt",
  "ci/cd", "pipeline", "terraform", "aws", "gcp", "azure",
  "load balancer", "cache", "redis", "kafka", "rabbitmq",
  "neural network", "transformer", "embedding", "vector",
  "machine learning", "deep learning", "gradient",
  "linux", "kernel", "syscall", "mutex", "semaphore",
  "compiler", "parser", "ast", "lexer", "runtime",
  "architecture", "scalab", "latency", "throughput",
];

const CREATIVE_KEYWORDS = [
  "story", "poem", "poetry", "creative", "fiction",
  "narrative", "character", "plot", "brainstorm",
  "imagine", "fantasy", "metaphor", "dialogue",
  "screenplay", "song", "lyrics", "compose",
];

const SIMPLE_KEYWORDS = [
  "what is", "who is", "define", "meaning of",
  "translate", "hello", "hi ", "hey ", "thanks",
  "yes or no", "true or false", "capital of",
  "how do you say", "what does", "when was",
  "how old", "how many", "how much", "what color",
  "spell", "abbreviation", "acronym",
];

const MULTI_STEP_KEYWORDS = [
  "first", "then", "next", "finally", "step 1",
  "step 2", "step 3", "1.", "2.", "3.",
  "phase", "stage", "pipeline", "workflow",
  "after that", "once done", "followed by",
  "begin by", "start with", "end with",
];

const AGENTIC_KEYWORDS = [
  "edit", "modify", "update", "deploy", "fix",
  "debug", "refactor", "migrate", "install",
  "configure", "set up", "run", "execute",
  "read file", "write file", "create file",
  "open", "close", "restart", "monitor",
  "automate", "schedule", "orchestrate",
  // Git operations
  "git ", "git push", "git pull", "git commit", "git merge",
  "git checkout", "git clone", "git fetch", "git rebase",
  "git stash", "git branch", "git tag", "git diff",
  "git log", "git reset", "git cherry-pick", "git bisect",
  "git init", "git add", "push to", "pull from",
  "commit the", "merge the", "checkout to",
];

const CONSTRAINT_KEYWORDS = [
  "at most", "at least", "maximum", "minimum",
  "budget", "within", "no more than", "no fewer",
  "limit", "constraint", "requirement", "must",
  "exactly", "precisely", "strictly",
  "between", "range", "not exceed",
];

const IMPERATIVE_KEYWORDS = [
  "build", "create", "implement", "design",
  "develop", "construct", "generate", "produce",
  "write", "code", "program", "architect",
  "optimize", "improve", "enhance", "extend",
];

const OUTPUT_FORMAT_KEYWORDS = [
  "json", "yaml", "yml", "xml", "csv",
  "table", "markdown", "html", "latex",
  "formatted as", "output as", "return as",
  "schema", "template", "format",
];

const REFERENCE_KEYWORDS = [
  "above", "below", "previous", "earlier",
  "the docs", "the code", "the file", "the repo",
  "mentioned", "as shown", "see the", "refer to",
  "attached", "provided", "given",
];

const DOMAIN_KEYWORDS = [
  "quantum", "fpga", "genomics", "proteomics",
  "zero-knowledge", "homomorphic", "topology",
  "riemann", "hilbert", "banach", "manifold",
  "stochastic", "markov", "bayesian", "monte carlo",
  "vlsi", "asic", "photonics", "superconductor",
  "crispr", "mrna", "epigenetic", "metabolomics",
];

const NEGATION_KEYWORDS = [
  "don't", "dont", "do not", "avoid", "never",
  "without", "exclude", "not ", "isn't", "aren't",
  "shouldn't", "can't", "cannot", "must not",
  "prohibit", "forbid", "disallow",
];

// ---------------------------------------------------------------------------
// Dimension weights (sum = 1.0)
// ---------------------------------------------------------------------------

interface DimensionDef {
  dimension: ScoringDimension;
  weight: number;
  scorer: (text: string, systemPrompt: string, tokenEstimate: number) => number;
}

/** Count keyword hits in text, case-insensitive. */
function countKeywords(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    // Count all occurrences
    let idx = 0;
    while ((idx = lower.indexOf(kw, idx)) !== -1) {
      count++;
      idx += kw.length;
    }
  }
  return count;
}

/** Clamp a value to [-1, 1]. */
function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

const DIMENSIONS: DimensionDef[] = [
  {
    dimension: "reasoningMarkers",
    weight: 0.18,
    scorer: (text) => {
      const hits = countKeywords(text, REASONING_KEYWORDS);
      if (hits === 0) return -0.3;
      if (hits === 1) return 0.3;
      if (hits === 2) return 0.6;
      return 1.0;
    },
  },
  {
    dimension: "codePresence",
    weight: 0.15,
    scorer: (text) => {
      const hits = countKeywords(text, CODE_KEYWORDS);
      if (hits === 0) return -0.2;
      if (hits <= 2) return 0.2;
      if (hits <= 5) return 0.5;
      return 0.8;
    },
  },
  {
    dimension: "multiStepPatterns",
    weight: 0.12,
    scorer: (text) => {
      const hits = countKeywords(text, MULTI_STEP_KEYWORDS);
      if (hits === 0) return -0.2;
      if (hits <= 2) return 0.2;
      if (hits <= 4) return 0.5;
      return 0.8;
    },
  },
  {
    dimension: "technicalTerms",
    weight: 0.10,
    scorer: (text) => {
      const hits = countKeywords(text, TECHNICAL_KEYWORDS);
      if (hits === 0) return -0.2;
      if (hits <= 2) return 0.2;
      if (hits <= 5) return 0.5;
      return 0.9;
    },
  },
  {
    dimension: "tokenCount",
    weight: 0.08,
    scorer: (_text, _sys, tokenEstimate) => {
      if (tokenEstimate < 50) return -0.5;
      if (tokenEstimate < 150) return -0.2;
      if (tokenEstimate < 500) return 0.2;
      if (tokenEstimate < 2000) return 0.5;
      return 0.8;
    },
  },
  {
    dimension: "creativeMarkers",
    weight: 0.05,
    scorer: (text) => {
      const hits = countKeywords(text, CREATIVE_KEYWORDS);
      if (hits === 0) return 0;
      if (hits <= 2) return 0.3;
      return 0.6;
    },
  },
  {
    dimension: "questionComplexity",
    weight: 0.05,
    scorer: (text) => {
      const qCount = (text.match(/\?/g) || []).length;
      if (qCount === 0) return 0;
      if (qCount === 1) return -0.1;
      if (qCount <= 3) return 0.2;
      return 0.6;
    },
  },
  {
    dimension: "agenticTask",
    weight: 0.04,
    scorer: (text) => {
      const hits = countKeywords(text, AGENTIC_KEYWORDS);
      if (hits === 0) return -0.1;
      if (hits <= 2) return 0.3;
      if (hits <= 4) return 0.6;
      return 0.9;
    },
  },
  {
    dimension: "constraintCount",
    weight: 0.04,
    scorer: (text) => {
      const hits = countKeywords(text, CONSTRAINT_KEYWORDS);
      if (hits === 0) return -0.1;
      if (hits <= 2) return 0.3;
      return 0.7;
    },
  },
  {
    dimension: "imperativeVerbs",
    weight: 0.03,
    scorer: (text) => {
      const hits = countKeywords(text, IMPERATIVE_KEYWORDS);
      if (hits === 0) return -0.1;
      if (hits <= 2) return 0.2;
      if (hits <= 4) return 0.5;
      return 0.7;
    },
  },
  {
    dimension: "outputFormat",
    weight: 0.03,
    scorer: (text, systemPrompt) => {
      const combined = text + " " + systemPrompt;
      const hits = countKeywords(combined, OUTPUT_FORMAT_KEYWORDS);
      if (hits === 0) return -0.1;
      if (hits <= 2) return 0.3;
      return 0.6;
    },
  },
  {
    dimension: "simpleIndicators",
    weight: 0.02,
    scorer: (text) => {
      // Simple indicators produce NEGATIVE scores (push toward SIMPLE tier)
      const hits = countKeywords(text, SIMPLE_KEYWORDS);
      if (hits === 0) return 0.1;
      if (hits === 1) return -0.4;
      if (hits <= 3) return -0.7;
      return -1.0;
    },
  },
  {
    dimension: "referenceComplexity",
    weight: 0.02,
    scorer: (text) => {
      const hits = countKeywords(text, REFERENCE_KEYWORDS);
      if (hits === 0) return 0;
      if (hits <= 2) return 0.3;
      return 0.6;
    },
  },
  {
    dimension: "domainSpecificity",
    weight: 0.02,
    scorer: (text) => {
      const hits = countKeywords(text, DOMAIN_KEYWORDS);
      if (hits === 0) return 0;
      if (hits === 1) return 0.4;
      return 0.9;
    },
  },
  {
    dimension: "negationComplexity",
    weight: 0.01,
    scorer: (text) => {
      const hits = countKeywords(text, NEGATION_KEYWORDS);
      if (hits === 0) return 0;
      if (hits <= 2) return 0.2;
      return 0.5;
    },
  },
];

// Validate weights sum is reasonable at module load
const WEIGHT_SUM = DIMENSIONS.reduce((s, d) => s + d.weight, 0);
if (WEIGHT_SUM < 0.5 || WEIGHT_SUM > 1.5) {
  throw new Error(`Dimension weights sum to ${WEIGHT_SUM}, expected ~1.0`);
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

function sigmoid(x: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * x));
}

/**
 * Compute confidence based on distance from nearest tier boundary.
 * Farther from boundary → higher confidence.
 */
function computeConfidence(score: number, config: ScoringConfig): number {
  const boundaries = [
    config.boundaries.simple,
    config.boundaries.medium,
    config.boundaries.complex,
  ];

  let minDistance = Infinity;
  for (const b of boundaries) {
    const d = Math.abs(score - b);
    if (d < minDistance) minDistance = d;
  }

  // Sigmoid calibration: distance → confidence in [0.5, 1.0]
  return sigmoid(minDistance, config.sigmoidSteepness);
}

// ---------------------------------------------------------------------------
// Score → Tier mapping
// ---------------------------------------------------------------------------

function scoreToTier(score: number, config: ScoringConfig): Tier {
  if (score < config.boundaries.simple) return TierEnum.SIMPLE;
  if (score < config.boundaries.medium) return TierEnum.MEDIUM;
  if (score < config.boundaries.complex) return TierEnum.COMPLEX;
  return TierEnum.REASONING;
}

// ---------------------------------------------------------------------------
// Override logic
// ---------------------------------------------------------------------------

/**
 * Check for reasoning keyword override: if the USER prompt (not system prompt)
 * contains 3+ reasoning keywords, force REASONING tier.
 * Threshold raised from 2 to 3 to avoid false positives from casual usage
 * of words like "hence", "therefore", "implies" in normal conversation.
 */
function checkReasoningOverride(userPrompt: string): boolean {
  const hits = countKeywords(userPrompt, REASONING_KEYWORDS);
  return hits >= 3;
}

/** Git commands that indicate tool-execution tasks needing capable models. */
const GIT_COMMAND_KEYWORDS = [
  "git push", "git pull", "git commit", "git merge",
  "git checkout", "git clone", "git fetch", "git rebase",
  "git stash", "git branch", "git tag", "git reset",
  "git cherry-pick", "git bisect", "git init", "git add",
  "git diff", "git log",
];

/**
 * Check for agentic/git override: if the prompt contains a git command,
 * force at least COMPLEX tier so it routes to a model capable of
 * tool use and command execution (e.g. Claude Sonnet, Gemini Pro).
 */
function checkAgenticOverride(userPrompt: string): boolean {
  const hits = countKeywords(userPrompt, GIT_COMMAND_KEYWORDS);
  return hits >= 1;
}

/** If token count > 100k, force COMPLEX tier minimum. */
function checkTokenOverride(tokenEstimate: number): Tier | null {
  if (tokenEstimate > 100_000) return TierEnum.COMPLEX;
  return null;
}

/** If system prompt mentions JSON/schema output, enforce minimum MEDIUM. */
function checkStructuredOutputOverride(systemPrompt: string): boolean {
  const lower = systemPrompt.toLowerCase();
  return lower.includes("json") || lower.includes("schema");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate token count from character length.
 * Rough heuristic: ~4 chars per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Classify a request into a tier using the 14-dimension scoring system.
 *
 * IMPORTANT: Scoring is based primarily on the USER PROMPT, not the system
 * prompt. The system prompt is only used for specific dimensions where it
 * matters (outputFormat, structuredOutput override). This prevents long
 * system prompts (like agent instructions) from inflating the tier.
 *
 * @param prompt - The user's prompt text.
 * @param systemPrompt - The system prompt, if any.
 * @param maxOutputTokens - Expected max output tokens (for cost estimation).
 * @param config - Scoring configuration (uses defaults if omitted).
 * @returns Full scoring result with tier, confidence, and per-dimension signals.
 */
export function classifyByRules(
  prompt: string,
  systemPrompt: string = "",
  maxOutputTokens: number = 4096,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoringResult {
  // Token estimate uses only the user prompt + expected output.
  // System prompts are controlled by the framework, not request complexity.
  const tokenEstimate = estimateTokens(prompt) + maxOutputTokens;

  // Score each dimension against the USER PROMPT only.
  // The system prompt is passed through but individual scorers should
  // only use it where explicitly needed (e.g., outputFormat).
  const signals: DimensionSignal[] = DIMENSIONS.map((dim) => {
    const raw = clamp(dim.scorer(prompt, systemPrompt, tokenEstimate));
    return {
      dimension: dim.dimension,
      raw,
      weight: dim.weight,
      weighted: raw * dim.weight,
    };
  });

  // Weighted sum
  const score = signals.reduce((sum, s) => sum + s.weighted, 0);

  // Base tier from score
  let tier = scoreToTier(score, config);

  // Confidence
  const confidence = computeConfidence(score, config);

  // --- Overrides ---

  // 1) 3+ reasoning keywords in user prompt → force REASONING
  //    (raised from 2 to reduce false positives from conversational text)
  if (checkReasoningOverride(prompt)) {
    tier = TierEnum.REASONING;
  }

  // 2) Git/agentic commands → force at least COMPLEX
  //    These tasks need tool-capable models (Claude Sonnet, Gemini Pro)
  if (checkAgenticOverride(prompt) && tierRank(tier) < tierRank(TierEnum.COMPLEX)) {
    tier = TierEnum.COMPLEX;
  }

  // 3) >100k tokens → force at least COMPLEX
  const tokenOverride = checkTokenOverride(tokenEstimate);
  if (tokenOverride !== null && tierRank(tier) < tierRank(tokenOverride)) {
    tier = tokenOverride;
  }

  // 4) Structured output in system prompt → minimum MEDIUM
  if (checkStructuredOutputOverride(systemPrompt) && tier === TierEnum.SIMPLE) {
    tier = TierEnum.MEDIUM;
  }

  // 5) Ambiguous (low confidence) → default to MEDIUM
  if (confidence < config.ambiguityThreshold && tier === TierEnum.SIMPLE) {
    tier = TierEnum.MEDIUM;
  }

  return { score, tier, confidence, signals };
}

/** Numeric rank for tier comparison. */
function tierRank(tier: Tier): number {
  switch (tier) {
    case TierEnum.SIMPLE: return 0;
    case TierEnum.MEDIUM: return 1;
    case TierEnum.COMPLEX: return 2;
    case TierEnum.REASONING: return 3;
  }
}
