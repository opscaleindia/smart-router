/**
 * Smart Router Local Proxy Server
 *
 * OpenAI-compatible HTTP proxy that classifies prompts and routes
 * to optimal models via provider-based routing. Each model is resolved
 * to its best available provider (direct API or OpenRouter fallback).
 *
 * Features: provider routing, fallback retry, rate limit tracking,
 * degraded response detection, request dedup, response cache.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { route, MODEL_REGISTRY } from "./index.js";
import type { RoutingProfile, UpstreamResult, ProxyFeatureFlags, CacheConfig } from "./router/types.js";
import { DEFAULT_PROXY_FEATURES, DEFAULT_CACHE_CONFIG } from "./router/types.js";
import { RateLimiter } from "./rate-limiter.js";
import { checkDegraded } from "./degraded-detector.js";
import { ResponseCache } from "./cache.js";
import { RequestDedup } from "./dedup.js";
import {
  ProviderRegistry,
  forwardToTarget,
  forwardStreamingToTarget,
} from "./providers.js";
import { loadOpenClawConfig, type OpenClawConfig } from "./openclaw-loader.js";

const MAX_FALLBACK_CHAIN = 5;

/** Retriable HTTP status codes. */
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[SmartRouter] ${msg}\n`);
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Extract the last user message content from an OpenAI chat completions body. */
function extractLastUserMessage(body: any): string {
  const messages: any[] = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
      }
      return "";
    }
  }
  return "";
}

/** Extract system prompt from messages. */
function extractSystemPrompt(body: any): string {
  const messages: any[] = body?.messages;
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") return msg.content;
    }
  }
  return "";
}

/** Send a JSON error response. */
function sendError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({
    error: { message, type: "smart_router_error", code: status },
  });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send a JSON response. */
function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Check if an upstream result has a retriable error status. */
function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUSES.has(status);
}

/** Write a buffered UpstreamResult to the client response. */
function writeUpstreamResult(
  res: ServerResponse,
  result: UpstreamResult,
  routingHeaders: Record<string, string>,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(result.headers)) {
    if (value !== undefined) {
      headers[key] = value as string | string[];
    }
  }
  Object.assign(headers, routingHeaders);
  res.writeHead(result.status, headers);
  res.end(result.body);
}

// ---------------------------------------------------------------------------
// /v1/models — list available models in OpenAI format
// ---------------------------------------------------------------------------

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  const models = Object.values(MODEL_REGISTRY).map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 0,
    owned_by: m.id.split("/")[0],
  }));
  sendJSON(res, 200, { object: "list", data: models });
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): void {
  sendJSON(res, 200, {
    status: "ok",
    providers: ctx.providers.status(),
  });
}

// ---------------------------------------------------------------------------
// Proxy context — holds feature instances (not singletons)
// ---------------------------------------------------------------------------

interface ProxyContext {
  features: ProxyFeatureFlags;
  rateLimiter: RateLimiter;
  cache: ResponseCache;
  dedup: RequestDedup;
  providers: ProviderRegistry;
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — the main proxy endpoint
// ---------------------------------------------------------------------------

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): Promise<void> {
  // Read and parse request body
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch {
    sendError(res, 400, "Failed to read request body");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    sendError(res, 400, "Invalid JSON in request body");
    return;
  }

  // Extract prompt info for routing
  const userMessage = extractLastUserMessage(body);
  const systemPrompt = extractSystemPrompt(body);
  const maxTokens = body.max_tokens ?? 4096;

  // Determine profile: header > model name > default "auto"
  const profileHeader = req.headers["x-smart-router-profile"];
  const VALID_PROFILES = ["auto", "eco", "premium", "free", "agentic"] as const;
  let profile: RoutingProfile = "auto";
  if (typeof profileHeader === "string" && VALID_PROFILES.includes(profileHeader as any)) {
    profile = profileHeader as RoutingProfile;
  } else if (typeof body.model === "string" && VALID_PROFILES.includes(body.model as any)) {
    // OpenClaw sends the profile as the model name (e.g. "auto", "eco", "premium")
    profile = body.model as RoutingProfile;
  }

  // Route the request
  const decision = route(userMessage, systemPrompt, maxTokens, { profile });

  // Get authorization header (used as passthrough for OpenRouter)
  const authHeader = req.headers["authorization"];
  const passthroughAuth = typeof authHeader === "string"
    ? authHeader
    : Array.isArray(authHeader) ? authHeader[0] : undefined;

  // Collect pass-through headers (for OpenRouter)
  const passHeaders: Record<string, string> = {};
  const referer = req.headers["http-referer"] ?? req.headers["referer"];
  if (referer) passHeaders["HTTP-Referer"] = String(referer);
  const xTitle = req.headers["x-title"];
  if (xTitle) passHeaders["X-Title"] = String(xTitle);

  const isStreaming = body.stream === true;

  // Build model chain: [primary, ...fallbacks], capped at MAX_FALLBACK_CHAIN
  let modelChain = [decision.model, ...decision.fallbacks].slice(0, MAX_FALLBACK_CHAIN);

  // Rate limit reorder
  if (ctx.features.rateLimitTracking) {
    modelChain = ctx.rateLimiter.prioritizeNonRateLimited(modelChain);
  }

  // Resolve the primary model's provider for logging
  const primaryTarget = ctx.providers.resolve(decision.model, passthroughAuth);
  log(
    `${decision.tier} ${decision.model} → ${primaryTarget.provider}/${primaryTarget.upstreamModelId} (score=${decision.scoring.score.toFixed(3)}, savings=${decision.cost.savingsPercent}%)`,
  );

  const routingHeaders: Record<string, string> = {
    "x-smart-router-model": decision.model,
    "x-smart-router-tier": decision.tier,
  };

  // ---------------------------------------------------------------------------
  // Streaming path — special handling
  // ---------------------------------------------------------------------------
  if (isStreaming) {
    if (ctx.features.fallbackRetry) {
      for (let i = 0; i < modelChain.length; i++) {
        const model = modelChain[i];
        const target = ctx.providers.resolve(model, passthroughAuth);
        routingHeaders["x-smart-router-model"] = model;
        routingHeaders["x-smart-router-provider"] = target.provider;
        routingHeaders["x-smart-router-attempts"] = String(i + 1);

        try {
          const outcome = await forwardStreamingToTarget(
            target, body, passHeaders, res, routingHeaders,
          );

          if (outcome.piped) {
            return;
          }

          const result = outcome.result!;
          if (result.status === 429 && ctx.features.rateLimitTracking) {
            ctx.rateLimiter.recordRateLimit(model);
          }
          if (!isRetriableStatus(result.status) || i === modelChain.length - 1) {
            writeUpstreamResult(res, result, routingHeaders);
            return;
          }
          log(`Streaming attempt ${i + 1} failed (${result.status}) for ${model} via ${target.provider}, trying next`);
        } catch (err: any) {
          if (i === modelChain.length - 1) {
            sendError(res, 502, `Failed to connect to ${target.provider}: ${err.message}`);
            return;
          }
          log(`Streaming attempt ${i + 1} error for ${model} via ${target.provider}: ${err.message}, trying next`);
        }
      }
    } else {
      const target = ctx.providers.resolve(modelChain[0], passthroughAuth);
      routingHeaders["x-smart-router-provider"] = target.provider;
      try {
        const outcome = await forwardStreamingToTarget(
          target, body, passHeaders, res, routingHeaders,
        );
        if (!outcome.piped && outcome.result) {
          writeUpstreamResult(res, outcome.result, routingHeaders);
        }
      } catch (err: any) {
        sendError(res, 502, `Failed to connect to ${target.provider}: ${err.message}`);
      }
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Non-streaming path — full feature set
  // ---------------------------------------------------------------------------

  // Dedup check
  let dedupKey: string | undefined;
  if (ctx.features.requestDedup) {
    dedupKey = ctx.dedup.computeKey(body);
    const slot = ctx.dedup.acquire(dedupKey);
    if (slot.status === "waiting") {
      try {
        const coalesced = await slot.promise;
        routingHeaders["x-smart-router-dedup"] = "coalesced";
        writeUpstreamResult(res, coalesced, routingHeaders);
      } catch (err: any) {
        sendError(res, 502, `Coalesced request failed: ${err.message}`);
      }
      return;
    }
  }

  // Cache check
  let cacheKey: string | undefined;
  if (ctx.features.responseCache) {
    cacheKey = ctx.cache.computeKey(body);
    const cached = ctx.cache.get(cacheKey);
    if (cached) {
      routingHeaders["x-smart-router-cache"] = "hit";
      if (dedupKey) ctx.dedup.resolve(dedupKey, cached);
      writeUpstreamResult(res, cached, routingHeaders);
      return;
    }
  }

  // Fallback loop
  let lastResult: UpstreamResult | undefined;

  const modelsToTry = ctx.features.fallbackRetry ? modelChain : [modelChain[0]];

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    const target = ctx.providers.resolve(model, passthroughAuth);
    routingHeaders["x-smart-router-model"] = model;
    routingHeaders["x-smart-router-provider"] = target.provider;
    routingHeaders["x-smart-router-attempts"] = String(i + 1);

    try {
      const result = await forwardToTarget(target, body, passHeaders, i);
      lastResult = result;

      // Record rate limits
      if (result.status === 429 && ctx.features.rateLimitTracking) {
        ctx.rateLimiter.recordRateLimit(model);
      }

      // Check if retriable error
      if (isRetriableStatus(result.status)) {
        if (i < modelsToTry.length - 1) {
          log(`Attempt ${i + 1} failed (${result.status}) for ${model} via ${target.provider}, trying next`);
          continue;
        }
      } else if (result.status >= 200 && result.status < 300) {
        // Degraded detection on 200 responses
        if (ctx.features.degradedDetection) {
          const bodyStr = result.body.toString("utf-8");
          const degraded = checkDegraded(bodyStr);
          if (degraded.isDegraded) {
            log(`Degraded response from ${model} via ${target.provider}: ${degraded.matchedPattern}`);
            if (i < modelsToTry.length - 1) {
              continue;
            }
          }
        }

        // Success — cache and resolve dedup
        if (cacheKey && ctx.features.responseCache) {
          ctx.cache.set(cacheKey, result);
        }
        if (dedupKey) {
          ctx.dedup.resolve(dedupKey, result);
        }
        writeUpstreamResult(res, result, routingHeaders);
        return;
      }
      // Non-retriable error (4xx other than 429) — return immediately
      if (!isRetriableStatus(result.status) && result.status >= 400) {
        break;
      }
    } catch (err: any) {
      log(`Attempt ${i + 1} error for ${model} via ${target.provider}: ${err.message}`);
      if (i === modelsToTry.length - 1) {
        if (dedupKey) ctx.dedup.reject(dedupKey, err);
        sendError(res, 502, `Failed to connect to upstream: ${err.message}`);
        return;
      }
    }
  }

  // All attempts exhausted or non-retriable error
  if (lastResult) {
    if (dedupKey) ctx.dedup.resolve(dedupKey, lastResult);
    writeUpstreamResult(res, lastResult, routingHeaders);
  } else {
    const err = new Error("All upstream attempts failed");
    if (dedupKey) ctx.dedup.reject(dedupKey, err);
    sendError(res, 502, "All upstream attempts failed");
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function createRequestHandler(ctx: ProxyContext) {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Smart-Router-Profile, X-Title",
      });
      res.end();
      return;
    }

    // Set CORS header on all responses
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (method === "GET" && url === "/health") {
      handleHealth(req, res, ctx);
    } else if (method === "GET" && url === "/v1/models") {
      handleModels(req, res);
    } else if (method === "POST" && url === "/v1/chat/completions") {
      handleChatCompletions(req, res, ctx).catch((err) => {
        log(`Unhandled error: ${err}`);
        if (!res.headersSent) {
          sendError(res, 500, "Internal server error");
        }
      });
    } else {
      sendError(res, 404, `Not found: ${method} ${url}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ProxyServerOptions {
  port?: number;
  features?: Partial<ProxyFeatureFlags>;
  cacheConfig?: Partial<CacheConfig>;
  rateLimitCooldownMs?: number;
  dedupTtlMs?: number;
  /** Pre-loaded OpenClaw config (if omitted, reads from disk). */
  openclawConfig?: OpenClawConfig;
}

export function createProxyServer(options: ProxyServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.SMART_ROUTER_PORT ?? "18900", 10);

  const features: ProxyFeatureFlags = {
    ...DEFAULT_PROXY_FEATURES,
    ...options.features,
  };

  const openclawConfig = options.openclawConfig ?? loadOpenClawConfig();
  const providers = new ProviderRegistry(openclawConfig);

  const ctx: ProxyContext = {
    features,
    rateLimiter: new RateLimiter(options.rateLimitCooldownMs),
    cache: new ResponseCache(options.cacheConfig),
    dedup: new RequestDedup(options.dedupTtlMs),
    providers,
  };

  const server = createServer(createRequestHandler(ctx));

  return {
    server,
    port,
    ctx,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, () => resolve());
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
