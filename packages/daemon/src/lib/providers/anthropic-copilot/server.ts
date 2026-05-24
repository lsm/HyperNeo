/**
 * Embedded Anthropic-compatible HTTP server for GitHub Copilot.
 *
 * Starts a loopback HTTP server that implements the Anthropic messages API
 * (`POST /v1/messages`).  The Claude Agent SDK is pointed at this server via
 * `ANTHROPIC_BASE_URL` and communicates with it using the standard Anthropic
 * wire format — streaming, tool use, multi-turn — with no custom bridging.
 *
 * ## Request routing
 *
 *   POST /v1/messages   — Anthropic messages (streaming required)
 *   GET  /health        — Liveness probe
 *
 * ## Tool-use support
 *
 * When the request carries a `tools` array the server registers those tools as
 * Copilot SDK external tools.  When the model calls one of them:
 *
 *   1. A `tool_use` SSE block is emitted and the HTTP response is ended.
 *   2. The Copilot session remains alive — its tool handler is suspended.
 *   3. The next request (with `tool_result` messages) is routed to the same
 *      session via ConversationManager, which resumes the suspended handler.
 *
 * ## Session strategy
 *
 *   - No tools: new session per request (session-per-request model).
 *   - With tools: session reuse for tool-result continuation requests.
 *
 * The server uses one shared ConversationManager across all requests.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, normalize } from 'node:path';
import {
  approveAll,
  type CopilotClient,
  type ModelInfo,
  type SessionConfig,
} from '@github/copilot-sdk';
import { isAnthropicRequest, type AnthropicMessage, type AnthropicRequest } from './types.js';
import { formatAnthropicPrompt, extractSystemText, extractToolResultIds } from './prompt.js';
import { ConversationManager } from './conversation.js';
import { runSessionStreaming, resumeSessionStreaming } from './streaming.js';
import { ContextUsageStore, countTokensResponse, estimateRequestUsage } from './context-usage.js';
import { Logger } from '../../logger.js';
import { type AnthropicErrorType, createAnthropicErrorBody } from '../shared/error-envelope.js';

const logger = new Logger('anthropic-copilot-server');

/** Maximum request body size (10 MB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const FALLBACK_MODELS = [
  { id: 'claude-opus-4.6', display_name: 'Claude Opus 4.6', max_input_tokens: 200000 },
  { id: 'claude-sonnet-4.6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 200000 },
  { id: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', max_input_tokens: 272000 },
  { id: 'gpt-5.4', display_name: 'GPT-5.4', max_input_tokens: 272000 },
  { id: 'gpt-5.5', display_name: 'GPT-5.5', max_input_tokens: 272000 },
  { id: 'gpt-5-mini', display_name: 'GPT-5 Mini', max_input_tokens: 128000 },
  {
    id: 'gemini-3.1-pro-preview',
    display_name: 'Gemini 3.1 Pro Preview',
    max_input_tokens: 128000,
  },
] as const;

interface CountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: AnthropicRequest['system'];
  tools?: AnthropicRequest['tools'];
  tool_choice?: AnthropicRequest['tool_choice'];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;

    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(Object.assign(new Error('Request body too large'), { code: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  type: AnthropicErrorType,
  message: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(createAnthropicErrorBody(type, message));
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requestUsageKey(req: IncomingMessage, cwd: string, model: string): string {
  return `${resolveRequestCwd(req, cwd)}:${model}`;
}

function isCountTokensRequest(body: unknown): body is CountTokensRequest {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b['model'] === 'string' && Array.isArray(b['messages']);
}

function toAnthropicModel(model: ModelInfo): object {
  return {
    id: model.id,
    type: 'model',
    display_name: model.name,
    created_at: '2026-01-01T00:00:00Z',
    max_input_tokens: model.capabilities?.limits?.max_context_window_tokens ?? 128000,
    max_tokens: model.capabilities?.limits?.max_prompt_tokens ?? 16384,
  };
}

function modelsListResponse(models: object[]): object {
  const data = models.length > 0 ? models : FALLBACK_MODELS.map((m) => ({ ...m, type: 'model' }));
  return {
    data,
    has_more: false,
    first_id: (data[0] as { id: string }).id,
    last_id: (data[data.length - 1] as { id: string }).id,
  };
}

// ---------------------------------------------------------------------------
// Session config for non-tool requests
// ---------------------------------------------------------------------------

/**
 * Extract the per-request working directory from the `Authorization` header.
 *
 * `AnthropicToCopilotBridgeProvider.buildSdkConfig()` encodes the session workspace as
 * `anthropic-copilot-proxy:<path>` in `ANTHROPIC_AUTH_TOKEN`.  Parsing it here
 * lets the singleton embedded server apply the correct `cwd` per HTTP request
 * without rebuilding a new server for every session.
 */
