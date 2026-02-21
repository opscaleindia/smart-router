# @openclaw/smart-router

LLM smart router for OpenClaw. Classifies prompt complexity using a 15-dimension weighted scorer and routes to the cheapest capable model across your configured providers.

**Zero dependencies. Sub-millisecond classification. Up to 97% cost savings on simple queries.**

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/opscaleindia/smart-router.git
cd smart-router
npm install
```

### 2. Make sure OpenClaw is set up

Smart-router reads provider auth directly from your OpenClaw configuration. You need at minimum an OpenRouter API key configured in OpenClaw:

```bash
openclaw configure   # if you haven't already
```

Verify your model auth is working:

```bash
openclaw models status
```

You should see at least one provider with a valid key (e.g. `openrouter`).

### 3. Start the proxy

```bash
npx tsx src/cli.ts
```

You'll see:

```
  ╭─────────────────────────────────────────╮
  │         @openclaw/smart-router           │
  │         Local Proxy Server               │
  ╰─────────────────────────────────────────╯

  Listening on   http://localhost:18900
  Chat endpoint  POST /v1/chat/completions
  Models list    GET  /v1/models
  Health check   GET  /health

  Providers:     openrouter (fallback)
```

### 4. Register smart-router as a provider in OpenClaw

Add the smart-router as a custom provider so OpenClaw agents can use it:

```bash
openclaw config set models.providers.smart '{
  "baseUrl": "http://127.0.0.1:18900/v1",
  "apiKey": "<your-openrouter-api-key>",
  "api": "openai-completions",
  "models": [
    { "id": "auto", "name": "Smart Router Auto", "reasoning": false, "input": ["text"], "contextWindow": 200000, "maxTokens": 16384 },
    { "id": "eco", "name": "Smart Router Eco", "reasoning": false, "input": ["text"], "contextWindow": 200000, "maxTokens": 16384 },
    { "id": "premium", "name": "Smart Router Premium", "reasoning": false, "input": ["text"], "contextWindow": 200000, "maxTokens": 16384 }
  ]
}'
```

Then set it as the default model:

```bash
openclaw models set smart/auto
```

### 5. Verify

```bash
# Health check (shows which providers have auth)
curl http://localhost:18900/health

# Send a test request
curl http://localhost:18900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 50
  }'
```

The router log will show something like:

```
[SmartRouter] SIMPLE openrouter/moonshotai/kimi-k2.5 → openrouter/moonshotai/kimi-k2.5 (score=-0.171, savings=97%)
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMART_ROUTER_PORT` | `18900` | Port for the proxy server |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | Override OpenClaw config directory |

### Provider auth

Smart-router reads API keys from OpenClaw's `~/.openclaw/agents/main/agent/auth-profiles.json`. No separate configuration needed — if OpenClaw can reach a provider, smart-router can too.

To add direct provider access (bypasses OpenRouter for lower latency and cost):

```bash
# These keys are picked up automatically on next smart-router restart
openclaw models auth add   # interactive helper
```

When a direct provider key is available, smart-router routes to that provider's API instead of going through OpenRouter. For example, with an OpenAI key configured, `openai/gpt-5.2` routes directly to `api.openai.com` instead of `openrouter.ai`.

Supported direct providers:

| Provider | Base URL | Env var (alternative) |
|----------|----------|----------------------|
| OpenRouter | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| OpenAI | `api.openai.com/v1` | `OPENAI_API_KEY` |
| Google | `generativelanguage.googleapis.com` | `GOOGLE_API_KEY` |
| xAI | `api.x.ai/v1` | `XAI_API_KEY` |
| DeepSeek | `api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| Groq | `api.groq.com/openai/v1` | — |
| Mistral | `api.mistral.ai/v1` | — |
| Cerebras | `api.cerebras.ai/v1` | — |

## How Routing Works

```
Request → Extract last user message
        → 15-Dimension Scorer → weighted score
        → Map score to Tier (SIMPLE / MEDIUM / COMPLEX / REASONING)
        → Select model from Profile (auto / eco / premium / free / agentic)
        → Resolve provider from OpenClaw model key
        → Forward to upstream with fallback chain
```

### Scoring dimensions

| Dimension | Weight | Detects |
|-----------|--------|---------|
| reasoningMarkers | 18% | "prove", "theorem", "step by step" |
| codePresence | 15% | "function", "class", "import", code blocks |
| multiStepPatterns | 12% | "first...then", "step 1", numbered lists |
| technicalTerms | 10% | "algorithm", "kubernetes", "distributed" |
| tokenCount | 8% | Short prompts → simple, long → complex |
| agenticTask | 4% | "edit", "deploy", "fix", "debug" |
| + 9 more | 33% | creative, constraints, format, domain, etc. |

### Tier boundaries

| Score range | Tier |
|-------------|------|
| < 0.0 | SIMPLE |
| 0.0 – 0.3 | MEDIUM |
| 0.3 – 0.5 | COMPLEX |
| >= 0.5 | REASONING |

### Routing profiles

**auto** — balanced quality/cost (default)

