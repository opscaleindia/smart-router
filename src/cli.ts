#!/usr/bin/env node
/**
 * Smart Router CLI — starts the local proxy server.
 *
 * Usage:
 *   npx tsx src/cli.ts
 *   SMART_ROUTER_PORT=8080 npx tsx src/cli.ts
 */

import { createProxyServer } from "./proxy.js";

const proxy = createProxyServer({
  features: {
    sessionTracking: true,
    sessionJournal: true,
  },
});

proxy.start().then(() => {
  const providerStatus = proxy.ctx.providers.status();
  const directProviders = Object.entries(providerStatus)
    .filter(([name, hasKey]) => hasKey && name !== "openrouter")
    .map(([name]) => name);

  const banner = [
    "",
    "  ╭─────────────────────────────────────────╮",
    "  │         @openclaw/smart-router           │",
    "  │         Local Proxy Server               │",
    "  ╰─────────────────────────────────────────╯",
    "",
    `  Listening on   http://localhost:${proxy.port}`,
    `  Chat endpoint  POST /v1/chat/completions`,
    `  Models list    GET  /v1/models`,
    `  Health check   GET  /health`,
    "",
    `  Providers:     openrouter (fallback)${directProviders.length > 0 ? `, ${directProviders.join(", ")} (direct)` : ""}`,
    "  Set X-Smart-Router-Profile header to: auto | eco | premium | free | agentic",
    "",
  ].join("\n");

  process.stderr.write(banner + "\n");
});

// Graceful shutdown
function shutdown() {
  process.stderr.write("\n[SmartRouter] Shutting down...\n");
  proxy.stop().then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
