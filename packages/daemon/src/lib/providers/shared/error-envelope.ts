/**
 * Shared Anthropic-format error helpers for bridge HTTP servers.
 *
 * Both the copilot bridge and codex bridge servers must return errors in the
 * same format as the real Anthropic Messages API so the Claude Agent SDK can
 * surface them correctly.
 *
 * ## HTTP error format
 *
 *   { "type": "error", "error": { "type": "<errorType>", "message": "..." } }
 *
 * ## SSE error format (streaming responses)
 *
 *   event: error
 *   data: {"type":"error","error":{"type":"<errorType>","message":"..."}}
 */

import type { AnthropicErrorType } from '@hyperneo/shared/provider/error-taxonomy';

/** Anthropic API error type discriminators. */
export type { AnthropicErrorType };

/**
 * Serialize an Anthropic-format error envelope as a JSON string.
 *
 * Use as the body of HTTP non-2xx responses from bridge servers.
 */
export function createAnthropicErrorBody(errorType: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type: errorType, message } });
}
