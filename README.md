# @openclaw/smart-router

In-house LLM smart router for OpenClaw. Classifies prompt complexity using a 14-dimension weighted scorer and routes to the optimal model via OpenRouter.

**Zero dependencies. Sub-millisecond routing. 99% cost savings on simple queries.**

## How It Works

```
Prompt → 14-Dimension Scorer → Tier (SIMPLE/MEDIUM/COMPLEX/REASONING) → Cheapest Capable Model
```

### Scoring Dimensions
| Dimension | Weight | Detects |
|-----------|--------|---------|
| reasoningMarkers | 18% | "prove", "theorem", "step by step" |
| codePresence | 15% | "function", "class", "import", code blocks |
| multiStepPatterns | 12% | "first...then", "step 1", numbered lists |
| technicalTerms | 12% | "algorithm", "kubernetes", "distributed" |
| tokenCount | 8% | Short prompts → simple, long → complex |
| agenticTask | 6% | "edit", "deploy", "fix", "debug" |
| + 9 more dimensions | 29% | creative, constraints, format, domain, etc. |

### 4 Routing Profiles
| Profile | Strategy | Best For |
|---------|----------|----------|
| `auto` | Balanced quality/cost | General use |
| `eco` | Cheapest possible | Maximum savings |
| `premium` | Best quality | Critical tasks |
| `free` | Free models only | Zero cost |

## Usage

```typescript
import { route, Tier } from '@openclaw/smart-router';

// Basic usage
const decision = route("What is the capital of France?");
console.log(decision.model);    // "google/gemini-2.0-flash-001"
console.log(decision.tier);     // "SIMPLE"
console.log(decision.cost);     // { estimated: 0.001, baseline: 0.30, savingsPercent: 99 }

// With profile
const eco = route("Explain recursion", "", 4096, { profile: "eco" });
const premium = route("Design a system", "", 4096, { profile: "premium" });

// Force a tier
const forced = route("Hello", "", 4096, { forceTier: Tier.COMPLEX });
```

## Install

```bash
npm install
npm run build
npm test
```

## Architecture

```
src/
├── index.ts              # Main export
└── router/
    ├── types.ts           # Type definitions
    ├── rules.ts           # 14-dimension classifier
    ├── config.ts          # Model registry + tier mappings
    ├── selector.ts        # Tier → model selection + cost
    └── index.ts           # Router entry point
```

## Inspired By

Reverse-engineered from [ClawRouter](https://github.com/BlockRunAI/ClawRouter) (MIT). Stripped all payment/wallet/x402 code, kept the pure routing intelligence, adapted for OpenRouter.

## License

MIT
