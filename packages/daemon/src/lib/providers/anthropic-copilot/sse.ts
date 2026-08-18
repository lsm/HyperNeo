import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AnthropicErrorType } from '../shared/error-envelope.js';

export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export function sendEvent(res: ServerResponse, type: string, data: object): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class AnthropicStreamWriter {
  private textBlockStarted = false;
  private streamStarted = false;
  private model = 'unknown';
  private inputTokens = 0;
  private nextBlockIndex = 0;
  private textBlockIndex = 0;
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
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

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

  sendToolUseEpilogue(res: ServerResponse): void {
    this.sendEpilogue(res, 'tool_use');
    res.end();
  }

  sendToolUse(res: ServerResponse, toolCallId: string, toolName: string, toolInput: unknown): void {
    this.writeToolUseBlock(res, toolCallId, toolName, toolInput);
    this.sendToolUseEpilogue(res);
  }

  sendCompleted(res: ServerResponse): void {
    this.ensureStarted(res);
    this.closeTextBlock(res);
    this.sendEpilogue(res, 'end_turn');
  }

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
