# ClawRouter Reverse Engineering — Full Technical Analysis

## Executive Summary

ClawRouter is a **local proxy server** that sits between OpenClaw and an LLM API. It intercepts every request, classifies its complexity using a **14-dimension weighted scoring system** (runs in <1ms, pure rules — no LLM needed), picks the cheapest model capable of handling it, and proxies the request with fallback/retry logic.

**For our in-house build**, we can strip away all the x402 payment/wallet/blockchain stuff and the BlockRun-specific API. The core routing intelligence is ~500 lines of TypeScript that we can adapt to work with OpenRouter's existing API.

---

## 1. ROUTING LOGIC (src/router/)

### Architecture
```
Request → route() → classifyByRules() → selectModel() → RoutingDecision
```

### 4 Tiers
| Tier | When | Example |
|------|------|---------|
| SIMPLE | Basic Q&A, translations, definitions | "What is the capital of France?" |
| MEDIUM | Moderate coding, general tasks | "Write a function to sort an array" |
| COMPLEX | Architecture, large context, multi-step | "Design a distributed system for..." |
| REASONING | Proofs, chain-of-thought, formal logic | "Prove that P != NP" |

### 14 Scoring Dimensions (rules.ts)

Each dimension returns a score in [-1, 1] with a weight. Weights sum to 1.0:

| Dimension | Weight | What it detects |
|-----------|--------|----------------|
| reasoningMarkers | 0.18 | "prove", "theorem", "step by step", "chain of thought" |
| codePresence | 0.15 | "function", "class", "import", "```", etc. |
| multiStepPatterns | 0.12 | "first...then", "step 1", numbered lists |
| technicalTerms | 0.10 | "algorithm", "kubernetes", "distributed", etc. |
| tokenCount | 0.08 | Short (<50 tokens) = simple, Long (>500) = complex |
| creativeMarkers | 0.05 | "story", "poem", "brainstorm" |
| questionComplexity | 0.05 | Number of question marks (>3 = complex) |
| agenticTask | 0.04 | "edit", "deploy", "fix", "debug", "read file" |
| constraintCount | 0.04 | "at most", "at least", "maximum", "budget" |
| imperativeVerbs | 0.03 | "build", "create", "implement", "design" |
| outputFormat | 0.03 | "json", "yaml", "table", "csv", "markdown" |
| simpleIndicators | 0.02 | "what is", "define", "hello", "yes or no" (NEGATIVE score!) |
| referenceComplexity | 0.02 | "above", "previous", "the docs", "the code" |
| domainSpecificity | 0.02 | "quantum", "fpga", "genomics", "zero-knowledge" |
| negationComplexity | 0.01 | "don't", "avoid", "never", "without" |

### Tier Boundaries (weighted score → tier)
```
score < 0.0  → SIMPLE
0.0 ≤ score < 0.3  → MEDIUM  
0.3 ≤ score < 0.5  → COMPLEX
score ≥ 0.5  → REASONING
```

### Special Overrides
- **2+ reasoning keywords in USER prompt** → force REASONING tier (ignores system prompt "step by step")
- **>100k tokens** → force COMPLEX tier
- **Structured output detected** (json/schema in system prompt) → minimum MEDIUM tier
- **Ambiguous** (confidence < 0.7) → defaults to MEDIUM

### Confidence Calibration
Uses **sigmoid function** on distance from nearest tier boundary:
```
confidence = 1 / (1 + exp(-steepness * distance))
```
Steepness = 12. Below 0.7 confidence = ambiguous.

### Agentic Detection
If agenticScore ≥ 0.5, switches to separate agentic tier configs with models optimized for multi-step autonomous tasks (Claude Sonnet, GPT-5.2, etc.)

### 4 Routing Profiles
Each profile has its own tier→model mapping:

| Profile | Strategy | Tier configs |
|---------|----------|-------------|
| **auto** | Balanced quality/cost | Default tiers |
| **eco** | Cheapest possible | Free/flash models |
| **premium** | Best quality | Opus/Codex/Sonnet |
| **free** | Zero cost only | nvidia/gpt-oss-120b |

### Model Selection per Tier (Auto profile)
```
SIMPLE   → kimi-k2.5 ($0.50/$2.40)
MEDIUM   → grok-code-fast ($0.20/$1.50)  
COMPLEX  → gemini-3-pro ($2/$12)
REASONING → grok-4.1-fast-reasoning ($0.20/$0.50)
```

Each tier has fallback chains (3-7 models deep).

---

## 2. PROXY ARCHITECTURE (src/proxy.ts)

### Flow
```
OpenClaw → localhost:{port}/v1/chat/completions
  → Parse request body
  → If routing profile (auto/eco/premium/free):
    → Classify request via route()
    → Replace model ID with selected model
  → Forward to upstream API (blockrun.ai/api)
  → If model fails → try next in fallback chain (up to 5 attempts)
  → Stream response back to OpenClaw
```

### Key Features
- **SSE Heartbeat**: Sends headers + heartbeat every 2s during x402 payment flow to prevent OpenClaw's 10-15s timeout
- **Fallback Chain**: Up to 5 models tried. Rate-limited models deprioritized for 60s cooldown
- **Context filtering**: Models filtered by context window (must handle estimated tokens + 10% buffer)
- **Degraded response detection**: Catches 200 responses that are actually errors (overloaded placeholders, repetitive loop output)
- **Rate limit tracking**: Models that return 429 get 60s cooldown, pushed to end of fallback chain

