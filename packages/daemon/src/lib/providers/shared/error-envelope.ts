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

/** Anthropic API error type discriminators. */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'not_implemented_error'
  | 'api_error'
  | 'overloaded_error';

/**
 * Serialize an Anthropic-format error envelope as a JSON string.
 *
 * Use as the body of HTTP non-2xx responses from bridge servers.
 */
export function createAnthropicErrorBody(errorType: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type: errorType, message } });
}
