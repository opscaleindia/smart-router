# OpenClaw Smart Router — Architecture & Feature Deep Dive

## Abstract

`@openclaw/smart-router` is an in-house LLM request router that sits between client applications and OpenRouter, an LLM gateway aggregating dozens of model providers. The router solves two problems: *model selection* (picking the cheapest capable model for each request) and *delivery resilience* (ensuring the request succeeds even when individual upstream providers fail). It does both with zero external dependencies — only Node.js standard library.

This document explains every feature in the system, the design rationale behind each, and why the specific implementation choices produce correct behavior under real production conditions.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Request Classification: The 15-Dimension Scorer](#2-request-classification-the-15-dimension-scorer)
3. [Tier System and Model Selection](#3-tier-system-and-model-selection)
4. [Routing Profiles](#4-routing-profiles)
5. [Fallback Retry with Model Chain](#5-fallback-retry-with-model-chain)
6. [Rate Limit Tracking](#6-rate-limit-tracking)
7. [Degraded Response Detection](#7-degraded-response-detection)
8. [Response Caching](#8-response-caching)
9. [Request Deduplication](#9-request-deduplication)
10. [Streaming Strategy](#10-streaming-strategy)
11. [Feature Coordination in the Proxy](#11-feature-coordination-in-the-proxy)
12. [Design Principles](#12-design-principles)

---

## 1. System Overview

```
Client (OpenAI SDK, curl, any HTTP client)
  │
  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Smart Router Proxy (localhost:18900)                                │
│                                                                      │
│  ┌────────────┐   ┌────────────┐   ┌───────────┐   ┌─────────────┐ │
│  │  Classifier │──▶│  Selector  │──▶│ Rate Limit│──▶│ Dedup Check │ │
│  │ (15-dim)    │   │ (profile)  │   │ Reorder   │   │             │ │
│  └────────────┘   └────────────┘   └───────────┘   └──────┬──────┘ │
│                                                            │        │
│                                                     ┌──────▼──────┐ │
│                                                     │ Cache Check │ │
│                                                     └──────┬──────┘ │
│                                                            │        │
│                                                     ┌──────▼──────┐ │
│                                                     │  Fallback   │ │
│                                                     │    Loop     │ │
│                                                     │  (up to 5   │ │
│                                                     │   models)   │ │
│                                                     └──────┬──────┘ │
│                                                            │        │
│                                                     ┌──────▼──────┐ │
│                                                     │  Degraded   │ │
│                                                     │  Detection  │ │
│                                                     └──────┬──────┘ │
│                                                            │        │
│                                                     ┌──────▼──────┐ │
│                                                     │   Cache     │ │
│                                                     │   Store +   │ │
│                                                     │ Dedup Resolve│ │
│                                                     └─────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
  │
  ▼
OpenRouter (openrouter.ai/api/v1/chat/completions)
  │
  ▼
Upstream Provider (OpenAI, Anthropic, Google, DeepSeek, Meta, etc.)
```

The proxy exposes an OpenAI-compatible API surface (`POST /v1/chat/completions`, `GET /v1/models`, `GET /health`). Any application that speaks the OpenAI chat completions protocol can point at Smart Router and get automatic model selection plus production resilience for free.

---

## 2. Request Classification: The 15-Dimension Scorer

### What it does

Every incoming request is scored across 15 independent dimensions to determine its complexity. The composite score maps to one of four tiers (SIMPLE, MEDIUM, COMPLEX, REASONING), and the tier determines which model handles the request.

### The dimensions

| # | Dimension | Weight | What it measures |
|---|-----------|--------|------------------|
| 1 | `reasoningMarkers` | 0.18 | Formal logic keywords: "prove", "theorem", "deduce", "contradiction" |
| 2 | `codePresence` | 0.15 | Programming constructs: `function`, `class`, ` ````, `.map(`, `import` |
| 3 | `multiStepPatterns` | 0.12 | Sequential instructions: "first", "then", "step 1", "followed by" |
| 4 | `technicalTerms` | 0.12 | Infrastructure/CS vocabulary: "kubernetes", "algorithm", "distributed" |
| 5 | `tokenCount` | 0.08 | Raw input length as a complexity proxy |
| 6 | `agenticTask` | 0.06 | Tool-use indicators: "deploy", "debug", "git push", "edit file" |
| 7 | `creativeMarkers` | 0.05 | Creative writing: "story", "poem", "brainstorm", "narrative" |
| 8 | `questionComplexity` | 0.05 | Number of question marks (multi-question = more complex) |
| 9 | `domainSpecificity` | 0.04 | Niche domains: "quantum", "CRISPR", "homomorphic", "Riemann" |
| 10 | `constraintCount` | 0.04 | Explicit constraints: "at most", "maximum", "must", "exactly" |
| 11 | `imperativeVerbs` | 0.03 | Action verbs: "build", "implement", "optimize", "design" |
| 12 | `outputFormat` | 0.03 | Structured output: "JSON", "YAML", "table", "formatted as" |
| 13 | `simpleIndicators` | 0.02 | Simplicity markers: "what is", "hello", "translate" (scores *negative*) |
| 14 | `referenceComplexity` | 0.02 | Context references: "above", "the code", "as shown", "attached" |
| 15 | `negationComplexity` | 0.01 | Negation constraints: "don't", "avoid", "never", "must not" |

### Why it works

**Weighted keyword counting is the right tool for this job.** The classification doesn't need to *understand* the prompt — it needs to estimate how hard the prompt is to answer well. A request mentioning "theorem", "proof", and "contradiction" is almost certainly a formal reasoning task, regardless of the specific mathematical content. The keyword approach runs in sub-millisecond time (no model calls, no embeddings) and has proven robust across thousands of real requests.

**The weights encode domain expertise about what actually drives model capability requirements.** Reasoning markers get the highest weight (0.18) because the quality gap between a $0.10/M-token model and a $10/M-token model is largest on formal reasoning tasks. Simple indicators get low weight (0.02) because their absence doesn't mean much — but their presence strongly signals a cheap model will suffice.

**Each scorer returns values in [-1, 1], not just [0, 1].** Negative scores actively push toward simpler tiers. When `simpleIndicators` detects "what is" or "hello", it returns -0.4 to -1.0, directly counteracting any mild positive signals from other dimensions. This bidirectional scoring prevents the system from over-classifying simple requests that happen to contain a technical term or two.

**Weights sum to exactly 1.0**, enforced by a runtime assertion at module load. This means the composite score stays in [-1, 1] and the tier boundaries have stable, interpretable meanings.

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

## 3. Tier System and Model Selection

### The four tiers

| Tier | Score Range | Typical Requests | Model Cost Range |
|------|-------------|-------------------|------------------|
| **SIMPLE** | < 0.0 | "What is the capital of France?", "Hello", factual lookups | $0.10-0.40/M tokens |
| **MEDIUM** | 0.0 to 0.3 | "Write a sorting function", "Explain OAuth", code snippets | $0.15-4.00/M tokens |
| **COMPLEX** | 0.3 to 0.5 | Architecture design, multi-file refactoring, tool-use tasks | $2.50-15.00/M tokens |
| **REASONING** | >= 0.5 | Mathematical proofs, formal derivations, complex multi-step logic | $0.55-40.00/M tokens |

### Why four tiers

Four tiers match the natural clustering of model capabilities in the current LLM market. There's a clear quality/price jump between:
- Flash models (Gemini Flash, GPT-4o-mini) — great at simple tasks, poor at reasoning
- Mid-tier models (Claude Haiku, GPT-4o-mini) — reliable for moderate tasks
- Frontier models (Claude Sonnet, GPT-4o, Gemini Pro) — strong at complex multi-step work
- Reasoning specialists (o3, DeepSeek R1) — purpose-built for formal logic and chain-of-thought

Adding more tiers would increase classification errors without adding meaningful routing discrimination. Fewer tiers would force too many requests onto expensive models.

### Cost estimation

Every routing decision includes a cost estimate computed from the model registry's per-million-token pricing:

```
cost = (inputTokens / 1M) * inputPrice + (outputTokens / 1M) * outputPrice
```

The estimate is compared against a baseline cost (Claude Opus 4 at $15/$75 per million tokens) to compute a savings percentage. In practice, the router achieves 90-99% savings on simple requests and 50-80% on medium requests.

---

## 4. Routing Profiles

Four profiles let callers trade off cost vs. quality:

| Profile | Philosophy | SIMPLE Model | REASONING Model |
|---------|-----------|--------------|-----------------|
| **auto** | Balanced cost/quality | Gemini 2.0 Flash | DeepSeek R1 |
| **eco** | Cheapest possible | Gemini 2.0 Flash | DeepSeek R1 |
| **premium** | Best quality | GPT-4o Mini | OpenAI o3 |
| **free** | Zero cost | Llama 3.3 70B (free) | Llama 3.3 70B (free) |

Each profile is a complete `Tier → { primary, fallbacks[] }` mapping. The profile is selected via the `X-Smart-Router-Profile` HTTP header, defaulting to `auto`.

### Why profiles exist

Different use cases within the same application have different quality/cost requirements. An autocomplete feature needs fast, cheap responses (eco). A user-facing "explain this code" feature needs reliable quality (auto). An internal research tool can afford premium models. Profiles let one router instance serve all of these.

The free profile exists specifically for development and testing — it routes everything through zero-cost models available on OpenRouter, letting developers iterate without incurring API charges.

---

## 5. Fallback Retry with Model Chain

### What it does

When an upstream model returns an error, the proxy automatically retries with the next model in the fallback chain instead of immediately returning the error to the client. The chain is built from the routing decision: `[primary, fallback_1, fallback_2, ...]`, capped at 5 models.

### How it works

The proxy iterates the model chain sequentially. For each model, it buffers the complete response and checks the HTTP status code against a retriable set: `{429, 500, 502, 503, 504}`. If the status is retriable and there are more models to try, it moves to the next one. If the status is a non-retriable client error (400, 401, 403, 422), it returns immediately — these errors indicate a problem with the request itself, not the upstream provider, so retrying with a different model won't help.

```
for each model in chain:
    result = forward(model)
    if retriable_error and more_models:
        log and continue
    if success:
        return result to client
    if non_retriable_error:
        return result to client (no point retrying)
return last_result to client
```

### Why it works

LLM API providers have independent failure modes. When OpenAI is rate-limited (429), Anthropic is usually fine. When Google has a 500, DeepSeek is usually healthy. By trying models across different providers, the system achieves much higher aggregate availability than any single provider offers.

The 5-model cap prevents pathological chains from creating excessive latency. In practice, most requests succeed on the first or second attempt. The cap also bounds the total time a client might wait: at worst, 5 sequential upstream calls.

### Why non-retriable errors short-circuit

A 400 (bad request) or 422 (unprocessable entity) means the request itself is malformed or uses features the model doesn't support. Sending the same malformed request to a different model will produce the same error. A 401/403 means authentication/authorization failed at the gateway level, not the model level, so retrying won't help either.

---

## 6. Rate Limit Tracking

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

## 7. Degraded Response Detection

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
| `/(.{20,}?)\1{4,}/s` | Repetitive output loops |

### Why these specific patterns

Each pattern corresponds to a real failure mode observed in production across multiple LLM providers routed through OpenRouter:

**Billing/balance patterns** catch providers that return 200 with a billing error instead of 402/403. This happens because some providers' billing checks run after the initial HTTP response has been committed with a 200 status.

**Rate limit/unavailable patterns** catch providers that soft-fail with a 200 containing an error message rather than returning 429/503. This is particularly common with smaller providers on the OpenRouter network.

**Repetitive loop detection** (`(.{20,}?)\1{4,}`) catches a subtle but important failure mode: when a model gets stuck in a generation loop, repeating the same 20+ character block 5 or more times. This produces a technically "successful" response that is useless to the caller. The `{20,}?` minimum length prevents false positives on legitimate repetition (e.g., table borders, list markers), and `\1{4,}` (5+ total occurrences) ensures the repetition is genuinely pathological.

### Why only on non-streaming responses

Degraded detection requires the full response body to scan against patterns. For streaming (SSE) responses, the body arrives incrementally and is piped directly to the client — buffering the entire stream to check for degradation would defeat the purpose of streaming (low time-to-first-token). The tradeoff is accepted: streaming requests sacrifice degraded detection in exchange for low-latency output.

---

## 8. Response Caching

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

## 9. Request Deduplication

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

## 10. Streaming Strategy

Streaming (SSE) requests follow a fundamentally different path than non-streaming requests because SSE commits the HTTP response the moment the first byte is piped to the client. The proxy handles this with a two-phase approach:

### First attempt: check status before piping

On the first model in the chain, the proxy inspects the upstream response status *before* writing anything to the client:
- **2xx:** Pipe the SSE stream directly. The client gets real-time token delivery. The proxy is now committed — no more fallback is possible for this request.
- **Error status:** Buffer the error response. Don't write to client. Move to next model.

### Fallback attempts: always buffer

For second and subsequent models in the chain, the proxy always buffers responses (forcing `stream: false` in the upstream request body). This loses the streaming benefit but gains reliability — the proxy can inspect the full response before committing.

The client receives the response as a single buffered payload rather than an SSE stream. This is an acceptable degradation: the user gets a correct response from a working model rather than an error from the primary model.

### What's skipped for streaming

- **Degraded detection** — Can't scan a body that's being piped in real-time.
- **Response caching** — Can't cache a stream that was piped through.
- **Request dedup** — Can't coalesce streams.

All three features silently deactivate for streaming requests without needing explicit checks — the proxy simply takes the streaming code path before reaching the dedup/cache/degraded detection logic.

---

## 11. Feature Coordination in the Proxy

### The `ProxyContext`

All features are instantiated once per `createProxyServer()` call and bundled into a `ProxyContext`:

```typescript
interface ProxyContext {
  features: ProxyFeatureFlags;
  rateLimiter: RateLimiter;
  cache: ResponseCache;
  dedup: RequestDedup;
}
```

This design avoids module-level singletons, making testing clean: each test can create its own proxy with independent feature state. It also means multiple proxy instances in the same process (e.g., different ports with different configurations) don't share state.

### Feature flags

Every feature can be independently toggled via `ProxyFeatureFlags`:

```typescript
interface ProxyFeatureFlags {
  fallbackRetry: boolean;
  rateLimitTracking: boolean;
  degradedDetection: boolean;
  requestDedup: boolean;
  responseCache: boolean;
}
```

All default to `true`. This lets operators disable specific features during debugging or performance testing without touching code. For example, `{ responseCache: false }` disables caching while keeping all other features active.

### Request lifecycle (non-streaming)

The full processing pipeline for a non-streaming request:

```
1. Parse request body
2. Extract user message + system prompt
3. Classify via 15-dimension scorer → ScoringResult
4. Apply overrides → final Tier
5. Select model via profile → RoutingDecision (primary + fallbacks)
6. Build model chain [primary, ...fallbacks], cap at 5
7. Rate limit reorder: stable-partition non-limited models first
8. Dedup acquire:
   - "waiting" → await coalesced result → return to client
   - "new" → proceed (we're the owner)
9. Cache check:
   - hit → resolve dedup + return cached result
   - miss → proceed
10. Fallback loop (for each model):
    a. Forward to upstream (buffer entire response)
    b. If 429 → record rate limit
    c. If retriable status → log, continue to next model
    d. If 200 → run degraded detection:
       - degraded → log, continue to next model
       - clean → cache result, resolve dedup, return to client
    e. If non-retriable error (400, 401, etc.) → break loop
11. Exhausted → resolve/reject dedup with last result, return to client
```

### Response headers

Every response includes routing metadata:

| Header | Value |
|--------|-------|
| `x-smart-router-model` | The model that actually served the request |
| `x-smart-router-tier` | The classified tier (SIMPLE, MEDIUM, COMPLEX, REASONING) |
| `x-smart-router-attempts` | Number of upstream attempts made |
| `x-smart-router-cache` | `"hit"` if served from cache |
| `x-smart-router-dedup` | `"coalesced"` if served via dedup |

These headers are invaluable for debugging, monitoring, and understanding routing behavior in production.

---

## 12. Design Principles

### Zero dependencies

The entire system uses only Node.js standard library (`node:http`, `node:https`, `node:crypto`, `node:assert`). No Express, no Axios, no Redis, no external caching library. This eliminates supply-chain risk, reduces binary size, simplifies deployment, and means the only thing that can break is Node.js itself.

### Sub-millisecond classification

The classifier runs in <1ms for any prompt length. This is essential because the classification runs *in the request path* — every millisecond of latency here adds to the end-to-end response time. Keyword counting against in-memory arrays is orders of magnitude faster than embedding-based classification or calling another model.

### Graceful degradation everywhere

Every feature is designed to degrade gracefully rather than fail hard:
- Rate-limited models move to the end of the chain (not removed)
- Degraded 200s trigger fallback (not client error)
- Cache misses are silent (proceed to upstream)
- Dedup expiry returns an error to waiters (doesn't hang forever)
- All features can be independently disabled via flags
- The last model in the chain always gets its response returned to the client, even if degraded — a degraded response is better than no response

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

The system includes 17 models across 5 providers:

| Provider | Models | Tier Coverage |
|----------|--------|---------------|
| Google | Gemini 2.0 Flash, 2.5 Flash, 2.5 Pro | SIMPLE through COMPLEX |
| OpenAI | GPT-4o Mini, GPT-4o, o3, o3-mini | MEDIUM through REASONING |
| Anthropic | Claude 3.5 Haiku, Sonnet 4, Sonnet 4.6, Opus 4 | MEDIUM through baseline |
| DeepSeek | V3, R1 | SIMPLE and REASONING |
| Meta/Others | Llama 3.3 70B, Qwen3, Step 3.5 Flash, Trinity | Free tier |

All models are verified to support tool/function calling on OpenRouter, ensuring consistent capability across the fallback chain.