/** @internal exported for unit tests only */
export function resolveRequestCwd(req: IncomingMessage, defaultCwd: string): string {
  const auth = (req.headers['authorization'] ?? '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const prefix = 'anthropic-copilot-proxy:';
  if (!token.startsWith(prefix)) return defaultCwd;
  const resolved = token.slice(prefix.length);
  if (!resolved || !isAbsolute(resolved)) return defaultCwd;
  // Normalise the path (collapses dot-dot segments). The value originates from
  // buildSdkConfig() which encodes the trusted workspacePath — no root boundary
  // enforcement is needed here.
  const normalised = normalize(resolved);
  return isAbsolute(normalised) ? normalised : defaultCwd;
}

function buildPlainSessionConfig(
  model: string,
  systemMessage: string | undefined,
  cwd: string
): SessionConfig {
  return {
    clientName: 'neokai-anthropic-copilot',
    model,
    streaming: true,
    infiniteSessions: { enabled: true },
    workingDirectory: cwd,
    // Restrict to no built-in tools — plain sessions have no caller-defined tools,
    // so Copilot's built-in bash/file tools must also be disabled.  Without this
    // the model may autonomously invoke built-in tools (hanging or returning only
    // tool-call content) instead of producing a text response.
    availableTools: [],
    ...(systemMessage
      ? { systemMessage: { mode: 'replace' as const, content: systemMessage } }
      : {}),
    onPermissionRequest: approveAll,
    onUserInputRequest: () =>
      Promise.resolve({
        answer: 'User input is not available. Ask your question in your response instead.',
        wasFreeform: true,
      }),
    hooks: {
      onPreToolUse: () => Promise.resolve({ permissionDecision: 'allow' as const }),
      onPostToolUse: () => {},
      onErrorOccurred: (input) => {
        const errorMsg = typeof input.error === 'string' ? input.error : String(input.error);
        logger.warn(
          `SDK error (${input.errorContext}, recoverable=${String(input.recoverable)}): ${errorMsg}`
        );
        // Do not retry quota/payment errors — they will not resolve with retries.
        const isQuotaError =
          errorMsg.includes('402') ||
          errorMsg.toLowerCase().includes('no quota') ||
          errorMsg.toLowerCase().includes('quota exceeded') ||
          errorMsg.toLowerCase().includes('insufficient_quota');
        if (
          !isQuotaError &&
          input.recoverable &&
          (input.errorContext === 'model_call' || input.errorContext === 'tool_execution')
        ) {
          return { errorHandling: 'retry' as const, retryCount: 2 };
        }
        return undefined;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  client: CopilotClient,
  manager: ConversationManager,
  contextUsageStore: ContextUsageStore,
  cwd: string
): Promise<void> {
  // 1. Read and parse body.
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    const status = (err as { code?: number }).code === 413 ? 413 : 400;
    sendJsonError(
      res,
      status,
      status === 413 ? 'request_too_large' : 'invalid_request_error',
      status === 413 ? 'Request body exceeds 10 MB limit' : 'Failed to read request body'
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJsonError(res, 400, 'invalid_request_error', 'Request body must be valid JSON');
    return;
  }

  if (!isAnthropicRequest(body)) {
    sendJsonError(
      res,
      400,
      'invalid_request_error',
      'Missing required fields: model, max_tokens, messages'
    );
    return;
  }

  if (body.stream === false) {
    sendJsonError(res, 400, 'invalid_request_error', 'Only streaming responses are supported');
    return;
  }

  if (body.tool_choice !== undefined) {
    logger.warn(
      `tool_choice is not supported by the Copilot SDK and will be ignored (received: ${JSON.stringify(body.tool_choice)})`
    );
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolResults = extractToolResultIds(body.messages).length > 0;

  // 2a. Tool-result continuation: resume a suspended session.
  // Note: the Anthropic spec does not require clients to re-send the `tools`
  // array on follow-up requests, so we check hasToolResults unconditionally.
  if (hasToolResults) {
    const continuation = manager.findContinuation(body.messages);
    if (continuation) {
      const { conv, toolResults } = continuation;
      const usageKey = requestUsageKey(req, cwd, body.model);
      // Remove routing entries and cancel the TTL timer before resuming.
      // Actual Promise resolution happens inside resumeSessionStreaming.
      manager.acknowledgeContinuation(
        conv,
        toolResults.map((r) => r.toolUseId)
      );
      try {
        const outcome = await resumeSessionStreaming(
          conv.session,
          body.model,
          req,
          res,
          conv.registry,
          toolResults,
          () => {
            // Intentionally empty: no extra action is needed when the
            // resumed session finishes.  If the model emits another
            // tool_use, setOnPendingToolCall already registered the new
            // tool call ID in the registry before onDone fires, so the
            // next HTTP request will route correctly without any help here.
            // Cleanup (cleanupConversation / releaseConversation) is handled
            // below based on the StreamingOutcome kind.
          },
          // Heuristic input_tokens for the continuation turn: the full
          // conversation history (system + all messages including tool results)
          // is re-serialised on every request, so we use that as the input text.
          (extractSystemText(body.system) ?? '') + formatAnthropicPrompt(body.messages),
          {
            store: contextUsageStore,
            requestKey: usageKey,
            outputTokenLimit: body.max_tokens,
          }
        );
        if (outcome.kind === 'completed') {
          // streamSession already called session.disconnect() — use
          // cleanupConversation (no disconnect) to avoid a double-disconnect.
          manager.cleanupConversation(conv);
        }
        // outcome.kind === 'tool_use': registry already registered the new
        // pending tool call ID so the next request will find the conversation.
      } catch (err) {
        logger.error('Error resuming conversation:', err);
        // Error path: streamSession may not have disconnected — releaseConversation
        // ensures the session is properly torn down.
        await manager.releaseConversation(conv);
        if (!res.headersSent) {
          sendJsonError(res, 500, 'api_error', 'Failed to resume session');
        }
      }
      return;
    }
    // No matching pending session — fall through to create a new one.
    // This can happen if the client re-sends a tool_result after the session
    // expired (TTL) or after a restart.
  }

  // 2b. New conversation (with or without tools).
  let prompt: string;
  try {
    prompt = formatAnthropicPrompt(body.messages);
  } catch (err) {
    sendJsonError(
      res,
      400,
      'invalid_request_error',
      err instanceof Error ? err.message : 'Prompt formatting failed'
    );
    return;
  }

  const systemMessage = extractSystemText(body.system);

  const requestCwd = resolveRequestCwd(req, cwd);
  if (hasTools) {
    await handleNewToolConversation(
      req,
      res,
      body,
      client,
      manager,
      contextUsageStore,
      systemMessage,
      prompt,
      requestCwd
    );
  } else {
    await handlePlainRequest(
      req,
      res,
      body,
      client,
      contextUsageStore,
      systemMessage,
      prompt,
      requestCwd
    );
  }
}

// ---------------------------------------------------------------------------
// New conversation — with tools (stateful session reuse)
// ---------------------------------------------------------------------------

async function handleNewToolConversation(
  req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicRequest,
  client: CopilotClient,
  manager: ConversationManager,
  contextUsageStore: ContextUsageStore,
  systemMessage: string | undefined,
  prompt: string,
  cwd: string
): Promise<void> {
  let conv;
  try {
    conv = await manager.createConversation(client, body.model, systemMessage, body.tools!, cwd);
  } catch (err) {
    logger.error(`Failed to create tool conversation for model '${body.model}':`, err);
    sendJsonError(
      res,
      500,
      'api_error',
      `Failed to create session for model '${body.model}'. ${err instanceof Error ? err.message : 'Internal error'}`
    );
    return;
  }

  try {
    const outcome = await runSessionStreaming(
      conv.session,
      prompt,
      body.model,
      req,
      res,
      conv.registry,
      () => {},
      (systemMessage ?? '') + prompt,
      {
        store: contextUsageStore,
        requestKey: requestUsageKey(req, cwd, body.model),
        outputTokenLimit: body.max_tokens,
      }
    );
    if (outcome.kind === 'completed') {
      // streamSession already called session.disconnect() — use
      // cleanupConversation (no disconnect) to avoid a double-disconnect.
      manager.cleanupConversation(conv);
    }
    // outcome.kind === 'tool_use': session stays alive, registry registered
    // the pending tool call ID — next request will find it.
  } catch (err) {
    logger.error('Streaming failed:', err);
    // Error path: releaseConversation ensures the session is disconnected.
    await manager.releaseConversation(conv);
    if (!res.headersSent) {
      sendJsonError(res, 500, 'api_error', err instanceof Error ? err.message : 'Internal error');
    }
  }
}

// ---------------------------------------------------------------------------
// Plain request — no tools (session-per-request)
// ---------------------------------------------------------------------------

async function handlePlainRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicRequest,
  client: CopilotClient,
  contextUsageStore: ContextUsageStore,
  systemMessage: string | undefined,
  prompt: string,
  cwd: string
): Promise<void> {
  const sessionConfig = buildPlainSessionConfig(body.model, systemMessage, cwd);

  let session;
  try {
    session = await client.createSession(sessionConfig);
  } catch (err) {
    logger.error(`Failed to create Copilot session for model '${body.model}':`, err);
    sendJsonError(
      res,
      500,
      'api_error',
      `Failed to create session for model '${body.model}'. ${err instanceof Error ? err.message : 'Internal error'}`
    );
    return;
  }

  try {
    await runSessionStreaming(
      session,
      prompt,
      body.model,
      req,
      res,
      undefined,
      () => {},
      (systemMessage ?? '') + prompt,
      {
        store: contextUsageStore,
        requestKey: requestUsageKey(req, cwd, body.model),
        outputTokenLimit: body.max_tokens,
      }
    );
  } catch (err) {
    logger.error('Streaming failed:', err);
    // Disconnect the session in case runSessionStreaming threw before its
    // internal finishCompleted() handler had a chance to run (resource leak guard).
    session.disconnect().catch(() => {});
    if (!res.headersSent) {
      sendJsonError(res, 500, 'api_error', err instanceof Error ? err.message : 'Internal error');
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic compatibility endpoints used by Claude Agent SDK context retrieval
// ---------------------------------------------------------------------------

async function handleCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  contextUsageStore: ContextUsageStore,
  cwd: string
): Promise<void> {
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    const status = (err as { code?: number }).code === 413 ? 413 : 400;
    sendJsonError(
      res,
      status,
      status === 413 ? 'request_too_large' : 'invalid_request_error',
      status === 413 ? 'Request body exceeds 10 MB limit' : 'Failed to read request body'
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJsonError(res, 400, 'invalid_request_error', 'Request body must be valid JSON');
    return;
  }

  if (!isCountTokensRequest(body)) {
    sendJsonError(res, 400, 'invalid_request_error', 'Missing required fields: model, messages');
    return;
  }

  const usageKey = requestUsageKey(req, cwd, body.model);
  const estimated = estimateRequestUsage({
    model: body.model,
    max_tokens: body.max_tokens ?? 0,
    messages: body.messages,
    system: body.system,
    tools: body.tools,
    tool_choice: body.tool_choice,
  });
  const latest = contextUsageStore.getForRequestKey(usageKey);
  sendJson(res, 200, countTokensResponse(estimated, latest ?? estimated));
}

async function handleModels(res: ServerResponse, client: CopilotClient): Promise<void> {
  try {
    const models = await client.listModels();
    sendJson(res, 200, modelsListResponse(models.map(toAnthropicModel)));
  } catch (err) {
    logger.warn('Failed to list Copilot models for /v1/models; using fallback metadata:', err);
    sendJson(res, 200, modelsListResponse([]));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbeddedServer {
  /** Base URL of the embedded server, e.g. `http://127.0.0.1:PORT` */
  readonly url: string;
  /** Gracefully stop the server (waits for in-flight requests to finish). */
  stop(): Promise<void>;
}

/**
 * Start an embedded Anthropic-compatible HTTP server backed by a Copilot SDK client.
 *
 * The server listens on a random loopback port (`127.0.0.1:0`).  Pass the
 * returned `url` as `ANTHROPIC_BASE_URL` when constructing a Claude Agent SDK
 * session so all API calls are routed through this server.
 *
 * @param client  Initialised `CopilotClient` to create sessions with.
 * @param cwd     Working directory for Copilot sessions (default: `process.cwd()`).
 */
export function startEmbeddedServer(
  client: CopilotClient,
  cwd = process.cwd()
): Promise<EmbeddedServer> {
  const manager = new ConversationManager();
  const contextUsageStore = new ContextUsageStore();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const method = req.method ?? '';

    if (method === 'POST' && (url === '/v1/messages' || url.startsWith('/v1/messages?'))) {
      handleMessages(req, res, client, manager, contextUsageStore, cwd).catch((err: unknown) => {
        logger.error('Unhandled error in handleMessages:', err);
        if (!res.headersSent) {
          sendJsonError(res, 500, 'api_error', 'Internal server error');
        }
      });
      return;
    }

    if (
      method === 'POST' &&
      (url === '/v1/messages/count_tokens' || url.startsWith('/v1/messages/count_tokens?'))
    ) {
      handleCountTokens(req, res, contextUsageStore, cwd).catch((err: unknown) => {
        logger.error('Unhandled error in handleCountTokens:', err);
        if (!res.headersSent) {
          sendJsonError(res, 500, 'api_error', 'Internal server error');
        }
      });
      return;
    }

    if (method === 'GET' && (url === '/v1/models' || url.startsWith('/v1/models?'))) {
      handleModels(res, client).catch((err: unknown) => {
        logger.error('Unhandled error in handleModels:', err);
        if (!res.headersSent) {
          sendJsonError(res, 500, 'api_error', 'Internal server error');
        }
      });
      return;
    }

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    sendJsonError(res, 404, 'not_found_error', 'Not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      logger.debug(`Embedded Anthropic server listening at ${url}`);

      resolve({
        url,
        stop: async () => {
          // Release all active tool-use conversations first so suspended
          // Promises are rejected and TTL timers are cleared before we
          // close the HTTP server.
          await manager.shutdown();
          return new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
                rej(err);
              } else {
                res();
              }
            });
            server.closeAllConnections?.();
          });
        },
      });
    });

    server.on('error', reject);
  });
}
