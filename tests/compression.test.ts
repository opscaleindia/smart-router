/**
 * Compression Pipeline Tests
 *
 * Run: node --import tsx tests/compression.test.ts
 */

import assert from "node:assert";
import { compressContext, shouldCompress } from "../src/compression/index.js";
import { deduplicateMessages } from "../src/compression/layers/deduplication.js";
import { normalizeMessagesWhitespace } from "../src/compression/layers/whitespace.js";
import { compactMessagesJson } from "../src/compression/layers/json-compact.js";
import type { NormalizedMessage } from "../src/compression/types.js";

console.log("🧪 Running compression tests...\n");

// shouldCompress threshold
{
  const small: NormalizedMessage[] = [
    { role: "user", content: "Hello" },
  ];
  assert.strictEqual(shouldCompress(small), false);

  const large: NormalizedMessage[] = [
    { role: "user", content: "x".repeat(6000) },
  ];
  assert.strictEqual(shouldCompress(large), true);
  console.log("✅ shouldCompress threshold works");
}

// Layer 1: Deduplication
{
  const messages: NormalizedMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "assistant", content: "Hello, how can I help?" },
    { role: "assistant", content: "Hello, how can I help?" }, // duplicate
    { role: "user", content: "What is 2+2?" },
    { role: "user", content: "What is 2+2?" }, // user dupes kept
  ];
  const result = deduplicateMessages(messages);
  assert.strictEqual(result.duplicatesRemoved, 1);
  assert.strictEqual(result.messages.length, 4);
  // System, first assistant, user, user (user dupes preserved)
  assert.strictEqual(result.messages[0].role, "system");
  assert.strictEqual(result.messages[1].role, "assistant");
  assert.strictEqual(result.messages[2].role, "user");
  assert.strictEqual(result.messages[3].role, "user");
  console.log("✅ Layer 1: Deduplication removes duplicate assistant messages");
}

// Layer 1: Tool call pairing preserved
{
  const messages: NormalizedMessage[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
    },
    { role: "tool", content: "file contents", tool_call_id: "tc1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc2", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
    },
    { role: "tool", content: "file contents", tool_call_id: "tc2" },
  ];
  const result = deduplicateMessages(messages);
  // Both assistant+tool pairs should be preserved (referenced tool_calls)
  assert.strictEqual(result.messages.length, 4);
  assert.strictEqual(result.duplicatesRemoved, 0);
  console.log("✅ Layer 1: Tool call pairing preserved");
}

// Layer 2: Whitespace normalization
{
  const messages: NormalizedMessage[] = [
    { role: "user", content: "Hello\n\n\n\nWorld\t\there   spaces" },
  ];
  const result = normalizeMessagesWhitespace(messages);
  assert.ok(result.charsSaved > 0);
  const content = result.messages[0].content as string;
  assert.ok(!content.includes("\n\n\n"));
  assert.ok(!content.includes("\t"));
  console.log("✅ Layer 2: Whitespace normalization reduces chars");
}

// Layer 5: JSON compaction
{
  const messages: NormalizedMessage[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "tc1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({ path: "/a", content: "hello" }, null, 2),
        },
      }],
    },
    {
      role: "tool",
      content: JSON.stringify({ status: "ok", count: 42 }, null, 2),
      tool_call_id: "tc1",
    },
  ];
  const result = compactMessagesJson(messages);
  assert.ok(result.charsSaved > 0);
  // Tool content should be minified
  const toolContent = result.messages[1].content as string;
  assert.ok(!toolContent.includes("\n"));
  console.log("✅ Layer 5: JSON compaction saves chars");
}

// Full pipeline with default config
{
  const messages: NormalizedMessage[] = [
    { role: "system", content: "You are helpful.  Extra  spaces here." },
    { role: "assistant", content: "I will help you." },
    { role: "assistant", content: "I will help you." }, // duplicate
    { role: "user", content: "x".repeat(5100) },
  ];
  const result = await compressContext(messages);
  assert.ok(result.compressionRatio <= 1);
  assert.ok(result.stats.duplicatesRemoved >= 1);
  assert.ok(result.stats.whitespaceSavedChars >= 0);
  assert.strictEqual(result.originalMessages.length, 4);
  console.log("✅ Full pipeline with default config works");
}

// Multimodal safety — arrays not corrupted
{
  const messages: NormalizedMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      ],
    },
  ];
  const result = await compressContext(messages);
  // Content should still be an array
  assert.ok(Array.isArray(result.messages[0].content));
  console.log("✅ Multimodal messages not corrupted");
}

// Codebook header placement — first user message, not system
{
  const messages: NormalizedMessage[] = [
    { role: "system", content: "System prompt" },
    { role: "user", content: 'This has "type": "string" and "type": "object" repeated' },
  ];
  const result = await compressContext(messages, {
    layers: {
      deduplication: false,
      whitespace: false,
      dictionary: true,
      paths: false,
      jsonCompact: false,
      observation: false,
      dynamicCodebook: false,
    },
    dictionary: { maxEntries: 50, minPhraseLength: 15, includeCodebookHeader: true },
  });
  // System message should NOT contain [Dict: ...]
  const sysContent = result.messages[0].content as string;
  assert.ok(!sysContent.includes("[Dict:"), "Codebook should not be in system message");
  console.log("✅ Codebook header placed in user message, not system");
}

// Disabled config passthrough
{
  const messages: NormalizedMessage[] = [
    { role: "user", content: "Hello world " + "x".repeat(5000) },
  ];
  const result = await compressContext(messages, { enabled: false });
  assert.strictEqual(result.compressionRatio, 1);
  assert.strictEqual(result.stats.duplicatesRemoved, 0);
  console.log("✅ Disabled config returns unmodified messages");
}

console.log("\n🎉 All compression tests passed!\n");
