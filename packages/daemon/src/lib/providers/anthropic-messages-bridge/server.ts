/**
 * Anthropic Messages Pass-Through Bridge — HTTP Server
 *
 * Hosts a local HTTP endpoint that the Claude Agent SDK can target via
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and forwards the request body
 * verbatim to a user-configured Anthropic-compatible upstream
 * (`<baseUrl>/v1/messages`). The body is already Anthropic Messages format,
 * so there is no translation layer — we only:
 *
 *   1. Append `/v1/messages` (or the user-declared chat path) to the base URL,
 *      preserving any query string.
 *   2. Forward the request body bytes (no JSON re-encode — we mustn't lose
 *      fields the SDK adds that this bridge doesn't model).
 *   3. Forward auth: when a user-supplied `apiKey` is configured, attach
 *      `x-api-key` and `Authorization: Bearer ...` (mirrors what most
 *      Anthropic-compatible proxies accept). Custom `headers` win over both.
 *   4. Pass through streaming SSE response bytes 1:1 — the upstream already
 *      emits the right framing.
 *
 * Use cases: Bedrock fronts, self-hosted Anthropic-shim servers (LiteLLM in
 * Anthropic mode, claude-code-router, etc.), custom Claude gateways.
 */

import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import { normalizeUpstreamError } from '../shared/normalize-upstream-error.js';
import { Logger } from '../../logger.js';

const logger = new Logger('anthropic-messages-bridge-server');

export type AnthropicMessagesBridgeServer = {
  port: number;
  stop(): void;
};

/** Model metadata returned by the bridge's `/v1/models` endpoint. */
export type AnthropicMessagesBridgeModel = {
  id: string;
  display_name: string;
  /** Context window in tokens — the bridge reports this to the SDK so it knows
   * the real limit instead of falling back to a hardcoded default. */
  context_window: number;
  max_tokens?: number;
};

