/**
 * Smart Router Local Proxy Server
 *
 * OpenAI-compatible HTTP proxy that classifies prompts and routes
 * to optimal OpenRouter models. Zero external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { route, MODEL_REGISTRY } from "./index.js";
import type { RoutingProfile } from "./router/types.js";

const OPENROUTER_HOST = "openrouter.ai";
const OPENROUTER_PATH = "/api/v1/chat/completions";

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
      // Handle content array (multimodal)
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

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJSON(res, 200, { status: "ok" });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — the main proxy endpoint
// ---------------------------------------------------------------------------

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
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

  // Determine profile from x-smart-router-profile header or default
  const profileHeader = req.headers["x-smart-router-profile"];
  const profile: RoutingProfile =
    typeof profileHeader === "string" &&
    ["auto", "eco", "premium", "free"].includes(profileHeader)
      ? (profileHeader as RoutingProfile)
      : "auto";

  // Route the request
  const decision = route(userMessage, systemPrompt, maxTokens, { profile });

  log(
    `${decision.tier} ${decision.model} (score=${decision.scoring.score.toFixed(3)}, savings=${decision.cost.savingsPercent}%)`,
  );

  // Rewrite model in the body
  body.model = decision.model;
  const rewrittenBody = JSON.stringify(body);

  // Get authorization header
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    sendError(res, 401, "Missing Authorization header");
    return;
  }

  // Forward to OpenRouter
  const isStreaming = body.stream === true;

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(rewrittenBody)),
    Authorization: typeof authHeader === "string" ? authHeader : authHeader[0],
  };

  // Pass through HTTP-Referer and X-Title if present
  const referer = req.headers["http-referer"] ?? req.headers["referer"];
  if (referer) upstreamHeaders["HTTP-Referer"] = String(referer);
  const xTitle = req.headers["x-title"];
  if (xTitle) upstreamHeaders["X-Title"] = String(xTitle);

  const upstreamReq = httpsRequest(
    {
      hostname: OPENROUTER_HOST,
      port: 443,
      path: OPENROUTER_PATH,
      method: "POST",
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      // Copy status and headers from upstream
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) {
          responseHeaders[key] = value as string | string[];
        }
      }

      // Add routing info header
      responseHeaders["x-smart-router-model"] = decision.model;
      responseHeaders["x-smart-router-tier"] = decision.tier;

      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);

      if (isStreaming) {
        // SSE passthrough — pipe directly
        upstreamRes.pipe(res);
      } else {
        // Buffer non-streaming response and forward
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          res.end(Buffer.concat(chunks));
        });
        upstreamRes.on("error", () => {
          res.end();
        });
      }
    },
  );

  upstreamReq.on("error", (err) => {
    log(`Upstream error: ${err.message}`);
    if (!res.headersSent) {
      sendError(res, 502, `Failed to connect to OpenRouter: ${err.message}`);
    }
  });

  upstreamReq.write(rewrittenBody);
  upstreamReq.end();
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
    handleHealth(req, res);
  } else if (method === "GET" && url === "/v1/models") {
    handleModels(req, res);
  } else if (method === "POST" && url === "/v1/chat/completions") {
    handleChatCompletions(req, res).catch((err) => {
      log(`Unhandled error: ${err}`);
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error");
      }
    });
  } else {
    sendError(res, 404, `Not found: ${method} ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ProxyServerOptions {
  port?: number;
}

export function createProxyServer(options: ProxyServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.SMART_ROUTER_PORT ?? "18900", 10);
  const server = createServer(handleRequest);

  return {
    server,
    port,
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
