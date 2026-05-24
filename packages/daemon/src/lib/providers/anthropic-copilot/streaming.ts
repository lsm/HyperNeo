/**
 * Copilot session streaming — converts Copilot SDK session events to Anthropic SSE.
 *
 * Two entry points:
 *
 *   runSessionStreaming()    — starts a new conversation turn (calls session.send).
 *   resumeSessionStreaming() — resumes after tool results are delivered (no new send).
 *
 * Both return a `StreamingOutcome` indicating whether the conversation is fully
 * done or suspended waiting for more tool results.
 *
 * ## Tool-use flow
 *
 * When the Copilot model calls an external tool registered via `SessionConfig.tools`:
 *
 * 1. The tool handler calls `registry.emitToolUseAndWait()`.
 * 2. `emitToolUseAndWait` writes the tool_use SSE block, calls `res.end()`, and
 *    notifies this module via `registry.setOnToolUseEmitted()`.
 * 3. This module sees the notification, unsubscribes from session events, and
 *    resolves the returned Promise with `{ kind: 'tool_use' }`.
 * 4. The HTTP request handler returns — the session stays alive in the background.
 * 5. The next HTTP request (with tool_result) calls `resumeSessionStreaming()`.
 *
 * ## Bun note
 *
 * `req.on('close')` is used instead of `res.on('close')` for client-disconnect
 * detection.  Bun's node:http does not fire `res.on('close')` after the POST
 * body has been consumed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import type { ToolBridgeRegistry } from './tool-bridge.js';
import type { ToolResult } from './conversation.js';
import { AnthropicStreamWriter, estimateTokens } from './sse.js';
import type { ContextUsageStore, CopilotUsageInfoData } from './context-usage.js';
import { type AnthropicErrorType, createAnthropicErrorBody } from '../shared/error-envelope.js';
import { Logger } from '../../logger.js';

const logger = new Logger('anthropic-copilot-streaming');

/** Per-request streaming timeout (ms). Fires if neither session.idle nor session.error arrives. */
export const STREAMING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamingOutcome =
  /** Session done — session.disconnect() was called. */
  | { kind: 'completed' }
  /**
   * Tool-use emitted — session alive, waiting for tool_result.
   *
   * `toolCallIds` contains ALL tool call IDs emitted in this turn.  For
   * single-tool responses it has one element; for parallel tool calls it has
   * multiple.  The `ConversationManager` routes the next request by any of
   * these IDs — the caller does not need to enumerate them.
   */
  | { kind: 'tool_use'; toolCallIds: string[] };

export interface StreamingContextUsageOptions {
  store: ContextUsageStore;
  requestKey: string;
  outputTokenLimit?: number;
}

