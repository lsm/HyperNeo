/**
 * Prompt formatter — converts Anthropic messages array to a flat prompt string
 * suitable for sending to a Copilot session.
 *
 * Adapted from copilot-sdk-proxy/claude/prompt.ts (MIT).
 */

import type {
  AnthropicMessage,
  ContentBlock,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isImageBlock(block: TextBlock | ImageBlock): block is ImageBlock {
  return block.type === 'image';
}

export function ensureNoImageBlocks(messages: AnthropicMessage[]): void {
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'image') {
        throw new Error('Copilot bridge does not support image content blocks');
      }
      if (
        block.type === 'tool_result' &&
        Array.isArray(block.content) &&
        block.content.some(isImageBlock)
      ) {
        throw new Error('Copilot bridge does not support image content blocks');
      }
    }
  }
}

function extractToolResultText(
  content: string | Array<TextBlock | ImageBlock> | undefined
): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (content.some(isImageBlock)) {
    throw new Error('Copilot bridge does not support image content blocks');
  }
  return content.map((b) => (b as TextBlock).text).join('\n');
}

function formatBlocks(blocks: ContentBlock[], role: 'user' | 'assistant', parts: string[]): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue;
      parts.push(role === 'user' ? `[User]: ${block.text}` : `[Assistant]: ${block.text}`);
    } else if (block.type === 'thinking') {
      // Skip thinking blocks — they are internal reasoning, not conversation turns.
      // The Copilot SDK does not support extended thinking, so these blocks are
      // never emitted by the model and should not be forwarded to the prompt.
    } else if (block.type === 'tool_use') {
      parts.push(`[Assistant called tool ${block.name} with args: ${JSON.stringify(block.input)}]`);
    } else if (block.type === 'tool_result') {
      const r = block as ToolResultBlock;
      const prefix = r.is_error ? '[Tool error for' : '[Tool result for';
      parts.push(`${prefix} ${r.tool_use_id}]: ${extractToolResultText(r.content)}`);
    } else if (block.type === 'image') {
      throw new Error('Copilot bridge does not support image content blocks');
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Flatten an Anthropic messages array into a single prompt string.
 *
 * Each turn is prefixed with `[User]:` or `[Assistant]:`.
 * Tool-use and tool-result blocks are inlined as human-readable annotations so
 * a fresh Copilot session can continue the conversation with full context.
 *
 * **Limitation**: the Copilot SDK accepts a single flat prompt string, not a
 * structured message array.  Multi-turn history is therefore re-serialised as
 * plain text on every request.  This is adequate for most conversational
 * patterns but means the model receives a slightly different representation
 * than a native Anthropic API call would provide (e.g. no per-turn token
 * accounting, no vision content, no extended-thinking blocks).
 */
export function formatAnthropicPrompt(messages: AnthropicMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.role === 'user' ? `[User]: ${msg.content}` : `[Assistant]: ${msg.content}`);
    } else {
      formatBlocks(msg.content, msg.role, parts);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract the plain text from an Anthropic `system` field.
 * Returns `undefined` when the system message is empty or absent.
 */
export function extractSystemText(system: string | TextBlock[] | undefined): string | undefined {
  if (system == null) return undefined;
  if (typeof system === 'string') return system || undefined;
  const text = system
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  return text || undefined;
}

/**
 * Extract all `tool_use_id` values from `tool_result` blocks in the messages.
 * Used to find which pending conversation a follow-up request belongs to.
 */
export function extractToolResultIds(messages: AnthropicMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        ids.push((block as ToolResultBlock).tool_use_id);
      }
    }
  }
  return ids;
}

/**
 * Extract the `is_error` flag for a specific `tool_use_id` from messages.
 * Returns `false` if not found or flag is absent.
 */
export function extractToolResultIsError(messages: AnthropicMessage[], toolUseId: string): boolean {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue;
      const r = block as ToolResultBlock;
      if (r.tool_use_id !== toolUseId) continue;
      return r.is_error === true;
    }
  }
  return false;
}

/**
 * Extract the tool-result text for a specific `tool_use_id` from messages.
 * Returns `undefined` if not found.
 */
export function extractToolResultContent(
  messages: AnthropicMessage[],
  toolUseId: string
): string | undefined {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue;
      const r = block as ToolResultBlock;
      if (r.tool_use_id !== toolUseId) continue;
      return extractToolResultText(r.content);
    }
  }
  return undefined;
}
