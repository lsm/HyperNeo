/**
 * Anthropic SSE stream helpers.
 *
 * AnthropicStreamWriter writes the correct sequence of SSE events expected by
 * the Claude Agent SDK.  It tracks open text-blocks and handles both the
 * normal end-turn completion path and the tool-use suspension path.
 *
 * Adapted from copilot-sdk-proxy/claude/streaming.ts (MIT).
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AnthropicErrorType } from '../shared/error-envelope.js';

// ---------------------------------------------------------------------------
// Token estimation helper
// ---------------------------------------------------------------------------

/**
 * Estimate token count from a character count using the rough 4-chars-per-token
 * heuristic.
 *
 * NOTE: These are NOT actual model-reported values — the Copilot SDK does not
 * expose per-request token counts.  The estimate provides a non-zero
 * approximation for UI display purposes only.
 */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

// ---------------------------------------------------------------------------
// Headers & low-level helper
// ---------------------------------------------------------------------------

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function sendEvent(res: ServerResponse, type: string, data: object): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// AnthropicStreamWriter
// ---------------------------------------------------------------------------

/**
 * Stateful SSE writer for one Anthropic streaming response.
 *
 * Sequence guaranteed by `start()` → zero or more `flushDeltas()` →
 * one of `sendCompleted()` | `sendFailed()` | `sendToolUse()`.
 */
export class AnthropicStreamWriter {
  private textBlockStarted = false;
  private streamStarted = false;
  private model = 'unknown';
  private inputTokens = 0;
  private nextBlockIndex = 0;
  private textBlockIndex = 0;
  /** Accumulated output character count, used for heuristic output_tokens estimate. */
  private outputCharCount = 0;
  readonly messageId = `msg_${randomUUID()}`;

  configure(model: string, inputTokens = 0): void {
    this.model = model;
    this.inputTokens = inputTokens;
  }

  updateInputTokens(inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.inputTokens = Math.round(inputTokens);
    }
  }

  hasStarted(): boolean {
    return this.streamStarted;
  }

  private ensureStarted(res: ServerResponse): void {
    if (!this.streamStarted) {
      this.start(res, this.model, this.inputTokens);
    }
  }

  private closeTextBlock(res: ServerResponse): void {
    if (this.textBlockStarted) {
      sendEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: this.textBlockIndex,
      });
      this.nextBlockIndex = this.textBlockIndex + 1;
      this.textBlockStarted = false;
    }
  }

  private ensureTextBlock(res: ServerResponse): void {
    if (!this.textBlockStarted) {
      this.textBlockIndex = this.nextBlockIndex;
      sendEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: this.textBlockIndex,
        content_block: { type: 'text', text: '' },
      });
      this.textBlockStarted = true;
    }
  }

  private sendEpilogue(res: ServerResponse, stopReason: string): void {
    // Heuristic estimate: ceil(outputTextLength / 4).
    // NOT actual model-reported values — the Copilot SDK does not expose
    // per-request token counts.  Approximation for UI display purposes only.
    // All four usage fields are required — the Claude Agent SDK expects a
    // complete NonNullableUsage shape; omitting any field causes a crash.
    sendEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: estimateTokens(this.outputCharCount),
        input_tokens: this.inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    sendEvent(res, 'message_stop', { type: 'message_stop' });
  }

  /**
   * Write the `message_start` preamble and set SSE response headers.
   *
   * @param inputTokens Heuristic estimate of input tokens — caller should pass
   *   `estimateTokens(inputText.length)`.  NOT actual model-reported values.
   */
  start(res: ServerResponse, model: string, inputTokens = 0): void {
    this.model = model;
    this.inputTokens = inputTokens;
    if (this.streamStarted) return;
    this.streamStarted = true;
    res.writeHead(200, SSE_HEADERS);
    sendEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        // Heuristic estimate: ceil(inputTextLength / 4).
        // NOT actual model-reported values — the Copilot SDK does not expose
        // per-request token counts.  Approximation for UI display purposes only.
        // All four usage fields are required — the Claude Agent SDK expects a
        // complete NonNullableUsage shape; omitting any field causes a crash.
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  /** Flush accumulated text deltas to the stream. */
  flushDeltas(res: ServerResponse, deltas: string[]): void {
    if (deltas.length === 0) return;
    this.ensureStarted(res);
    this.ensureTextBlock(res);
    for (const text of deltas) {
      this.outputCharCount += text.length;
      sendEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: { type: 'text_delta', text },
      });
    }
  }

  /**
   * Write one `tool_use` content block WITHOUT writing the epilogue or ending
   * the response.  Use this when multiple parallel tool calls need to be
   * emitted in the same response — call `sendToolUseEpilogue()` afterward.
   *
   * NOTE: Tool JSON bytes are NOT counted in `outputCharCount`.  The heuristic
   * `output_tokens` estimate in `message_delta` covers only text delta
   * characters accumulated via `flushDeltas()`.
   */
  writeToolUseBlock(
    res: ServerResponse,
    toolCallId: string,
    toolName: string,
    toolInput: unknown
  ): void {
    this.ensureStarted(res);
    this.closeTextBlock(res);
    const blockIndex = this.nextBlockIndex++;
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} },
    });
    sendEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
    });
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
  }

  /**
   * Write the `stop_reason: "tool_use"` epilogue and end the response.
   *
   * Call this once after all `writeToolUseBlock()` calls.  The Copilot
   * session remains alive — tool handlers are still suspended waiting for
   * tool results that will arrive in the next HTTP request.
   */
  sendToolUseEpilogue(res: ServerResponse): void {
    this.sendEpilogue(res, 'tool_use');
    res.end();
  }

  /** Emit a single `tool_use` content block and end the SSE stream.
   *
   * Convenience wrapper around `writeToolUseBlock` + `sendToolUseEpilogue`
   * for the common single-tool case.
   */
  sendToolUse(res: ServerResponse, toolCallId: string, toolName: string, toolInput: unknown): void {
    this.writeToolUseBlock(res, toolCallId, toolName, toolInput);
    this.sendToolUseEpilogue(res);
  }

  /**
   * Emit an `end_turn` epilogue.
   *
   * Closes the open text block (if any) and sends the epilogue.  Does NOT
   * force an empty text block when no text was ever emitted — tool-only
   * responses have an empty `content` array which is valid per the spec.
   */
  sendCompleted(res: ServerResponse): void {
    this.ensureStarted(res);
    this.closeTextBlock(res);
    this.sendEpilogue(res, 'end_turn');
  }

  /**
   * Emit an Anthropic-format `error` SSE event (called on error paths).
   *
   * Closes the open text block (if any) then emits an `error` event that the
   * Claude Agent SDK interprets as an `APIError`.  Does NOT emit `message_stop`
   * — the stream ends after the error event per the Anthropic streaming spec.
   */
  sendFailed(
    res: ServerResponse,
    errorType: AnthropicErrorType = 'api_error',
    message = 'Internal server error'
  ): void {
    if (this.textBlockStarted) {
      sendEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: this.textBlockIndex,
      });
      this.textBlockStarted = false;
    }
    sendEvent(res, 'error', { type: 'error', error: { type: errorType, message } });
  }
}