function classifyError(message: string): { status: number; type: AnthropicErrorType } {
  const status = Number(message.match(/\b([45]\d{2})\b/)?.[1] ?? 500);
  if (status === 401 || status === 403) return { status, type: 'authentication_error' };
  if (status === 402 || status === 429) return { status, type: 'rate_limit_error' };
  if (status === 400) return { status, type: 'invalid_request_error' };
  if (status === 404) return { status, type: 'not_found_error' };
  if (status === 413) return { status, type: 'request_too_large' };
  if (status === 529) return { status, type: 'overloaded_error' };
  return { status, type: 'api_error' };
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

// ---------------------------------------------------------------------------
// Shared streaming core
// ---------------------------------------------------------------------------

/**
 * Internal streaming loop shared by both entry points.
 *
 * @param session    Active Copilot session.
 * @param model      Model ID to include in `message_start`.
 * @param req        Current HTTP request (for disconnect detection).
 * @param res        Current HTTP response (SSE is written here).
 * @param registry   ToolBridgeRegistry when the request has tools, else undefined.
 * @param startFn    Called after the event subscription is set up.
 *                   For new turns: calls `session.send(prompt)`.
 *                   For continuations: resolves tool results.
 *                   Receives `finishCompleted` and `writeFailed` as arguments so
 *                   async failures (e.g. session.send() rejection) can emit a
 *                   well-formed SSE epilogue using the original writer state.
 * @param onDone     Called when the session is done (before disconnect).
 */
function streamSession(
  session: CopilotSession,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry: ToolBridgeRegistry | undefined,
  startFn: (finish: () => void, writeFailed: () => void) => void,
  onDone: () => void,
  /** Raw input text used for heuristic token estimation (system prompt + formatted messages). */
  inputText = '',
  contextUsage?: StreamingContextUsageOptions
): Promise<StreamingOutcome> {
  const writer = new AnthropicStreamWriter();
  writer.configure(model, estimateTokens(inputText.length));

  let sessionDone = false;
  let pendingDeltas: string[] = [];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  function flushDeltas(): void {
    if (pendingDeltas.length === 0) return;
    writer.flushDeltas(res, pendingDeltas);
    pendingDeltas = [];
  }

  const { promise, resolve } = Promise.withResolvers<StreamingOutcome>();

  function finishCompleted(): void {
    if (sessionDone) return;
    sessionDone = true;
    clearTimeout(timeoutHandle);
    unsubscribe();
    registry?.clearActiveResponse();
    onDone();
    session.disconnect().catch(() => {});
    resolve({ kind: 'completed' });
  }

  function finishToolUse(toolCallIds: string[]): void {
    if (sessionDone) return;
    // Mark done so the req.on('close') handler does not abort the session.
    sessionDone = true;
    clearTimeout(timeoutHandle);
    unsubscribe();
    // Do NOT disconnect — session is still alive waiting for tool_result.
    resolve({ kind: 'tool_use', toolCallIds });
  }

  // Set active response on registry so tool handlers can write SSE.
  if (registry) {
    registry.setActiveResponse(writer, res);
    registry.setOnToolUseEmitted(finishToolUse);
  }

  const unsubscribe = session.on((event: SessionEvent) => {
    switch (event.type) {
      case 'assistant.message_delta':
        if (typeof event.data.deltaContent === 'string' && event.data.deltaContent)
          pendingDeltas.push(event.data.deltaContent);
        break;

      case 'assistant.message':
        // Fallback: if the SDK delivered the full response without any
        // preceding assistant.message_delta events (valid Copilot SDK
        // behaviour), capture it now so outputCharCount is non-zero.
        if (
          pendingDeltas.length === 0 &&
          typeof event.data.content === 'string' &&
          event.data.content
        ) {
          pendingDeltas.push(event.data.content);
        }
        flushDeltas();
        break;

      case 'session.usage_info': {
        const snapshot = contextUsage?.store.updateForSession(
          session as object,
          contextUsage.requestKey,
          model,
          event.data as CopilotUsageInfoData,
          contextUsage.outputTokenLimit
        );
        if (snapshot) writer.updateInputTokens(snapshot.totalTokens);
        break;
      }

      case 'session.idle':
        flushDeltas();
        writer.sendCompleted(res);
        res.end();
        finishCompleted();
        break;

      case 'session.error':
        const message = String(event.data.message) || 'Session error';
        logger.warn(`Copilot session error: ${message}`);
        flushDeltas();
        if (writer.hasStarted()) {
          writer.sendFailed(res, 'api_error', message);
          res.end();
        } else {
          const { status, type } = classifyError(message);
          sendJsonError(res, status, type, message);
        }
        finishCompleted();
        break;

      default:
        break;
    }
  });

  // Guard: if neither session.idle nor session.error fires within the timeout
  // window, abort the session and resolve to prevent the promise hanging forever.
  timeoutHandle = setTimeout(() => {
    if (!sessionDone) {
      logger.warn(`Copilot streaming timed out after ${STREAMING_TIMEOUT_MS}ms — aborting session`);
      sessionDone = true;
      unsubscribe();
      registry?.clearActiveResponse();
      registry?.rejectAll(new Error('Streaming timeout'));
      onDone();
      session.abort().catch(() => {});
      session.disconnect().catch(() => {});
      if (writer.hasStarted()) {
        writer.sendFailed(res, 'api_error', 'Streaming timeout');
        res.end();
      } else {
        sendJsonError(res, 500, 'api_error', 'Streaming timeout');
      }
      resolve({ kind: 'completed' });
    }
  }, STREAMING_TIMEOUT_MS);
  // Allow the process to exit naturally even while a streaming request is in-flight.
  timeoutHandle.unref();

  // Detect client disconnect.  See file-level Bun note.
  req.on('close', () => {
    if (!sessionDone) {
      sessionDone = true;
      clearTimeout(timeoutHandle);
      session.abort().catch(() => {});
      registry?.rejectAll(new Error('Client disconnected'));
      unsubscribe();
      registry?.clearActiveResponse();
      onDone();
      session.disconnect().catch(() => {});
      // End the response so Bun's HTTP layer marks the request as complete.
      res.end();
      resolve({ kind: 'completed' });
    }
  });

  // Pass writeFailed so startFn can emit a well-formed SSE epilogue using the
  // original writer state (e.g. when session.send() rejects mid-stream).
  // Guard with sessionDone: if session.idle already fired and ended the
  // response before session.send() rejects, writing again would error.
  //
  // Convention: startFn MUST call finishCompleted() immediately after
  // writeFailed() in the same synchronous execution unit.  writeFailed()
  // intentionally does NOT set sessionDone — finishCompleted() does the
  // full teardown.  Both calls happen synchronously so no async event can
  // fire between them.
  startFn(finishCompleted, () => {
    if (!sessionDone) {
      if (writer.hasStarted()) {
        writer.sendFailed(res, 'api_error', 'Internal streaming error');
        res.end();
      } else {
        sendJsonError(res, 500, 'api_error', 'Internal streaming error');
      }
    }
  });

  return promise;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Start a new streaming turn: write SSE headers, subscribe to events, and
 * call `session.send({ prompt })` to kick off inference.
 *
 * @internal Exported for unit testing.
 */
export function runSessionStreaming(
  session: CopilotSession,
  prompt: string,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry?: ToolBridgeRegistry,
  onDone: () => void = () => {},
  /** Raw input text (system prompt + formatted messages) for heuristic token estimation. */
  inputText = '',
  contextUsage?: StreamingContextUsageOptions
): Promise<StreamingOutcome> {
  return streamSession(
    session,
    model,
    req,
    res,
    registry,
    (finish, writeFailed) => {
      session.send({ prompt }).catch((err: unknown) => {
        // send() can reject if the CLI subprocess crashes.  Use writeFailed()
        // so the original writer's state (open text blocks etc.) is consistent
        // with the SSE epilogue.  writeHead was already called by writer.start().
        logger.error('Failed to send prompt to Copilot session:', err);
        writeFailed();
        session.abort().catch(() => {});
        finish();
      });
    },
    onDone,
    inputText,
    contextUsage
  );
}

/**
 * Resume a streaming turn after tool results have been delivered.
 *
 * Subscribes to session events, resolves the pending tool-handler Promises,
 * and streams the model's continued response.
 */
export function resumeSessionStreaming(
  session: CopilotSession,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry: ToolBridgeRegistry,
  toolResults: ToolResult[],
  onDone: () => void = () => {},
  /** Raw input text (system prompt + full message history) for heuristic token estimation. */
  inputText = '',
  contextUsage?: StreamingContextUsageOptions
): Promise<StreamingOutcome> {
  return streamSession(
    session,
    model,
    req,
    res,
    registry,
    (_finish, _writeFailed) => {
      // Deliver tool results AFTER the event subscription is live so we cannot
      // miss events that fire immediately after resumption.
      for (const { toolUseId, result, isError } of toolResults) {
        registry.resolveToolResult(toolUseId, result, isError);
      }
    },
    onDone,
    inputText,
    contextUsage
  );
}
