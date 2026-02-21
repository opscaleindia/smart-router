/**
 * Provider Registry
 *
 * Resolves OpenClaw model keys (e.g. "openrouter/moonshotai/kimi-k2.5")
 * to concrete upstream targets using provider auth loaded from OpenClaw config.
 *
 * Model key format: "provider/model-id"
 *   - provider = first path segment (e.g. "openrouter")
 *   - model-id = everything after the first "/" (e.g. "moonshotai/kimi-k2.5")
 *
 * Provider base URLs come from OPENCLAW_BUILTIN_PROVIDERS or custom overrides.
 * Auth comes from OpenClaw's auth-profiles.json at startup.
 */

import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import type { UpstreamResult } from "./router/types.js";
import {
  OPENCLAW_BUILTIN_PROVIDERS,
  loadOpenClawConfig,
  type OpenClawConfig,
} from "./openclaw-loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved target for a specific model — where to send the request. */
export interface ResolvedTarget {
  /** The provider key (e.g. "openrouter"). */
  provider: string;
  /** Hostname for the request. */
  hostname: string;
  /** Port number. */
  port: number;
  /** Path for the request. */
  path: string;
  /** Whether to use HTTPS. */
  useHttps: boolean;
  /** The model ID to send in the request body (everything after provider prefix). */
  upstreamModelId: string;
  /** API key for this provider, or null. */
  apiKey: string | null;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private providerKeys: Map<string, string>;
  private baseUrls: Map<string, { baseUrl: string; completionsPath?: string }>;

  constructor(openclawConfig?: OpenClawConfig) {
    const config = openclawConfig ?? loadOpenClawConfig();

    // Load API keys from OpenClaw config
    this.providerKeys = new Map(Object.entries(config.providerKeys));

    // Load base URLs: built-in + custom overrides
    this.baseUrls = new Map(Object.entries(OPENCLAW_BUILTIN_PROVIDERS));
    for (const [name, provider] of Object.entries(config.customProviders)) {
      if (provider.baseUrl) {
        this.baseUrls.set(name, { baseUrl: provider.baseUrl });
      }
    }
  }

  /** Check if a provider has an API key configured. */
  hasApiKey(providerName: string): boolean {
    return this.providerKeys.has(providerName);
  }

  /** Get the API key for a provider. */
  getApiKey(providerName: string): string | null {
    return this.providerKeys.get(providerName) ?? null;
  }

  /**
   * Resolve an OpenClaw model key to a concrete upstream target.
   *
   * Model key format: "provider/upstream-model-id"
   * The provider prefix determines the base URL and auth.
   *
   * @param modelKey OpenClaw model key (e.g. "openrouter/moonshotai/kimi-k2.5")
   * @param passthroughAuth Fallback auth from the client request Authorization header
   */
  resolve(modelKey: string, passthroughAuth?: string): ResolvedTarget {
    const slashIdx = modelKey.indexOf("/");
    let provider: string;
    let upstreamModelId: string;

    if (slashIdx > 0) {
      provider = modelKey.substring(0, slashIdx);
      upstreamModelId = modelKey.substring(slashIdx + 1);
    } else {
      // No provider prefix — fall back to openrouter
      provider = "openrouter";
      upstreamModelId = modelKey;
    }

    return this.buildTarget(provider, upstreamModelId, passthroughAuth);
  }

  /** Build a ResolvedTarget for a given provider and upstream model ID. */
  private buildTarget(
    providerName: string,
    upstreamModelId: string,
    passthroughAuth?: string,
  ): ResolvedTarget {
    const providerInfo = this.baseUrls.get(providerName)
      ?? OPENCLAW_BUILTIN_PROVIDERS.openrouter;

    const url = new URL(providerInfo.baseUrl);
    const completionsPath = providerInfo.completionsPath ?? "/chat/completions";
    const fullPath = url.pathname.replace(/\/$/, "") + completionsPath;
    const useHttps = url.protocol === "https:";

    // Resolve API key: provider key from OpenClaw > passthrough auth
    let apiKey = this.providerKeys.get(providerName) ?? null;
    if (!apiKey && passthroughAuth) {
      apiKey = passthroughAuth.replace(/^Bearer\s+/i, "");
    }

    return {
      provider: providerName,
      hostname: url.hostname,
      port: parseInt(url.port || (useHttps ? "443" : "80"), 10),
      path: fullPath,
      useHttps,
      upstreamModelId,
      apiKey,
    };
  }

  /** Get a summary of which providers have API keys configured. */
  status(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [name] of this.baseUrls) {
      result[name] = this.providerKeys.has(name);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// HTTP forwarding using resolved targets
// ---------------------------------------------------------------------------

/** Forward a request to the resolved upstream target and buffer the response. */
export function forwardToTarget(
  target: ResolvedTarget,
  requestBody: Record<string, unknown>,
  passHeaders: Record<string, string>,
  attemptIndex: number,
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const bodyWithModel = {
      ...requestBody,
      model: target.upstreamModelId,
      stream: false,
    };
    const payload = JSON.stringify(bodyWithModel);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      ...passHeaders,
    };

    if (target.apiKey) {
      headers["Authorization"] = `Bearer ${target.apiKey}`;
    }

    const requestFn = target.useHttps ? httpsRequest : httpRequest;

    const options: RequestOptions = {
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: "POST",
      headers,
    };

    const req = requestFn(options, (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const responseHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          responseHeaders[key] = value;
        }
        resolve({
          status: upstreamRes.statusCode ?? 502,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
          model: target.upstreamModelId,
          attemptIndex,
        });
      });
      upstreamRes.on("error", (err) => reject(err));
    });

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

/** Forward a streaming request. Pipes SSE on 2xx, buffers on error. */
export function forwardStreamingToTarget(
  target: ResolvedTarget,
  requestBody: Record<string, unknown>,
  passHeaders: Record<string, string>,
  res: import("node:http").ServerResponse,
  routingHeaders: Record<string, string>,
): Promise<{ piped: boolean; result?: UpstreamResult }> {
  return new Promise((resolve, reject) => {
    const bodyWithModel = {
      ...requestBody,
      model: target.upstreamModelId,
      stream: true,
    };
    const payload = JSON.stringify(bodyWithModel);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      ...passHeaders,
    };

    if (target.apiKey) {
      headers["Authorization"] = `Bearer ${target.apiKey}`;
    }

    const requestFn = target.useHttps ? httpsRequest : httpRequest;

    const options: RequestOptions = {
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: "POST",
      headers,
    };

    const req = requestFn(options, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;

      if (status >= 200 && status < 300) {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined) {
            responseHeaders[key] = value as string | string[];
          }
        }
        Object.assign(responseHeaders, routingHeaders);
        res.writeHead(status, responseHeaders);
        upstreamRes.pipe(res);
        resolve({ piped: true });
      } else {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const responseHeaders: Record<string, string | string[] | undefined> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            responseHeaders[key] = value;
          }
          resolve({
            piped: false,
            result: {
              status,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
              model: target.upstreamModelId,
              attemptIndex: 0,
            },
          });
        });
        upstreamRes.on("error", (err) => reject(err));
      }
    });

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}
