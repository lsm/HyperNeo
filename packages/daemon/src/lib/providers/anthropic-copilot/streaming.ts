import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import type { ToolBridgeRegistry } from './tool-bridge.js';
import type { ToolResult } from './conversation.js';
import { AnthropicStreamWriter, estimateTokens } from './sse.js';
import type { ContextUsageStore, CopilotUsageInfoData } from './context-usage.js';
import { type AnthropicErrorType, createAnthropicErrorBody } from '../shared/error-envelope.js';
import { Logger } from '../../logger.js';

const logger = new Logger('anthropic-copilot-streaming');

export const STREAMING_TIMEOUT_MS = 5 * 60 * 1000;

export type StreamingOutcome = { kind: 'completed' } | { kind: 'tool_use'; toolCallIds: string[] };

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

function streamSession(
  session: CopilotSession,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry: ToolBridgeRegistry | undefined,
  startFn: (finish: () => void, writeFailed: () => void) => void,
  onDone: () => void,
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
    sessionDone = true;
    clearTimeout(timeoutHandle);
    unsubscribe();
    resolve({ kind: 'tool_use', toolCallIds });
  }

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
  timeoutHandle.unref();

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
      res.end();
      resolve({ kind: 'completed' });
    }
  });

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

export function runSessionStreaming(
  session: CopilotSession,
  prompt: string,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry?: ToolBridgeRegistry,
  onDone: () => void = () => {},
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

export function resumeSessionStreaming(
  session: CopilotSession,
  model: string,
  req: IncomingMessage,
  res: ServerResponse,
  registry: ToolBridgeRegistry,
  toolResults: ToolResult[],
  onDone: () => void = () => {},
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
      for (const { toolUseId, result, isError } of toolResults) {
        registry.resolveToolResult(toolUseId, result, isError);
      }
    },
    onDone,
    inputText,
    contextUsage
  );
}