### Error Recovery Patterns
```typescript
const PROVIDER_ERROR_PATTERNS = [
  /billing/i, /insufficient.*balance/i, /rate.*limit/i,
  /model.*unavailable/i, /service.*unavailable/i, /overloaded/i,
  /request too large/i, /payload too large/i, ...
];
```
When these patterns match → try next fallback model.

---

## 3. MODEL REGISTRY (src/models.ts)

### Structure
Each model defined as:
```typescript
{
  id: "openai/gpt-5.2",
  name: "GPT-5.2",
  inputPrice: 1.75,      // per 1M tokens
  outputPrice: 14.0,     // per 1M tokens
  contextWindow: 400000,
  maxOutput: 128000,
  reasoning: true,
  vision: true,
  agentic: true,
}
```

### Alias System
~50+ aliases for convenience:
```
"claude" → "claude-sonnet-4"
"gpt5" → "openai/gpt-5.2"
"flash" → "google/gemini-2.5-flash"
"grok" → "xai/grok-3"
```

Also handles provider prefixes: `blockrun/anthropic/claude-sonnet-4` → `claude-sonnet-4`

### Pricing feeds routing
The `ModelPricing` map is passed to `selectModel()` which calculates:
- Estimated cost for selected model
- Baseline cost (what Claude Opus would cost)
- Savings percentage

---

## 4. SMART FEATURES

### Context Compression (src/compression/)
7-layer pipeline, 15-40% token reduction:

1. **Deduplication** — remove exact duplicate messages
2. **Whitespace** — normalize excessive whitespace/newlines
3. **Dictionary** — replace common phrases with short codes (static codebook)
4. **Paths** — shorten repeated file paths (e.g., `/Users/foo/project/src/` → `P1/`)
5. **JSON Compact** — minify JSON in tool calls
6. **Observation** — compress tool results (97% compression on verbose outputs)
7. **Dynamic Codebook** — learns frequent patterns from actual content

Adds a codebook header to first user message so LLM can decode.
Only triggers when messages > 5000 chars (~1000 tokens).

### Request Deduplication (src/dedup.ts)
- Hashes request body (SHA-256, canonicalized JSON, timestamps stripped)
- Caches responses for 30s
- If duplicate in-flight request arrives, waits for first to complete
- Prevents double-charging on OpenClaw retries

### Response Cache (src/response-cache.ts)
- LRU cache, 200 entries max, 10-minute TTL
- Keys: SHA-256 of normalized request (model + messages + params, strip stream/timestamps)
- Skips caching for errors (status >= 400) and large items (>1MB)
- Heap-based expiration tracking

### Session Tracking (src/session.ts)
- Tracks per-session state for routing decisions
- Session ID extracted from request headers

### Rate Limit Handling
- Models hitting 429 → 60s cooldown
- `prioritizeNonRateLimited()` reorders fallback chain

---

## 5. MINIMUM VIABLE IN-HOUSE ROUTER FOR OPENROUTER

### What to Keep (Core ~500 lines)
1. **Classifier** (rules.ts) — 14-dimension scorer, ~200 lines
2. **Config** (config.ts) — tier definitions + keyword lists, ~250 lines
3. **Selector** (selector.ts) — tier→model mapping + fallback chains, ~100 lines
4. **Types** (types.ts) — type definitions, ~100 lines

### What to Adapt
- **Model registry**: Replace BlockRun models with OpenRouter model IDs
  - e.g., `openai/gpt-4o` → `openrouter/openai/gpt-4o`
- **Pricing**: Pull from OpenRouter's `/models` endpoint instead of hardcoded
- **Tier configs**: Map to OpenRouter models:
  ```
  SIMPLE   → cheapest (e.g., gemini-flash, deepseek-chat)
  MEDIUM   → mid-tier (e.g., gpt-4o-mini, claude-haiku)
  COMPLEX  → premium (e.g., gpt-4o, claude-sonnet)
  REASONING → reasoning models (e.g., o3, deepseek-reasoner)
  ```

### What to Strip
- All x402/wallet/payment code
- Balance monitoring
- Payment cache
- BlockRun-specific API endpoints
- USDC/crypto stuff
- Provider registration (OpenRouter handles this)

### Implementation Approach

**Option A: OpenClaw Config-Level Router (Simplest)**
- Use OpenClaw's existing model override system
- Build a pre-request hook that runs the classifier
- Set the model dynamically before OpenClaw sends to OpenRouter
- No proxy needed

**Option B: Local Proxy (Like ClawRouter)**
- Tiny HTTP proxy between OpenClaw and OpenRouter
- Intercept `/v1/chat/completions`, classify, rewrite model field
- Forward to OpenRouter's API
- Add fallback chain on errors

**Option C: OpenClaw Plugin/Skill**
- Package the routing logic as an OpenClaw skill
- Runs inside the agent, picks model before each request
- Cleanest integration

### Recommended: Option A or C
Since OpenClaw already talks to OpenRouter, we just need to:
1. Classify the request (14 dimensions, pure string matching)
2. Pick the right model from OpenRouter's catalog
3. Set it as the model for that request

The core classifier is self-contained, no dependencies, runs in <1ms.

---

## Key Takeaway

The "magic" of ClawRouter is NOT complex. It's:
1. A keyword-matching scoring system (14 dimensions, weighted)
2. Score → tier mapping (4 tiers with configurable boundaries)
3. Tier → cheapest model mapping (with fallback chains)
4. Basic caching/dedup to avoid waste

The x402 payment stuff is 60%+ of the codebase. The actual routing intelligence is small and portable.
