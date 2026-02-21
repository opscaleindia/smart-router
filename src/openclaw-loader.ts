/**
 * OpenClaw Config Loader
 *
 * Reads OpenClaw's configuration files to discover:
 * - Available providers and their auth (API keys)
 * - Custom provider endpoints (baseUrl, api type)
 * - Available model catalog
 *
 * This lets smart-router route only among models configured in OpenClaw
 * and use OpenClaw's auth for upstream requests.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenClawAuthProfile {
  type: string; // "api_key" | "oauth" | etc.
  provider: string;
  key?: string;
}

export interface OpenClawCustomProvider {
  baseUrl: string;
  apiKey?: string;
  api?: string; // "openai-completions" | "anthropic-messages" | etc.
  models?: Array<{
    id: string;
    name: string;
    [key: string]: unknown;
  }>;
}

export interface OpenClawConfig {
  /** API keys keyed by provider name (e.g. { openrouter: "sk-or-..." }). */
  providerKeys: Record<string, string>;
  /** Custom providers from models.json (e.g. { smart: { baseUrl, apiKey, ... } }). */
  customProviders: Record<string, OpenClawCustomProvider>;
  /** The config directory that was loaded from. */
  configDir: string;
}

// ---------------------------------------------------------------------------
// Well-known provider base URLs (built into OpenClaw)
// ---------------------------------------------------------------------------

export const OPENCLAW_BUILTIN_PROVIDERS: Record<string, { baseUrl: string; completionsPath?: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", completionsPath: "/messages" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw agent config directory.
 * Uses OPENCLAW_STATE_DIR env var if set, otherwise ~/.openclaw.
 */
function resolveConfigDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  return join(stateDir, "agents", "main", "agent");
}

/**
 * Load OpenClaw configuration from disk.
 * Reads auth-profiles.json for provider API keys and models.json for custom providers.
 */
export function loadOpenClawConfig(configDir?: string): OpenClawConfig {
  const dir = configDir ?? resolveConfigDir();
  const providerKeys: Record<string, string> = {};
  const customProviders: Record<string, OpenClawCustomProvider> = {};

  // --- Read auth-profiles.json ---
  const authPath = join(dir, "auth-profiles.json");
  if (existsSync(authPath)) {
    try {
      const data = JSON.parse(readFileSync(authPath, "utf-8"));
      const profiles: Record<string, OpenClawAuthProfile> = data?.profiles ?? {};
      for (const profile of Object.values(profiles)) {
        if (profile.provider && profile.key) {
          providerKeys[profile.provider] = profile.key;
        }
      }
    } catch {
      // Silently skip on parse errors
    }
  }

  // --- Read auth.json (fallback for simpler format) ---
  const authFallbackPath = join(dir, "auth.json");
  if (existsSync(authFallbackPath)) {
    try {
      const data = JSON.parse(readFileSync(authFallbackPath, "utf-8"));
      for (const [provider, entry] of Object.entries(data)) {
        if (typeof entry === "object" && entry !== null && "key" in entry) {
          const key = (entry as any).key;
          if (typeof key === "string" && !providerKeys[provider]) {
            providerKeys[provider] = key;
          }
        }
      }
    } catch {
      // Silently skip
    }
  }

  // --- Read models.json for custom providers ---
  const modelsPath = join(dir, "models.json");
  if (existsSync(modelsPath)) {
    try {
      const data = JSON.parse(readFileSync(modelsPath, "utf-8"));
      const providers: Record<string, OpenClawCustomProvider> = data?.providers ?? {};
      for (const [name, config] of Object.entries(providers)) {
        customProviders[name] = config;
        // If the custom provider has an apiKey and we don't have one from auth-profiles
        if (config.apiKey && !providerKeys[name]) {
          providerKeys[name] = config.apiKey;
        }
      }
    } catch {
      // Silently skip
    }
  }

  return { providerKeys, customProviders, configDir: dir };
}
