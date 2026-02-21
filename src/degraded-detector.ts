/**
 * Degraded Response Detector
 *
 * Detects fake-200 error responses from upstream providers that return
 * HTTP 200 but contain error messages, billing issues, or repetitive garbage.
 */

import type { DegradedCheckResult } from "./router/types.js";

/** Patterns that indicate a degraded upstream response. */
export const DEGRADED_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /billing/i, label: "billing" },
  { pattern: /insufficient[\s._-]*balance/i, label: "insufficient_balance" },
  { pattern: /rate[\s._-]*limit/i, label: "rate_limit" },
  { pattern: /model[\s\S]{0,20}unavailable/i, label: "model_unavailable" },
  { pattern: /service[\s\S]{0,20}unavailable/i, label: "service_unavailable" },
  { pattern: /overloaded/i, label: "overloaded" },
  { pattern: /request\s+too\s+large/i, label: "request_too_large" },
  { pattern: /payload\s+too\s+large/i, label: "payload_too_large" },
  // Repetitive loop: same 20+ char block repeated 5+ times
  { pattern: /(.{20,}?)\1{4,}/s, label: "repetitive_loop" },
];

/**
 * Check whether a response body appears to be a degraded response.
 * Iterates patterns in order, returns on first match.
 */
export function checkDegraded(responseBody: string): DegradedCheckResult {
  for (const { pattern, label } of DEGRADED_PATTERNS) {
    if (pattern.test(responseBody)) {
      return { isDegraded: true, matchedPattern: label };
    }
  }
  return { isDegraded: false, matchedPattern: null };
}
