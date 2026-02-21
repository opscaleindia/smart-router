# OpenClaw Smart Router — Architecture & Feature Deep Dive

## Abstract

`@openclaw/smart-router` is an in-house LLM request router that sits between client applications and upstream LLM providers. It integrates with OpenClaw's provider system to discover available models and auth, then routes each request to the cheapest capable model. The router solves three problems: *model selection* (picking the cheapest capable model for each request), *delivery resilience* (ensuring the request succeeds even when individual upstream providers fail), and *token efficiency* (compressing context, pinning sessions, and recording action journals to reduce costs and improve multi-turn coherence). It does all of this with zero external dependencies — only Node.js standard library.

This document explains every feature in the system, the design rationale behind each, and why the specific implementation choices produce correct behavior under real production conditions.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [OpenClaw Integration](#2-openclaw-integration)
3. [Request Classification: The 15-Dimension Scorer](#3-request-classification-the-15-dimension-scorer)
4. [Tier System and Model Selection](#4-tier-system-and-model-selection)
5. [Routing Profiles](#5-routing-profiles)
6. [Fallback Retry with Model Chain](#6-fallback-retry-with-model-chain)
7. [Rate Limit Tracking](#7-rate-limit-tracking)
8. [Degraded Response Detection](#8-degraded-response-detection)
9. [Response Caching](#9-response-caching)
10. [Request Deduplication](#10-request-deduplication)
11. [Timestamp Stripping](#11-timestamp-stripping)
12. [Context Compression](#12-context-compression)
13. [Session Tracking](#13-session-tracking)
14. [Session Journal](#14-session-journal)
15. [Streaming Strategy](#15-streaming-strategy)
16. [Feature Coordination in the Proxy](#16-feature-coordination-in-the-proxy)
17. [Design Principles](#17-design-principles)

---

## 1. System Overview

```
Client (OpenAI SDK, curl, any HTTP client)
  │
  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Smart Router Proxy (localhost:18900)                                │
│                                                                      │
│  ┌────────────────┐                                                  │
│  │ OpenClaw Config │ ← reads auth-profiles.json, auth.json,         │
│  │ Loader          │   models.json at startup                        │
│  └───────┬────────┘                                                  │
│          │                                                           │
│  ┌───────▼────────┐                                                  │
│  │   Provider      │ ← resolves model keys to upstream targets       │
│  │   Registry      │   (hostname, port, path, API key)               │
│  └───────┬────────┘                                                  │
│          │                                                           │
│  ┌────────────┐   ┌────────────┐   ┌───────────┐                   │
│  │  Classifier │──▶│  Selector  │──▶│  Session  │                   │
│  │ (15-dim)    │   │ (profile)  │   │  Check    │                   │
│  └────────────┘   └────────────┘   └─────┬─────┘                   │
│                                           │                         │
│  ┌────────────┐   ┌────────────┐   ┌─────▼─────┐   ┌───────────┐  │
│  │  Journal    │──▶│  Context   │──▶│ Rate Limit│──▶│Dedup Check│  │
│  │  Injection  │   │ Compress   │   │ Reorder   │   │(+ts strip)│  │
│  └────────────┘   └────────────┘   └───────────┘   └─────┬─────┘  │
│                                                           │         │
│                                                    ┌──────▼──────┐  │
│                                                    │ Cache Check │  │
│                                                    │ (+ts strip) │  │
│                                                    └──────┬──────┘  │
│                                                           │         │
│                                                    ┌──────▼──────┐  │
│                                                    │  Fallback   │  │
│                                                    │    Loop     │  │
│                                                    │  (up to 5   │  │
│                                                    │   models)   │  │
│                                                    └──────┬──────┘  │
│                                                           │         │
│                                                    ┌──────▼──────┐  │
│                                                    │  Degraded   │  │
│                                                    │  Detection  │  │
│                                                    └──────┬──────┘  │
│                                                           │         │
│                                                    ┌──────▼──────┐  │
│                                                    │ Cache Store │  │
│                                                    │ Dedup Resolve│ │
│                                                    │ Journal Rec │  │
│                                                    └─────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
  │
  ▼ (Provider Registry resolves each model to its best provider)
  │
  ├──▶ OpenRouter (openrouter.ai)        ← fallback for all models
  ├──▶ OpenAI (api.openai.com)           ← direct if key configured
  ├──▶ Google (googleapis.com)           ← direct if key configured
  ├──▶ xAI (api.x.ai)                   ← direct if key configured
  ├──▶ DeepSeek (api.deepseek.com)       ← direct if key configured
  ├──▶ Anthropic (api.anthropic.com)     ← direct if key configured
  ├──▶ Groq (api.groq.com)              ← direct if key configured
  ├──▶ Mistral (api.mistral.ai)         ← direct if key configured
  ├──▶ Cerebras (api.cerebras.ai)       ← direct if key configured
  └──▶ Custom providers (from models.json)
```

The proxy exposes an OpenAI-compatible API surface (`POST /v1/chat/completions`, `GET /v1/models`, `GET /health`). Any application that speaks the OpenAI chat completions protocol can point at Smart Router and get automatic model selection plus production resilience for free.

---

## 2. OpenClaw Integration

### Why integrate with OpenClaw

Smart-router is designed to route only among models that OpenClaw already has configured. Rather than maintaining a separate list of API keys and provider URLs, smart-router reads OpenClaw's configuration files at startup. This means:

- **Single source of truth** — add a provider key in OpenClaw, smart-router picks it up on next restart
- **No key duplication** — API keys live in OpenClaw's auth system, not scattered in env vars
- **Consistent model catalog** — smart-router routes to the same models OpenClaw uses

### Config loader (`src/openclaw-loader.ts`)

At startup, `loadOpenClawConfig()` reads three files from `~/.openclaw/agents/main/agent/`:

| File | What it provides |
|------|------------------|
| `auth-profiles.json` | Provider API keys (e.g. `{ "openrouter:default": { provider: "openrouter", key: "sk-or-..." } }`) |
| `auth.json` | Fallback auth format (simpler `{ provider: { key: "..." } }` structure) |
| `models.json` | Custom provider definitions (e.g. `{ providers: { smart: { baseUrl: "...", apiKey: "..." } } }`) |

The loader merges these into an `OpenClawConfig`:

```typescript
interface OpenClawConfig {
  providerKeys: Record<string, string>;       // { openrouter: "sk-or-...", openai: "sk-..." }
  customProviders: Record<string, { baseUrl, apiKey?, models? }>;
  configDir: string;
}
```

Auth-profiles takes priority over auth.json (which is only used if a provider has no entry in auth-profiles). Custom providers from models.json can override built-in provider URLs.

### Provider registry (`src/providers.ts`)

The `ProviderRegistry` class resolves OpenClaw model keys to concrete upstream targets. This is the bridge between the router's model IDs and actual HTTP endpoints.

**Model key format:** `provider/upstream-model-id`

- `openrouter/moonshotai/kimi-k2.5` → provider=`openrouter`, model=`moonshotai/kimi-k2.5`
- `openai/gpt-5.2` → provider=`openai`, model=`gpt-5.2`
- `google/gemini-2.5-flash` → provider=`google`, model=`gemini-2.5-flash`

The first path segment is the provider name. Everything after the first `/` is the upstream model ID sent in the request body. This format matches how OpenClaw catalogs its models.

**Resolution logic:**

```
resolve("openrouter/moonshotai/kimi-k2.5", passthroughAuth?)
  → split at first "/" → provider="openrouter", model="moonshotai/kimi-k2.5"
  → lookup base URL: openrouter → "https://openrouter.ai/api/v1"
  → lookup API key: providerKeys["openrouter"] → "sk-or-..."
  → build target: { hostname: "openrouter.ai", path: "/api/v1/chat/completions", ... }
```

**Auth resolution order:**
1. Provider API key from OpenClaw config (auth-profiles.json or auth.json)
2. Passthrough auth from client request's `Authorization` header
3. Null (request sent without auth — will likely fail)

**Direct provider routing:** When a direct provider key is available (e.g. `openai: "sk-..."`), models with that provider prefix route directly to the provider's API instead of through OpenRouter. This reduces latency and cost (no OpenRouter markup). For example, with an OpenAI key configured, `openai/gpt-5.2` routes to `api.openai.com` instead of `openrouter.ai`.

### Built-in providers

| Provider | Base URL | Completions Path |
|----------|----------|-------------------|
| openrouter | `https://openrouter.ai/api/v1` | `/chat/completions` |
| openai | `https://api.openai.com/v1` | `/chat/completions` |
| anthropic | `https://api.anthropic.com/v1` | `/messages` |
| google | `https://generativelanguage.googleapis.com/v1beta/openai` | `/chat/completions` |
| xai | `https://api.x.ai/v1` | `/chat/completions` |
| deepseek | `https://api.deepseek.com/v1` | `/chat/completions` |
| groq | `https://api.groq.com/openai/v1` | `/chat/completions` |
| mistral | `https://api.mistral.ai/v1` | `/chat/completions` |
| cerebras | `https://api.cerebras.ai/v1` | `/chat/completions` |

Custom providers from `models.json` are added to this list at startup.

---

## 3. Request Classification: The 15-Dimension Scorer

### What it does

Every incoming request is scored across 15 independent dimensions to determine its complexity. The composite score maps to one of four tiers (SIMPLE, MEDIUM, COMPLEX, REASONING), and the tier determines which model handles the request.

### The dimensions

| # | Dimension | Weight | What it measures |
|---|-----------|--------|------------------|
| 1 | `reasoningMarkers` | 0.18 | Formal logic keywords: "prove", "theorem", "deduce", "contradiction" |
| 2 | `codePresence` | 0.15 | Programming constructs: `function`, `class`, ` ````, `.map(`, `import` |
| 3 | `multiStepPatterns` | 0.12 | Sequential instructions: "first", "then", "step 1", "followed by" |
| 4 | `technicalTerms` | 0.10 | Infrastructure/CS vocabulary: "kubernetes", "algorithm", "distributed" |
| 5 | `tokenCount` | 0.08 | Raw input length as a complexity proxy |
| 6 | `creativeMarkers` | 0.05 | Creative writing: "story", "poem", "brainstorm", "narrative" |
| 7 | `questionComplexity` | 0.05 | Number of question marks (multi-question = more complex) |
| 8 | `agenticTask` | 0.04 | Tool-use indicators: "deploy", "debug", "git push", "edit file" |
| 9 | `constraintCount` | 0.04 | Explicit constraints: "at most", "maximum", "must", "exactly" |
| 10 | `imperativeVerbs` | 0.03 | Action verbs: "build", "implement", "optimize", "design" |
| 11 | `outputFormat` | 0.03 | Structured output: "JSON", "YAML", "table", "formatted as" |
| 12 | `simpleIndicators` | 0.02 | Simplicity markers: "what is", "hello", "translate" (scores *negative*) |
| 13 | `referenceComplexity` | 0.02 | Context references: "above", "the code", "as shown", "attached" |
| 14 | `domainSpecificity` | 0.02 | Niche domains: "quantum", "CRISPR", "homomorphic", "Riemann" |
| 15 | `negationComplexity` | 0.01 | Negation constraints: "don't", "avoid", "never", "must not" |

### Why it works

**Weighted keyword counting is the right tool for this job.** The classification doesn't need to *understand* the prompt — it needs to estimate how hard the prompt is to answer well. A request mentioning "theorem", "proof", and "contradiction" is almost certainly a formal reasoning task, regardless of the specific mathematical content. The keyword approach runs in sub-millisecond time (no model calls, no embeddings) and has proven robust across thousands of real requests.

**The weights encode domain expertise about what actually drives model capability requirements.** Reasoning markers get the highest weight (0.18) because the quality gap between a $0.10/M-token model and a $10/M-token model is largest on formal reasoning tasks. Simple indicators get low weight (0.02) because their absence doesn't mean much — but their presence strongly signals a cheap model will suffice.

**Each scorer returns values in [-1, 1], not just [0, 1].** Negative scores actively push toward simpler tiers. When `simpleIndicators` detects "what is" or "hello", it returns -0.4 to -1.0, directly counteracting any mild positive signals from other dimensions. This bidirectional scoring prevents the system from over-classifying simple requests that happen to contain a technical term or two.

**Weights sum to ~0.94**, validated at module load to be within [0.5, 1.5]. This keeps the composite score in a predictable range and the tier boundaries have stable, interpretable meanings.

### Confidence calibration

The classifier also produces a confidence score using sigmoid calibration on the distance from the nearest tier boundary:

```
confidence = 1 / (1 + e^(-12 * distance_to_nearest_boundary))
```

The steepness factor of 12 creates a sharp sigmoid: scores clearly in the middle of a tier get confidence ~1.0, while scores near boundaries drop toward 0.5. When confidence falls below the ambiguity threshold (0.7) and the result is SIMPLE, the classifier upgrades to MEDIUM. This is a safety hatch — when the system isn't sure, it errs toward a more capable model. The cost of over-classifying a simple request is a few extra cents; the cost of under-classifying a complex request is a bad answer.

### Override rules

Five override rules run after scoring to catch cases where keyword counting alone isn't sufficient:

1. **Reasoning override** — 3+ reasoning keywords force REASONING tier. A prompt with "prove", "theorem", and "contradiction" is unambiguously a formal reasoning task, even if other dimensions score low.

2. **Agentic override** — Any git command (`git push`, `git rebase`, etc.) forces at least COMPLEX tier. Tool-execution tasks need models with strong instruction-following capabilities, and cheap flash models frequently fumble multi-step tool use.

3. **Token override** — >100k input tokens forces at least COMPLEX. Long-context tasks need models with large context windows and strong attention, which cheap models lack.

4. **Structured output override** — JSON or schema mentioned in the system prompt forces at least MEDIUM. Structured output requires precise formatting compliance that the cheapest models often fail at.

5. **Ambiguity override** — Low-confidence SIMPLE classification upgrades to MEDIUM, as described above.

The override ordering matters: reasoning and agentic overrides can only *raise* the tier, never lower it. Each override checks `tierRank(current) < tierRank(target)` before applying.

---

## 4. Tier System and Model Selection

### The four tiers

| Tier | Score Range | Typical Requests | Model Cost Range |
|------|-------------|-------------------|------------------|
| **SIMPLE** | < 0.0 | "What is the capital of France?", "Hello", factual lookups | $0.00-0.50/M tokens |
| **MEDIUM** | 0.0 to 0.3 | "Write a sorting function", "Explain OAuth", code snippets | $0.15-2.50/M tokens |
| **COMPLEX** | 0.3 to 0.5 | Architecture design, multi-file refactoring, tool-use tasks | $2.00-15.00/M tokens |
| **REASONING** | >= 0.5 | Mathematical proofs, formal derivations, complex multi-step logic | $0.20-75.00/M tokens |

### Why four tiers

Four tiers match the natural clustering of model capabilities in the current LLM market. There's a clear quality/price jump between:
- Flash/free models (GPT-OSS-120B, Gemini 2.5 Flash, Kimi K2.5) — great at simple tasks, poor at formal reasoning
- Mid-tier models (Grok Code Fast, GPT-5.2 Codex, DeepSeek V3) — reliable for moderate code and explanation tasks
- Frontier models (Claude Sonnet 4, Gemini 3 Pro, GPT-5.2) — strong at complex multi-step work
- Reasoning specialists (Grok 4.1 Fast, DeepSeek Reasoner, o3, o4-mini) — purpose-built for formal logic and chain-of-thought

Adding more tiers would increase classification errors without adding meaningful routing discrimination. Fewer tiers would force too many requests onto expensive models.

### Cost estimation

Every routing decision includes a cost estimate computed from the model registry's per-million-token pricing:

```
cost = (inputTokens / 1M) * inputPrice + (outputTokens / 1M) * outputPrice
```

The estimate is compared against a baseline cost (Claude Opus 4 at $15/$75 per million tokens) to compute a savings percentage. In practice, the router achieves 90-99% savings on simple requests and 50-80% on medium requests.

---

## 5. Routing Profiles

Five profiles let callers trade off cost vs. quality:

### auto — balanced quality/cost (default)

| Tier | Primary | Fallbacks |
|------|---------|-----------|
| SIMPLE | Kimi K2.5 | Gemini 2.5 Flash, GPT-OSS-120B, DeepSeek V3 |
| MEDIUM | Grok Code Fast | Gemini 2.5 Flash, DeepSeek V3, Kimi K2.5 |
| COMPLEX | Gemini 3 Pro Preview | Gemini 2.5 Flash, Gemini 2.5 Pro, DeepSeek V3, Grok 4 |
| REASONING | Grok 4.1 Fast | DeepSeek Reasoner, o4-mini, o3 |

### eco — maximum savings

| Tier | Primary | Fallbacks |
|------|---------|-----------|
| SIMPLE | GPT-OSS-120B (free) | Gemini 2.5 Flash, DeepSeek V3 |
| MEDIUM | Gemini 2.5 Flash | DeepSeek V3, GPT-OSS-120B |
| COMPLEX | Gemini 2.5 Flash | DeepSeek V3, Grok 4 |
| REASONING | Grok 4.1 Fast | DeepSeek Reasoner |

### premium — best quality

| Tier | Primary | Fallbacks |
|------|---------|-----------|
| SIMPLE | Kimi K2.5 | Claude Haiku 4.5, Gemini 2.5 Flash, Grok Code Fast |
| MEDIUM | GPT-5.2 Codex | Kimi K2.5, Gemini 2.5 Pro, Grok 4, Claude Sonnet 4 |
| COMPLEX | Claude Opus 4 | GPT-5.2 Codex, Claude Sonnet 4, Gemini 3 Pro, Kimi K2.5 |
| REASONING | Claude Sonnet 4 | Claude Opus 4, o4-mini, o3, Grok 4.1 Fast |

### free — zero cost

All tiers use GPT-OSS-120B (free), with Gemini 2.5 Flash and DeepSeek V3 as fallbacks. The REASONING tier falls back to DeepSeek Reasoner.

### agentic — optimized for tool-use / agent workflows

| Tier | Primary | Fallbacks |
|------|---------|-----------|
| SIMPLE | Kimi K2.5 | Claude Haiku 4.5, Grok Code Fast, GPT-4o Mini |
| MEDIUM | Grok Code Fast | Kimi K2.5, Claude Haiku 4.5, Claude Sonnet 4 |
| COMPLEX | Claude Sonnet 4 | Claude Opus 4, GPT-5.2, Gemini 3 Pro, Grok 4 |
| REASONING | Claude Sonnet 4 | Claude Opus 4, Grok 4.1 Fast, DeepSeek Reasoner |

### Why profiles exist

Different use cases within the same application have different quality/cost requirements. An autocomplete feature needs fast, cheap responses (eco). A user-facing "explain this code" feature needs reliable quality (auto). An internal research tool can afford premium models. An agent with tool-use needs strong instruction-following (agentic). Profiles let one router instance serve all of these.

The free profile exists specifically for development and testing — it routes everything through zero-cost models available on OpenRouter, letting developers iterate without incurring API charges.

The agentic profile is tuned for tool-use workflows where instruction-following precision matters more than raw intelligence. Claude Sonnet 4 handles COMPLEX and REASONING because it excels at structured tool calls, even though cheaper models might handle the cognitive complexity.

The profile is selected via the `X-Smart-Router-Profile` header, or by setting the model name to a profile name (e.g. `"model": "eco"`), defaulting to `auto`.

---

## 6. Fallback Retry with Model Chain

### What it does

When an upstream model returns an error, the proxy automatically retries with the next model in the fallback chain instead of immediately returning the error to the client. The chain is built from the routing decision: `[primary, fallback_1, fallback_2, ...]`, capped at 5 models.

### How it works

The proxy iterates the model chain sequentially. For each model, it resolves the upstream target via `ProviderRegistry.resolve()`, buffers the complete response, and checks the HTTP status code against a retriable set: `{429, 500, 502, 503, 504}`. If the status is retriable and there are more models to try, it moves to the next one. If the status is a non-retriable client error (400, 401, 403, 422), it returns immediately — these errors indicate a problem with the request itself, not the upstream provider, so retrying with a different model won't help.

Each model in the fallback chain may resolve to a *different provider*. For example, if Gemini 2.5 Flash fails via OpenRouter, the next fallback (DeepSeek V3) might route to `api.deepseek.com` directly if a DeepSeek API key is configured. This cross-provider retry dramatically improves aggregate availability.

```
for each model in chain:
    target = providers.resolve(model)
    result = forwardToTarget(target)
    if retriable_error and more_models:
        log and continue
    if success:
        return result to client
    if non_retriable_error:
        return result to client (no point retrying)
return last_result to client
```

### Why it works

LLM API providers have independent failure modes. When OpenAI is rate-limited (429), xAI is usually fine. When Google has a 500, DeepSeek is usually healthy. By trying models across different providers, the system achieves much higher aggregate availability than any single provider offers.

The 5-model cap prevents pathological chains from creating excessive latency. In practice, most requests succeed on the first or second attempt. The cap also bounds the total time a client might wait: at worst, 5 sequential upstream calls.

### Why non-retriable errors short-circuit

A 400 (bad request) or 422 (unprocessable entity) means the request itself is malformed or uses features the model doesn't support. Sending the same malformed request to a different model will produce the same error. A 401/403 means authentication/authorization failed at the gateway level, not the model level, so retrying won't help either.

---

## 7. Rate Limit Tracking

### What it does

The `RateLimiter` class tracks which models have recently returned 429 (Too Many Requests) responses and temporarily deprioritizes them in future fallback chains. This prevents the proxy from wasting time retrying models that are known to be rate-limited.

### How it works

Internally, it maintains a `Map<modelId, { limitedAt, cooldownMs }>`. When a model returns 429, `recordRateLimit(modelId)` stores the current timestamp. Before each request's fallback loop, the model chain is passed through `prioritizeNonRateLimited()`, which performs a stable partition: non-limited models first, limited models at the end.

Crucially, **limited models are not removed** — they're moved to the end of the chain. If all non-limited models fail, the system still tries the rate-limited ones as a last resort. Rate limits are often per-minute or per-second; by the time the system has tried 2-3 other models, the cooldown may have passed.

The default cooldown window is 60 seconds, matching the typical rate-limit reset period used by major providers.

### Why stable partitioning instead of removal

Removing rate-limited models entirely would reduce the fallback chain length, potentially leaving no models to try if multiple providers are simultaneously rate-limited (which happens during usage spikes). Stable partitioning preserves the full chain while front-loading the models most likely to accept the request.

The "stable" part is important too: within the non-limited and limited groups, the original priority order (primary first, then fallbacks) is preserved. This ensures the system still prefers cheaper/better models when multiple non-limited options are available.

### Why per-instance, not persistent

Rate limit state is held in memory, not persisted to disk. This is intentional — rate limits are transient (seconds to minutes), and the state would be stale by the time the process restarts. In-memory tracking also means zero I/O overhead on the hot path.

---

## 8. Degraded Response Detection

### What it does

Some upstream providers return HTTP 200 with an error message in the body instead of a proper error status code. The degraded detector catches these "fake 200s" by scanning the response body for known error patterns, treating them as retriable errors that trigger the next fallback.

### The patterns

| Pattern | What it catches |
|---------|----------------|
| `/billing/i` | "Your billing account has been suspended" |
| `/insufficient[\s._-]*balance/i` | "Insufficient balance for this request" |
| `/rate[\s._-]*limit/i` | Rate limit errors disguised as 200s |
| `/model[\s\S]{0,20}unavailable/i` | "The model is currently unavailable" |
| `/service[\s\S]{0,20}unavailable/i` | "Service temporarily unavailable" |
| `/overloaded/i` | "The server is overloaded" |
| `/request\s+too\s+large/i` | Request size errors returned as 200 |
| `/payload\s+too\s+large/i` | Payload size errors returned as 200 |
| `/(.{20,}?)\1{4,}/s` | Repetitive output loops (content-only) |

### Why these specific patterns

Each pattern corresponds to a real failure mode observed in production across multiple LLM providers:

**Billing/balance patterns** catch providers that return 200 with a billing error instead of 402/403. This happens because some providers' billing checks run after the initial HTTP response has been committed with a 200 status.

**Rate limit/unavailable patterns** catch providers that soft-fail with a 200 containing an error message rather than returning 429/503. This is particularly common with smaller providers on the OpenRouter network.

**Repetitive loop detection** (`(.{20,}?)\1{4,}`) catches a subtle but important failure mode: when a model gets stuck in a generation loop, repeating the same 20+ character block 5 or more times.

### Content extraction for false-positive prevention

The text error patterns are checked against the raw response body (since error messages appear at the top level). However, the repetitive loop pattern uses a two-phase approach:

1. **Extract content from JSON** — parse the response as OpenAI-format JSON and extract `choices[0].message.content`
2. **Check repetition on content only** — run the repetitive loop regex against the extracted content string, not the raw JSON

This prevents false positives from repeated JSON structure (e.g., multiple `choices` with similar formatting). The extracted content must also exceed 250 characters to trigger the check — short responses with legitimate repetition (e.g., "yes yes yes") are not flagged. For non-JSON responses, the raw body is checked as a fallback.

### Why only on non-streaming responses

Degraded detection requires the full response body to scan against patterns. For streaming (SSE) responses, the body arrives incrementally and is piped directly to the client — buffering the entire stream to check for degradation would defeat the purpose of streaming (low time-to-first-token). The tradeoff is accepted: streaming requests sacrifice degraded detection in exchange for low-latency output.

---

## 9. Response Caching

### What it does

The `ResponseCache` stores successful non-streaming responses in an LRU (Least Recently Used) cache with TTL (Time To Live) expiry. Identical requests within the TTL window are served from cache without making an upstream call.

### Key design decisions

**LRU eviction via Map insertion order.** JavaScript's `Map` guarantees iteration in insertion order. The cache exploits this: when a key is accessed via `get()`, the entry is deleted and re-inserted, moving it to the "newest" position. When the cache is full and a new entry arrives, the first key in iteration order (the least recently used) is evicted. This gives O(1) LRU behavior without a separate linked list.

**SHA-256 key normalization.** The cache key is a SHA-256 hash of a normalized request body containing only the fields that affect the response: `model`, `messages`, `temperature`, `tools`, `tool_choice`, and `response_format`. Fields like `stream` (delivery format, not content) and timestamps are stripped. This means a streaming request and a non-streaming request for the same content share a cache key, which is correct — the *content* of the response is the same regardless of delivery format.

**Errors are never cached** (status >= 400). Caching a transient 500 would prevent the system from retrying successfully after the upstream recovers. Caching a 429 would prevent rate-limit cooldown from working.

**Oversized responses are not cached** (body > 1MB). Large responses would consume disproportionate memory and are less likely to have cache hits (large responses tend to be for unique, complex queries).

### Configuration

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `maxEntries` | 200 | Enough to cover repeated queries in a burst without excessive memory. At ~100KB average response size, this is ~20MB of memory. |
| `ttlMs` | 600,000 (10 min) | LLM responses don't change over short periods. 10 minutes covers typical burst patterns (e.g., page refreshes, retry loops) without serving stale data for too long. |
| `maxEntrySize` | 1,048,576 (1MB) | Prevents a single large response from dominating the cache. |

### Why caching works for LLM APIs

LLM APIs are not traditionally considered cacheable because they can produce different outputs for the same input (non-zero temperature). However, caching is still valuable in practice:

1. **Duplicate requests are common.** Frontend retry logic, page refreshes, and multiple tabs often produce identical requests within seconds.
2. **Temperature 0 is deterministic.** Many production applications use temperature 0 for reliability, making responses fully reproducible.
3. **The 10-minute TTL limits staleness.** Even with non-zero temperature, a cached response from 5 minutes ago is usually acceptable — the user experience of instant response outweighs the minor variation in output.

---

## 10. Request Deduplication

### What it does

The `RequestDedup` class coalesces duplicate in-flight requests. When request B arrives while an identical request A is still being processed, B waits for A's result instead of making a second upstream call. Both clients receive the same response.

### How it works

`acquire(key)` returns one of two results:
- `{ status: "new" }` — This is the first request with this key. The caller becomes the "owner" and proceeds to make the upstream call.
- `{ status: "waiting", promise }` — Another request with this key is already in-flight. The caller should `await promise` to receive the coalesced result.

When the owner finishes:
- `resolve(key, result)` delivers the `UpstreamResult` to all waiting promises.
- `reject(key, error)` propagates the error to all waiters.

The dedup key uses the same SHA-256 normalization as the cache — same fields, same hash function. This is intentional: if two requests would hit the same cache key, they should also coalesce.

### Why 30-second TTL with pruning

Stale dedup entries (where the owner crashed or timed out without resolving) must be cleaned up. The `prune()` method runs on each `acquire()` call and removes entries older than 30 seconds, rejecting their waiters with an "expired" error. This is more conservative than the cache TTL because dedup entries represent active work — 30 seconds is generous for an LLM API call that should complete in 5-15 seconds.

### Why dedup is separate from caching

Dedup and caching solve different problems:
- **Caching** handles sequential duplicate requests (A finishes, B arrives and gets cached result).
- **Dedup** handles concurrent duplicate requests (A and B arrive simultaneously, only one upstream call is made).

Without dedup, two identical requests arriving 100ms apart would both miss the cache (since A hasn't finished yet) and both hit the upstream. With dedup, B waits for A and both get the same result from a single upstream call.

### Why only for non-streaming requests

Like degraded detection, dedup requires buffering the complete response to distribute it to multiple waiters. Streaming responses can't be meaningfully coalesced — each SSE event would need to be broadcast to multiple response streams, which adds complexity far beyond the benefit.

---

## 11. Timestamp Stripping

### What it does

OpenClaw injects timestamps into message content in the format `[SUN 2026-02-07 13:30 PST]` at the beginning of user messages. When a request is retried (e.g., due to a network timeout on the client side), the retry has a different timestamp but identical content. Without timestamp stripping, the cache and dedup systems treat these as different requests, wasting the cache hit and creating redundant upstream calls.

### How it works

Both `ResponseCache.computeKey()` and `RequestDedup.computeKey()` pass the normalized request body through `stripTimestamps()` before hashing. This function recursively walks the object structure and applies a regex to any `content` string field:

```
TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/
```

The pattern only matches at the start of a string (`^`), so timestamps embedded mid-content are not affected. The stripping is applied only during key computation — the actual message content sent upstream is never modified.

### Why recursive object walking

The `messages` field is an array of objects, each with a `content` field. The `stripTimestamps` function recurses into arrays and objects, but only applies the regex replacement when it encounters a key named `content` with a string value. This ensures timestamps are stripped from all message positions (system, user, assistant) without affecting other fields like `model` or `temperature`.

---

## 12. Context Compression

### What it does

The 7-layer compression pipeline (`src/compression/`) reduces token usage by 15-40% on large conversations while preserving semantic meaning. It runs automatically on messages exceeding 5000 characters (~1000 tokens) before the request is forwarded upstream.

### The 7 layers

| Layer | Name | Default | What it does | Expected savings |
|-------|------|---------|--------------|------------------|
| 1 | Deduplication | **On** | MD5-hashes assistant messages and removes exact duplicates. Never deduplicates system, user, or tool messages. Preserves tool_use/tool_result pairing. | 2-5% |
| 2 | Whitespace | **On** | Max 2 consecutive newlines, trim trailing spaces, normalize tabs to 2 spaces, reduce excessive indentation (>8 spaces). | 3-8% |
| 3 | Dictionary | Off | Replaces 84 common phrases (XML tags, JSON schema patterns, role markers) with short `$XX` codes using a static codebook. Longest-first matching prevents partial replacements. | 4-8% |
| 4 | Paths | Off | Detects filesystem path prefixes appearing 3+ times and shortens them to `$P1/`, `$P2/` codes. Max 5 path codes. | 1-3% |
| 5 | JSON Compact | **On** | Parses and re-stringifies JSON in tool_call arguments and tool message content, removing pretty-print whitespace. | 2-4% |
| 6 | Observation | Off | Compresses tool results >500 chars down to ~300 chars by extracting errors, status lines, key JSON fields, and first/last lines. | Up to 97% on individual tool results |
| 7 | Dynamic Codebook | Off | Learns repeated phrases (≥20 chars, 3+ occurrences) from the actual content and replaces them with `$D01`-style codes. | Variable |

### Why conservative defaults

Layers 1, 2, and 5 are enabled by default because they are *semantically transparent* — the LLM receives equivalent information. Layers 3, 4, 6, and 7 are disabled because they require the LLM to understand codebook substitutions or accept lossy compression of tool results. They can be enabled for specific use cases where token savings outweigh the slight reduction in context fidelity.

### Codebook header placement

When dictionary or path encoding is active with `includeCodebookHeader: true`, the codebook legend is prepended to the first **user** message, not the system message. This is a deliberate compatibility choice — Google Gemini's `systemInstruction` field doesn't support codebook format, but user messages work across all providers.

### Multimodal safety

Every layer guards `typeof msg.content === "string"` before processing. Messages with array content (multimodal images, etc.) pass through all layers untouched. This prevents corruption of image URLs or structured content parts.

### Integration point

Compression runs in `handleChatCompletions()` after journal injection and before dedup/cache checks. This means compressed content is what gets cached and deduped — subsequent identical requests benefit from both compression and caching without re-running the compression pipeline.

---

## 13. Session Tracking

### What it does

The `SessionStore` (`src/session.ts`) pins a model to a session ID, preventing the router from switching models mid-task. Without session tracking, each request in a multi-turn conversation could route to a different model based on the latest message's classification — causing inconsistent behavior, context loss (different models have different context windows), and jarring quality shifts.

### How it works

1. Client sends `X-Session-ID` header with each request (typically an agent session identifier).
2. First request with a new session ID: route normally, then pin the selected model to the session.
3. Subsequent requests with the same session ID: skip `route()` and use the pinned model directly.
4. Sessions expire after 30 minutes of inactivity (configurable via `timeoutMs`).

### Session lifecycle

```
Request arrives with X-Session-ID: "abc123"
  → SessionStore.getSession("abc123")
  → Found? Use pinned model, touchSession() to extend timeout
  → Not found? route() normally, setSession("abc123", model, tier)
```

### Why timeout-based expiry

Agent sessions typically run for minutes to hours, then go idle. A 30-minute timeout covers most active sessions while automatically cleaning up abandoned ones. The `touchSession()` call on each request resets the timeout, so an active session never expires regardless of total duration.

### Auto-cleanup

A background interval runs every 5 minutes (only when session tracking is enabled) to remove expired sessions from memory. This prevents memory leaks from accumulated stale sessions.

### Model updates

If a session's pinned model fails and a fallback model succeeds, `setSession()` can be called again to update the pinned model. The session retains its original creation time and increments its request counter.

---

## 14. Session Journal

### What it does

The `SessionJournal` (`src/journal.ts`) maintains a compact record of key actions per session, enabling agents to recall earlier work even when conversation history is truncated. It extracts events from LLM responses ("I created X", "I fixed Y") and injects them when the user asks about past work.

### Event extraction

Six regex patterns scan assistant response content for action statements:

| Pattern | Matches |
|---------|---------|
| Creation | "I created/implemented/added/wrote/built..." |
| Fix | "I fixed/resolved/solved/patched..." |
| Completion | "I completed/finished/wrapped up..." |
| Update | "I updated/modified/changed/refactored..." |
| Success | "Successfully deployed/configured/..." |
| Tool usage | "I ran/executed/called/invoked..." |

Each pattern allows optional filler words ("also", "then", "have") between "I" and the verb. Extracted actions must be 15-200 characters. Duplicates are removed via case-insensitive dedup. At most 5 events are extracted per response.

### Context injection

When a user message contains trigger phrases ("what did you do", "earlier", "summarize", "your progress", etc.), the journal is formatted and injected into the system message:

```
[Session Memory - Key Actions]
- 02:15 PM: I created the login component and auth flow
- 02:23 PM: I fixed the session timeout bug
- 02:30 PM: I updated the database schema for user roles
```

### Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max entries per session | 100 | Prevents unbounded memory growth for long sessions |
| Max age | 24 hours | Stale entries from yesterday's session are not useful |
| Max events per response | 5 | Prevents verbose responses from flooding the journal |

### Why not full conversation history

Full conversation history can be megabytes of data across a long session. The journal distills this to ~100 one-line summaries of *what was accomplished*, which is exactly what users ask about. This compact representation fits in a few hundred tokens of system message injection.

---

## 15. Streaming Strategy

Streaming (SSE) requests follow a fundamentally different path than non-streaming requests because SSE commits the HTTP response the moment the first byte is piped to the client. The proxy handles this with a two-phase approach:

### First attempt: check status before piping

On the first model in the chain, the proxy inspects the upstream response status *before* writing anything to the client:
- **2xx:** Pipe the SSE stream directly. The client gets real-time token delivery. The proxy is now committed — no more fallback is possible for this request.
- **Error status:** Buffer the error response. Don't write to client. Move to next model.

### Fallback attempts: always buffer

For second and subsequent models in the chain, the proxy always buffers responses. This loses the streaming benefit but gains reliability — the proxy can inspect the full response before committing.

The client receives the response as a single buffered payload rather than an SSE stream. This is an acceptable degradation: the user gets a correct response from a working model rather than an error from the primary model.

### What's skipped for streaming

- **Degraded detection** — Can't scan a body that's being piped in real-time.
- **Response caching** — Can't cache a stream that was piped through.
- **Request dedup** — Can't coalesce streams.

All three features silently deactivate for streaming requests without needing explicit checks — the proxy simply takes the streaming code path before reaching the dedup/cache/degraded detection logic.

---

## 16. Feature Coordination in the Proxy

### The `ProxyContext`

All features are instantiated once per `createProxyServer()` call and bundled into a `ProxyContext`:

```typescript
interface ProxyContext {
  features: ProxyFeatureFlags;
  rateLimiter: RateLimiter;
  cache: ResponseCache;
  dedup: RequestDedup;
  providers: ProviderRegistry;
  sessionStore: SessionStore;
  journal: SessionJournal;
  compressionConfig: CompressionConfig;
}
```

This design avoids module-level singletons, making testing clean: each test can create its own proxy with independent feature state. It also means multiple proxy instances in the same process (e.g., different ports with different configurations) don't share state.

The `ProviderRegistry` is part of the context because it holds the loaded OpenClaw config and provider keys — these are per-proxy-instance, not global. Similarly, `SessionStore` and `SessionJournal` hold per-instance state with independent cleanup timers.

### Feature flags

Every feature can be independently toggled via `ProxyFeatureFlags`:

```typescript
interface ProxyFeatureFlags {
  fallbackRetry: boolean;       // default: true
  rateLimitTracking: boolean;   // default: true
  degradedDetection: boolean;   // default: true
  requestDedup: boolean;        // default: true
  responseCache: boolean;       // default: true
  contextCompression: boolean;  // default: true
  sessionTracking: boolean;     // default: false
  sessionJournal: boolean;      // default: false
}
```

The original 5 resilience features default to `true`. Context compression also defaults to `true` (with conservative layer defaults). Session tracking and session journal default to `false` because they require clients to send `X-Session-ID` headers — enabling them without header support is a no-op but wastes memory on cleanup timers.

This lets operators disable specific features during debugging or performance testing without touching code. For example, `{ responseCache: false }` disables caching while keeping all other features active.

### Request lifecycle (non-streaming)

The full processing pipeline for a non-streaming request:

```
 1. Parse request body
 2. Extract user message + system prompt
 3. Classify via 15-dimension scorer → ScoringResult
 4. Apply overrides → final Tier
 5. (A) Session check:
    - X-Session-ID present + session exists → use pinned model, skip route()
    - X-Session-ID present + no session → route(), pin result to session
    - No session ID → route() normally
 6. Select model via profile → RoutingDecision (primary + fallbacks)
 7. (B) Journal injection:
    - Session journal enabled + user asks about past work → inject journal into system message
 8. (C) Context compression:
    - Messages > 5000 chars → run 7-layer compression pipeline, replace messages
 9. Build model chain [primary, ...fallbacks], cap at 5
10. Rate limit reorder: stable-partition non-limited models first
11. Dedup acquire (key computed with timestamp stripping):
    - "waiting" → await coalesced result → return to client
    - "new" → proceed (we're the owner)
12. Cache check (key computed with timestamp stripping):
    - hit → resolve dedup + return cached result
    - miss → proceed
13. Fallback loop (for each model):
    a. Resolve model to upstream target via ProviderRegistry
    b. Forward to target (buffer entire response)
    c. If 429 → record rate limit
    d. If retriable status → log, continue to next model
    e. If 200 → run degraded detection:
       - degraded → log, continue to next model
       - clean → cache result, resolve dedup, return to client
    f. (D) Journal recording: extract events from assistant response, record to journal
    g. If non-retriable error (400, 401, etc.) → break loop
14. Exhausted → resolve/reject dedup with last result, return to client
```

### Response headers

Every response includes routing metadata:

| Header | Value |
|--------|-------|
| `x-smart-router-model` | The model that actually served the request (OpenClaw key format) |
| `x-smart-router-tier` | The classified tier (SIMPLE, MEDIUM, COMPLEX, REASONING) |
| `x-smart-router-provider` | The provider that handled the request (e.g. "openrouter", "openai") |
| `x-smart-router-attempts` | Number of upstream attempts made |
| `x-smart-router-cache` | `"hit"` if served from cache |
| `x-smart-router-dedup` | `"coalesced"` if served via dedup |

These headers are invaluable for debugging, monitoring, and understanding routing behavior in production.

---

## 17. Design Principles

### Zero dependencies

The entire system uses only Node.js standard library (`node:http`, `node:https`, `node:crypto`, `node:fs`, `node:path`, `node:os`, `node:assert`). No Express, no Axios, no Redis, no external caching library. This eliminates supply-chain risk, reduces binary size, simplifies deployment, and means the only thing that can break is Node.js itself.

### OpenClaw-native

Smart-router is designed as a component of the OpenClaw ecosystem, not a standalone product. It reads provider auth from OpenClaw's config files, uses OpenClaw's model key format (`provider/model-id`), and registers itself as an OpenClaw provider so agents can use it transparently. This tight integration eliminates configuration drift between the router and the broader system.

### Sub-millisecond classification

The classifier runs in <1ms for any prompt length. This is essential because the classification runs *in the request path* — every millisecond of latency here adds to the end-to-end response time. Keyword counting against in-memory arrays is orders of magnitude faster than embedding-based classification or calling another model.

### Multi-provider resilience

Each model in the fallback chain can resolve to a different upstream provider. A single request might try OpenRouter, then fall back to a direct OpenAI call, then to Google's API. This cross-provider retry is fundamentally more resilient than retrying within a single provider, because provider outages are typically independent.

### Graceful degradation everywhere

Every feature is designed to degrade gracefully rather than fail hard:
- Rate-limited models move to the end of the chain (not removed)
- Degraded 200s trigger fallback (not client error)
- Cache misses are silent (proceed to upstream)
- Dedup expiry returns an error to waiters (doesn't hang forever)
- All features can be independently disabled via flags
- The last model in the chain always gets its response returned to the client, even if degraded — a degraded response is better than no response
- If OpenClaw config can't be read, the loader silently returns empty config (the system still works with passthrough auth)

### Stateless across restarts

All in-memory state (rate limit tracking, cache entries, dedup slots) is ephemeral. A process restart produces a clean slate. This is correct because:
- Rate limits are transient (seconds to minutes)
- Cache entries have short TTL (10 minutes)
- Dedup slots represent in-flight requests that won't survive a restart anyway

Persistent state would add disk I/O, serialization complexity, and stale-data bugs for zero practical benefit at the scale this system operates at.

### OpenAI compatibility

The proxy speaks the exact OpenAI chat completions protocol. This means any application using the OpenAI SDK, LangChain, or any other OpenAI-compatible client can use Smart Router by simply changing the base URL to `http://localhost:18900`. No client-side code changes beyond the URL.

---

## Appendix: Model Registry

The system includes 19 models across 7 providers, all using OpenClaw key format:

| Provider | Models | Tier Coverage |
|----------|--------|---------------|
| Moonshot (via OpenRouter) | Kimi K2.5 | SIMPLE primary (auto, premium, agentic) |
| xAI (via OpenRouter) | Grok Code Fast, Grok 4.1 Fast, Grok 4 | MEDIUM primary (auto, agentic), REASONING primary (auto, eco) |
| Google (via OpenRouter) | Gemini 3 Pro Preview, Gemini 2.5 Pro, Gemini 2.5 Flash | COMPLEX primary (auto), widespread fallback |
| OpenAI (via OpenRouter) | GPT-5.2, GPT-5.2 Codex, GPT-4o, GPT-4o Mini, o3, o4-mini | MEDIUM primary (premium), REASONING fallback |
| Anthropic (via OpenRouter) | Claude Haiku 4.5, Claude Sonnet 4, Claude Opus 4 | COMPLEX primary (premium), REASONING primary (premium, agentic), baseline |
| DeepSeek (via OpenRouter) | DeepSeek V3 Chat, DeepSeek Reasoner | Widespread fallback, REASONING fallback |
| NVIDIA/Free (via OpenRouter) | GPT-OSS-120B (free) | SIMPLE primary (eco, free), all tiers (free profile) |

**Baseline model:** Claude Opus 4 ($15/$75 per M tokens) — used as the reference point for savings percentage calculations.

All models are verified to be available on OpenRouter, ensuring consistent routing even when direct provider keys are not configured. When a direct provider key is available, the corresponding models route directly to that provider's API for lower latency and cost.
