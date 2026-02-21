/**
 * Degraded Response Detector
 *
 * Detects fake-200 error responses from upstream providers that return
 * HTTP 200 but contain error messages, billing issues, or repetitive garbage.
 */

import type { DegradedCheckResult } from "./router/types.js";

/** Patterns checked against the raw response body. */
export const DEGRADED_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /billing/i, label: "billing" },
  { pattern: /insufficient[\s._-]*balance/i, label: "insufficient_balance" },
  { pattern: /rate[\s._-]*limit/i, label: "rate_limit" },
  { pattern: /model[\s\S]{0,20}unavailable/i, label: "model_unavailable" },
  { pattern: /service[\s\S]{0,20}unavailable/i, label: "service_unavailable" },
  { pattern: /overloaded/i, label: "overloaded" },
  { pattern: /request\s+too\s+large/i, label: "request_too_large" },
  { pattern: /payload\s+too\s+large/i, label: "payload_too_large" },
];

/** Repetitive loop: same 20+ char block repeated 5+ times (checked on content only). */
const REPETITIVE_LOOP_PATTERN = /(.{20,}?)\1{4,}/s;

/**
 * Try to extract the message content from an OpenAI-format JSON response.
 * Returns null if the response is not valid JSON or doesn't have the expected structure.
 */
function extractContent(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // Not JSON — return null
  }
  return null;
}

/**
 * Check whether a response body appears to be a degraded response.
 * Text patterns are checked against the full body; the repetitive loop
 * pattern is checked only against extracted content to avoid false positives
 * from repeated JSON structure.
 */
export function checkDegraded(responseBody: string): DegradedCheckResult {
  // Check text patterns against full body
  for (const { pattern, label } of DEGRADED_PATTERNS) {
    if (pattern.test(responseBody)) {
      return { isDegraded: true, matchedPattern: label };
    }
  }

  // Check repetitive loop against extracted content (avoids false positives
  // from repeated JSON structure). Falls back to raw body for non-JSON.
  const content = extractContent(responseBody);
  const textToCheck = content ?? responseBody;
  if (textToCheck.length > 250 && REPETITIVE_LOOP_PATTERN.test(textToCheck)) {
    return { isDegraded: true, matchedPattern: "repetitive_loop" };
  }

  return { isDegraded: false, matchedPattern: null };
}