| Tier | Primary | Fallbacks |
|------|---------|-----------|
| SIMPLE | Kimi K2.5 | Gemini 2.5 Flash, GPT-OSS-120B, DeepSeek |
| MEDIUM | Grok Code Fast | Gemini 2.5 Flash, DeepSeek, Kimi K2.5 |
| COMPLEX | Gemini 3 Pro | Gemini 2.5 Flash/Pro, DeepSeek, Grok 4 |
| REASONING | Grok 4.1 Fast | DeepSeek Reasoner, o4-mini, o3 |

**eco** — maximum savings

| Tier | Primary |
|------|---------|
| SIMPLE | GPT-OSS-120B (free) |
| MEDIUM | Gemini 2.5 Flash |
| COMPLEX | Gemini 2.5 Flash |
| REASONING | Grok 4.1 Fast |

**premium** — best quality

| Tier | Primary |
|------|---------|
| SIMPLE | Kimi K2.5 |
| MEDIUM | GPT-5.2 Codex |
| COMPLEX | Claude Opus 4 |
| REASONING | Claude Sonnet 4 |

**free** — zero cost (all tiers use GPT-OSS-120B)

**agentic** — optimized for tool-use / agent workflows

| Tier | Primary |
|------|---------|
| SIMPLE | Kimi K2.5 |
| MEDIUM | Grok Code Fast |
| COMPLEX | Claude Sonnet 4 |
| REASONING | Claude Sonnet 4 |

## Resilience Features

All enabled by default. Each can be toggled independently via `ProxyServerOptions.features`.

| Feature | What it does |
|---------|-------------|
| **Fallback retry** | On upstream error (429/5xx), tries next model in chain (up to 5) |
| **Rate limit tracking** | Tracks 429s per model, deprioritizes rate-limited models for 60s |
| **Degraded detection** | Catches fake-200 errors (billing, unavailable, repetitive loops) and retries |
| **Request dedup** | Coalesces identical in-flight requests — second caller gets first caller's response |
| **Response cache** | LRU cache for non-streaming responses (200 entries, 10min TTL) |

## API

### POST /v1/chat/completions

OpenAI-compatible chat completions endpoint. Send a routing profile as the `model` field:

```json
{
  "model": "auto",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}
```

Valid `model` values: `auto`, `eco`, `premium`, `free`, `agentic`

Alternatively, set the profile via the `X-Smart-Router-Profile` header.

**Response headers** added by smart-router:

| Header | Example | Description |
|--------|---------|-------------|
| `x-smart-router-model` | `openrouter/moonshotai/kimi-k2.5` | Model that served the request |
| `x-smart-router-tier` | `SIMPLE` | Classified tier |
| `x-smart-router-provider` | `openrouter` | Provider used |
| `x-smart-router-attempts` | `1` | Number of upstream attempts |
| `x-smart-router-cache` | `hit` | Present on cache hits |
| `x-smart-router-dedup` | `coalesced` | Present on deduplicated requests |

### GET /v1/models

Lists all models in the routing registry (OpenAI format).

### GET /health

Returns provider status:

```json
{
  "status": "ok",
  "providers": {
    "openrouter": true,
    "openai": false,
    "google": false,
    "xai": false,
    "deepseek": false
  }
}
```

## Programmatic Usage

```typescript
import { route, classifyByRules, Tier } from '@openclaw/smart-router';

// Classify a prompt
const result = classifyByRules("Prove P != NP");
console.log(result.tier);       // "REASONING"
console.log(result.score);      // 0.158
console.log(result.confidence); // 0.87

// Full routing decision
const decision = route("What is AI?");
console.log(decision.model);           // "openrouter/moonshotai/kimi-k2.5"
console.log(decision.tier);            // "SIMPLE"
console.log(decision.cost.estimated);  // 0.0098
console.log(decision.cost.baseline);   // 0.3072
console.log(decision.cost.savingsPercent); // 97

// With profile and forced tier
const d = route("Hello", "", 4096, { profile: "premium", forceTier: Tier.COMPLEX });
```

## Project Structure

```
src/
├── cli.ts                 # CLI entry point — starts the proxy server
├── index.ts               # Barrel exports
├── proxy.ts               # HTTP proxy with fallback loop + feature integration
├── providers.ts           # Provider registry — resolves model keys to upstream targets
├── openclaw-loader.ts     # Reads OpenClaw config (auth, providers) from disk
├── rate-limiter.ts        # Per-model 429 tracking with cooldown
├── degraded-detector.ts   # Fake-200 pattern matching
├── cache.ts               # LRU response cache with TTL
├── dedup.ts               # Request coalescing for duplicates
└── router/
    ├── types.ts            # Type definitions
    ├── rules.ts            # 15-dimension weighted classifier
    ├── config.ts           # Model registry + profile configs (OpenClaw keys)
    ├── selector.ts         # Tier → model selection + cost estimation
    └── index.ts            # Router entry point

tests/
├── router.test.ts          # Classifier + route() tests
├── providers.test.ts       # Provider resolution tests
├── rate-limiter.test.ts
├── degraded-detector.test.ts
├── cache.test.ts
└── dedup.test.ts
```

## Running Tests

```bash
# All tests
npm test
node --import tsx tests/providers.test.ts
node --import tsx tests/rate-limiter.test.ts
node --import tsx tests/degraded-detector.test.ts
node --import tsx tests/cache.test.ts
node --import tsx tests/dedup.test.ts

# Type check
npx tsc --noEmit
```

## License

MIT
