import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import { anthropicErrorTypeForHttpStatus } from '@hyperneo/shared/provider/error-taxonomy';
import { isJsonContentType, normalizeUpstreamError } from '../shared/normalize-upstream-error.js';
import { Logger } from '../../logger.js';
import type { AnthropicRequest } from '../provider-anthropic-compat/translator.js';

const logger = new Logger('anthropic-messages-bridge-server');

type SessionThinkingConfig = { type: 'enabled'; budget_tokens: number } | undefined;

export type AnthropicMessagesBridgeServer = {
  port: number;
  stop(): void;
  setSessionThinkingConfig?(sessionId: string, thinking: SessionThinkingConfig): void;
};

export type AnthropicMessagesBridgeModel = {
  id: string;
  display_name: string;
  context_window: number;
  max_tokens?: number;
};

export type AnthropicMessagesBridgeConfig = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  models?: AnthropicMessagesBridgeModel[];
};

function sendJsonError(
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

function sendRetryableUpstreamError(normalized: {
  type: AnthropicErrorType;
  status: number;
  message: string;
}): Response {
  return sendJsonError(normalized.status, normalized.type, normalized.message, {
    'x-should-retry': 'true',
  });
}

export function buildUpstreamUrl(
  input: string,
  suffix: string,
  stripSuffixes: string[] = []
): string {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error(
      `Anthropic-messages baseUrl is not a valid URL: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  const candidates = [suffix, ...stripSuffixes].sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const pattern = new RegExp(`${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const next = path.replace(pattern, '');
    if (next !== path) {
      path = next;
      break;
    }
  }
  parsed.pathname = `${path}${suffix}`;
  return parsed.toString();
}

function extractSessionIdFromRequest(req: Request): string | undefined {
  for (const headerName of ['Authorization', 'x-api-key']) {
    const value = req.headers.get(headerName);
    if (!value) continue;
    const token = value.startsWith('Bearer ') ? value.slice(7) : value;
    if (token.startsWith('custom-endpoint:')) {
      return token.slice('custom-endpoint:'.length);
    }
  }
  return undefined;
}

function enforceThinking(bodyBytes: ArrayBuffer, desired: SessionThinkingConfig): ArrayBuffer {
  const text = new TextDecoder().decode(bodyBytes);
  const body: Partial<AnthropicRequest> = JSON.parse(text);
  if (desired === undefined) {
    delete body.thinking;
  } else {
    body.thinking = desired;
  }
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

export function createAnthropicMessagesBridgeServer(
  config: AnthropicMessagesBridgeConfig
): AnthropicMessagesBridgeServer {
  const fetchImpl = config.fetchImpl ?? fetch;
  const messagesUrl = buildUpstreamUrl(config.baseUrl, '/v1/messages', [
    '/v1/messages/count_tokens',
  ]);
  const countTokensUrl = buildUpstreamUrl(config.baseUrl, '/v1/messages/count_tokens', [
    '/v1/messages',
  ]);

  const sessionThinking = new Map<string, SessionThinkingConfig>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/health' || url.pathname === '/v1/health') return new Response('ok');
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        if (config.models?.length) {
          const data = config.models.map((model) => ({
            id: model.id,
            type: 'model',
            display_name: model.display_name,
            context_window: model.context_window,
            max_context_window: model.context_window,
            model_context_window: model.context_window,
            max_input_tokens: model.context_window,
            max_tokens: model.max_tokens ?? 16384,
          }));
          return new Response(JSON.stringify({ data, has_more: false }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            data: [{ id: 'default', type: 'model', display_name: 'Custom Anthropic Endpoint' }],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      const isMessages = url.pathname === '/v1/messages' && req.method === 'POST';
      const isCountTokens = url.pathname === '/v1/messages/count_tokens' && req.method === 'POST';
      if (!isMessages && !isCountTokens) {
        return sendJsonError(501, 'api_error', 'Not implemented');
      }

      let bodyBytes: ArrayBuffer;
      try {
        bodyBytes = await req.arrayBuffer();
      } catch {
        return sendJsonError(400, 'invalid_request_error', 'Bad Request');
      }

      const sessionId = extractSessionIdFromRequest(req);
      if (sessionId && sessionThinking.has(sessionId)) {
        const desired = sessionThinking.get(sessionId);
        bodyBytes = enforceThinking(bodyBytes, desired);
      }

      const target = isMessages ? messagesUrl : countTokensUrl;
      const forwardedAnthropicHeaders: Record<string, string> = {};
      for (const [name, value] of req.headers.entries()) {
        if (name.toLowerCase().startsWith('anthropic-')) {
          forwardedAnthropicHeaders[name] = value;
        }
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...forwardedAnthropicHeaders,
        ...(config.apiKey
          ? {
              'x-api-key': config.apiKey,
              Authorization: `Bearer ${config.apiKey}`,
            }
          : {}),
        ...config.headers,
      };

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchImpl(target, {
          method: 'POST',
          headers,
          body: bodyBytes,
        });
      } catch (error) {
        return sendJsonError(
          502,
          'api_error',
          error instanceof Error ? error.message : 'Upstream Anthropic request failed'
        );
      }

      if (!upstreamResponse.ok) {
        const text = await upstreamResponse.text();
        const normalized = normalizeUpstreamError(text, upstreamResponse.status);
        if (normalized) {
          logger.warn(
            `anthropic-messages-bridge: normalized upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        return sendJsonError(
          upstreamResponse.status,
          anthropicErrorTypeForHttpStatus(upstreamResponse.status),
          text || `Upstream returned HTTP ${upstreamResponse.status}`
        );
      }

      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
      const isJsonBody = isJsonContentType(upstreamContentType);
      if (upstreamResponse.ok && isJsonBody && (isMessages || isCountTokens)) {
        const bodyText = await upstreamResponse.text();
        const normalized = normalizeUpstreamError(bodyText, upstreamResponse.status);
        if (normalized) {
          logger.warn(
            `anthropic-messages-bridge: normalized 200-with-body upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        return new Response(bodyText, {
          status: upstreamResponse.status,
          headers: {
            'Content-Type': upstreamContentType || 'application/json',
          },
        });
      }

      const responseHeaders = new Headers();
      const contentType =
        upstreamResponse.headers.get('content-type') ??
        (isMessages ? 'text/event-stream' : 'application/json');
      responseHeaders.set('Content-Type', contentType);
      if (contentType.includes('event-stream')) {
        responseHeaders.set('Cache-Control', 'no-cache');
        responseHeaders.set('Connection', 'keep-alive');
      }
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    },
  });

  const port = server.port;
  if (typeof port !== 'number')
    throw new Error('Anthropic-messages bridge server did not bind to a TCP port');
  logger.info(`anthropic-messages-bridge: HTTP server listening on port ${port}`);

  return {
    port,
    stop: () => server.stop(true),
    setSessionThinkingConfig(sessionId: string, thinking: SessionThinkingConfig) {
      sessionThinking.set(sessionId, thinking);
    },
  };
}
