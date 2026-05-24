/**
 * Anthropic messages API wire types used by the embedded proxy server.
 *
 * Keeping these inline avoids a hard dependency on the `@anthropic-ai/sdk`
 * package on the daemon side.
 */

// ---------------------------------------------------------------------------
// Content block types
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | TextBlock[];
  /** When `true` the tool call failed; the model should be informed. */
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// ---------------------------------------------------------------------------
// Tool definition (from the API caller)
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input parameters. */
  input_schema: Record<string, unknown>;
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | TextBlock[];
  stream?: boolean;
  tools?: AnthropicTool[];
  /**
   * Accepted for API compatibility but not forwarded to the Copilot SDK —
   * the SDK does not expose tool-choice control.
   */
  tool_choice?: ToolChoice;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isAnthropicRequest(body: unknown): body is AnthropicRequest {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b['model'] === 'string' &&
    typeof b['max_tokens'] === 'number' &&
    Array.isArray(b['messages'])
  );
}
