/**
 * LLM-Safe Context Compression Types
 *
 * Types for the 7-layer compression system that reduces token usage
 * while preserving semantic meaning for LLM queries.
 */

// Content part for multimodal messages (images, etc.)
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

// Normalized message structure (matches OpenAI format)
// Note: content can be an array for multimodal messages (images, etc.)
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// Compression statistics
export interface CompressionStats {
  duplicatesRemoved: number;
  whitespaceSavedChars: number;
  dictionarySubstitutions: number;
  pathsShortened: number;
  jsonCompactedChars: number;
  observationsCompressed: number;
  observationCharsSaved: number;
  dynamicSubstitutions: number;
  dynamicCharsSaved: number;
}

// Result from compression
export interface CompressionResult {
  messages: NormalizedMessage[];
  originalMessages: NormalizedMessage[];

  // Token estimates
  originalChars: number;
  compressedChars: number;
  compressionRatio: number; // 0.85 = 15% reduction

  // Per-layer stats
  stats: CompressionStats;

  // Codebook used (for decompression in logs)
  codebook: Record<string, string>;
  pathMap: Record<string, string>;
  dynamicCodes: Record<string, string>;
}