export type AnthropicMessagesBridgeConfig = {
  /** Upstream base URL, e.g. `https://api.example.com` or `.../anthropic`. */
  baseUrl: string;
  /**
   * Optional API key forwarded as both `x-api-key` and
   * `Authorization: Bearer <key>` so most Anthropic-compatible proxies
   * accept it regardless of which header they check.
   */
  apiKey?: string;
  /** Extra HTTP headers attached to every upstream request. Wins over auth. */
  headers?: Record<string, string>;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Optional model metadata for `/v1/models`. When provided, the bridge
   * returns context window information so the SDK uses the correct limit
   * instead of falling back to its hardcoded default (~200 k tokens).
   * Without this, `/v1/models` returns a minimal stub.
   */
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

/**
 * Emit a normalized retryable upstream error. Sets `x-should-retry: true` so the
 * retry intent is explicit (the Claude Agent SDK already retries on 429 / >=500
 * status, and honours this header as a belt-and-braces override).
 */
function sendRetryableUpstreamError(normalized: {
  type: AnthropicErrorType;
  status: number;
  message: string;
}): Response {
  return sendJsonError(normalized.status, normalized.type, normalized.message, {
    'x-should-retry': 'true',
  });
}

function mapUpstreamStatus(status: number): AnthropicErrorType {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/**
 * Build the upstream URL by appending `<suffix>` to the parsed base URL's
 * pathname while preserving any query string. Mirrors the helper used by the
 * OpenAI chat bridge — see `openai-chat-bridge/server.ts#buildChatCompletionsUrl`.
 *
 * `stripSuffixes` lets the caller pass extra candidate suffixes to strip from
 * the existing pathname before appending the target suffix. This is used by
 * the count_tokens URL builder to handle the case where a user pasted a
 * baseUrl that already ends in `/v1/messages` — without it, the count_tokens
 * URL would become `/v1/messages/v1/messages/count_tokens`.
 */
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
  // Strip trailing slashes plus any candidate suffix the user may have pasted,
  // then re-append the target suffix exactly once. Order matters: try the
  // longest suffix first so we don't leave behind a tail like `/count_tokens`.
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

export function createAnthropicMessagesBridgeServer(
  config: AnthropicMessagesBridgeConfig
): AnthropicMessagesBridgeServer {
  const fetchImpl = config.fetchImpl ?? fetch;
  const messagesUrl = buildUpstreamUrl(config.baseUrl, '/v1/messages', [
    '/v1/messages/count_tokens',
  ]);
  // Build count_tokens by stripping the shorter `/v1/messages` suffix first
  // so a baseUrl like `https://api.example.com/v1/messages` produces
  // `.../v1/messages/count_tokens` instead of `.../v1/messages/v1/messages/count_tokens`.
  const countTokensUrl = buildUpstreamUrl(config.baseUrl, '/v1/messages/count_tokens', [
    '/v1/messages',
  ]);

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

      // Both POST /v1/messages and POST /v1/messages/count_tokens are pure
      // pass-throughs. Forward the body bytes unchanged.
      const isMessages = url.pathname === '/v1/messages' && req.method === 'POST';
      const isCountTokens = url.pathname === '/v1/messages/count_tokens' && req.method === 'POST';
      if (!isMessages && !isCountTokens) {
        return sendJsonError(501, 'api_error', 'Not implemented');
      }

      // Use ArrayBuffer to preserve byte-for-byte fidelity (avoid a
      // JSON.parse → re-stringify trip that would drop unknown fields
      // or alter floating-point precision in usage numbers).
      let bodyBytes: ArrayBuffer;
      try {
        bodyBytes = await req.arrayBuffer();
      } catch {
        return sendJsonError(400, 'invalid_request_error', 'Bad Request');
      }

      const target = isMessages ? messagesUrl : countTokensUrl;
      // Forward every `anthropic-*` request header the SDK sent so that
      // request-scoped behaviours (e.g. `anthropic-beta` enabling betas
      // declared via the query options builder, `anthropic-dangerous-*`,
      // future header-gated features) reach the upstream. Without this,
      // requests are not semantically equivalent after crossing the
      // bridge and beta-gated SDK features silently regress.
      const forwardedAnthropicHeaders: Record<string, string> = {};
      for (const [name, value] of req.headers.entries()) {
        if (name.toLowerCase().startsWith('anthropic-')) {
          forwardedAnthropicHeaders[name] = value;
        }
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // Default anthropic-version when the SDK didn't send one. The
        // per-header copy above wins when present.
        'anthropic-version': '2023-06-01',
        ...forwardedAnthropicHeaders,
        ...(config.apiKey
          ? {
              'x-api-key': config.apiKey,
              Authorization: `Bearer ${config.apiKey}`,
            }
          : {}),
        // User-supplied headers win over both auth and forwarded
        // `anthropic-*` headers so an integrator can override the auth
        // header name (e.g. `x-custom-auth`) or pin a specific
        // `anthropic-version` regardless of what the SDK sent.
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
        // Inspect the BODY for provider-specific transient signals (GLM code
        // 1305, 访问量过大, 稍后再试, …) that the status alone cannot convey. A
        // 4xx carrying an overload code must be reclassified as retryable so the
        // SDK retries instead of surfacing a terminal invalid_request_error.
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
          mapUpstreamStatus(upstreamResponse.status),
          text || `Upstream returned HTTP ${upstreamResponse.status}`
        );
      }

      // GLM and some Anthropic-compatible shims return 200 with a JSON error
      // body (content-type application/json) instead of an SSE stream — the
      // status gives the SDK nothing to retry on. When the body is not an event
      // stream, buffer it and inspect for a body-embedded transient error; if
      // found, re-emit as a retryable non-2xx response so the SDK retries. A
      // genuine SSE stream is still passed through byte-for-byte below. Covers
      // both /v1/messages and /v1/messages/count_tokens (GLM can return the
      // same overload body for either).
      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
      const isEventStream = upstreamContentType.includes('text/event-stream');
      if (upstreamResponse.ok && !isEventStream && (isMessages || isCountTokens)) {
        const bodyText = await upstreamResponse.text();
        const normalized = normalizeUpstreamError(bodyText, upstreamResponse.status);
        if (normalized) {
          logger.warn(
            `anthropic-messages-bridge: normalized 200-with-body upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        // Not a recognized transient error. Re-wrap the buffered bytes unchanged
        // so we neither break valid non-streaming responses nor hide unknown
        // errors from the SDK.
        return new Response(bodyText, {
          status: upstreamResponse.status,
          headers: {
            'Content-Type': upstreamContentType || 'application/json',
          },
        });
      }

      // Pass the body stream through unchanged. The upstream is already
      // emitting valid Anthropic SSE framing (or JSON for count_tokens).
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
  };
}
