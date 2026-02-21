#!/usr/bin/env node
/**
 * Smart Router CLI — starts the local proxy server.
 *
 * Usage:
 *   npx tsx src/cli.ts
 *   SMART_ROUTER_PORT=8080 npx tsx src/cli.ts
 */

import { createProxyServer } from "./proxy.js";

const proxy = createProxyServer();

proxy.start().then(() => {
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
    "  Set Authorization header to your OpenRouter API key.",
    "  Set X-Smart-Router-Profile header to: auto | eco | premium | free",
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
