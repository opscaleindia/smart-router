# Smart Router — Build Instructions

## Goal
Build an in-house LLM smart router for OpenClaw that works with OpenRouter's API.
Inspired by ClawRouter (see REFERENCE.md for full reverse engineering analysis).

## What to Build

A TypeScript module with these components:

### 1. `src/router/rules.ts` — Request Classifier
- 14-dimension weighted keyword scorer (copy the approach from ClawRouter)
- Dimensions: tokenCount, codePresence, reasoningMarkers, technicalTerms, creativeMarkers, simpleIndicators, multiStepPatterns, questionComplexity, imperativeVerbs, constraintCount, outputFormat, referenceComplexity, negationComplexity, domainSpecificity, agenticTask
- Each returns score in [-1, 1], weights sum to 1.0
- Sigmoid confidence calibration
- Multilingual keywords (English at minimum)
- Output: ScoringResult { score, tier, confidence, signals }

### 2. `src/router/config.ts` — Tier → Model Mapping
- 4 tiers: SIMPLE, MEDIUM, COMPLEX, REASONING
- 4 profiles: auto, eco, premium, free
- Each tier has primary model + fallback chain
- **Use OpenRouter model IDs** (e.g., `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4`, `google/gemini-2.5-flash`, etc.)
- Pick real models available on OpenRouter, optimized for cost:
  - SIMPLE: cheapest (deepseek-chat, gemini-flash, etc.)
  - MEDIUM: mid-tier (gpt-4o-mini, claude-haiku)
  - COMPLEX: premium (gpt-4o, claude-sonnet, gemini-pro)
  - REASONING: reasoning-capable (o3, deepseek-reasoner)

### 3. `src/router/selector.ts` — Model Selection
- Takes tier + profile → returns model ID + fallback chain
- Cost estimation (use OpenRouter pricing)
- Savings calculation vs baseline (claude-opus)

### 4. `src/router/types.ts` — Type Definitions
- Tier, ScoringResult, RoutingDecision, TierConfig, ScoringConfig, RoutingConfig

### 5. `src/router/index.ts` — Entry Point
- `route(prompt, systemPrompt, maxOutputTokens, options)` → RoutingDecision
- Orchestrates: classify → override checks → select model

### 6. `src/index.ts` — Main Export
- Export the route function and types
- Simple API: `import { route } from './smart-router'`

## What NOT to Build
- No proxy server (OpenClaw already handles HTTP)
- No x402/payment/wallet/crypto stuff
- No compression (nice-to-have later)
- No response caching (nice-to-have later)
- No deduplication (nice-to-have later)

## Tech Stack
- TypeScript (strict mode)
- Zero external dependencies
- Node.js ESM modules
- Include a tsconfig.json

## Testing
- Add basic tests (vitest or plain Node assert)
- Test the classifier with example prompts:
  - "What is the capital of France?" → SIMPLE
  - "Write a function to sort an array in Python" → MEDIUM
  - "Design a distributed microservice architecture for a real-time trading platform" → COMPLEX
  - "Prove that the halting problem is undecidable, step by step" → REASONING

## Output
Working TypeScript project that can be imported as a module. Keep it clean, well-commented, production-ready.
