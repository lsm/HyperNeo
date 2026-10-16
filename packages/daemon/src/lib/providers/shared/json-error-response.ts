import type { ServerResponse } from 'node:http';
import { type AnthropicErrorType, createAnthropicErrorBody } from './error-envelope.js';

export function sendJsonError(
  status: number,
  type: AnthropicErrorType,
  message: string,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(createAnthropicErrorBody(type, message), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function sendRetryableUpstreamError(normalized: {
  type: AnthropicErrorType;
  status: number;
  message: string;
}): Response {
  return sendJsonError(normalized.status, normalized.type, normalized.message, {
    'x-should-retry': 'true',
  });
}

export function sendNodeJsonError(
  res: ServerResponse,
  status: number,
  type: AnthropicErrorType,
  message: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(createAnthropicErrorBody(type, message));
}
