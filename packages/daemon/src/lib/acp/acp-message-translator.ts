/**
 * ACP Message Translator
 *
 * Pure translation functions that bridge ACP protocol notifications
 * to NeoKai's internal SDKMessage types.
 *
 * Accumulates streaming chunks (agent_message_chunk, agent_thought_chunk)
 * into complete assistant messages, flushing on tool_call boundaries or
 * result boundaries.
 */

import type { UUID } from 'crypto';
import type {
  SDKAssistantMessage,
  SDKToolProgressMessage,
  SDKResultMessage,
  SDKMessage,
  SDKUserMessage,
} from '@neokai/shared/sdk';
import type { ContentBlock } from '@neokai/shared/sdk';
import { generateUUID } from '@neokai/shared';
import type {
  AcpAgentMessageChunkUpdate,
  AcpAgentThoughtChunkUpdate,
  AcpToolCallUpdateNotification,
  AcpToolCallUpdateUpdate,
  AcpSessionUpdate,
  AcpStopReason,
} from '@neokai/shared/acp';

function zeroUsage(): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
} {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/**
 * Stateful translator that buffers ACP streaming chunks and emits
 * complete SDKMessage objects on boundaries.
 */
export class AcpMessageTranslator {
  private textBuffer = '';
  private thinkingBuffer = '';
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Process a single ACP session update, accumulating chunks and
   * emitting SDKMessages when boundaries are hit.
   */
  processUpdate(update: AcpSessionUpdate): SDKMessage[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.accumulateAgentChunk(update);
        return [];
      case 'agent_thought_chunk':
        this.accumulateThoughtChunk(update);
        return [];
      case 'tool_call':
        return [...this.flush(), this.translateToolCall(update)];
      case 'tool_call_update': {
        const messages: SDKMessage[] = [this.translateToolCallUpdate(update)];
        if (update.content || update.rawOutput !== undefined) {
          messages.push(this.translateToolResult(update));
        }
        return messages;
      }
      default:
        return [];
    }
  }

  /**
   * Flush any accumulated text/thinking chunks into a complete
   * assistant message. Returns empty array if nothing accumulated.
   */
  flush(): SDKMessage[] {
    const blocks: ContentBlock[] = [];

    if (this.thinkingBuffer) {
      blocks.push({ type: 'thinking', thinking: this.thinkingBuffer });
    }
    if (this.textBuffer) {
      blocks.push({ type: 'text', text: this.textBuffer });
    }

    this.thinkingBuffer = '';
    this.textBuffer = '';

    if (blocks.length === 0) {
      return [];
    }

    return [this.buildAssistantMessage(blocks)];
  }

  /**
   * Translate a tool_call notification into an SDK assistant message
   * containing a tool_use content block.
   */
  translateToolCall(call: AcpToolCallUpdateNotification): SDKAssistantMessage {
    return {
      type: 'assistant',
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: call.toolCallId,
            name: call.title,
            input: (call.rawInput ?? {}) as Record<string, unknown>,
          },
        ],
      },
    } as SDKAssistantMessage;
  }

  /**
   * Translate a tool_call_update notification into an SDK tool_progress message.
   */
  translateToolCallUpdate(update: AcpToolCallUpdateUpdate): SDKToolProgressMessage {
    return {
      type: 'tool_progress',
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
      tool_use_id: update.toolCallId,
      tool_name: update.title ?? 'unknown',
      parent_tool_use_id: null,
      elapsed_time_seconds: 0,
    };
  }

  /**
   * Translate a tool_call_update with output into a synthetic SDK user message
   * carrying the tool result so it is visible in the transcript.
   */
  translateToolResult(update: AcpToolCallUpdateUpdate): SDKUserMessage {
    const output = update.rawOutput ?? update.content;
    const text = typeof output === 'string' ? output : JSON.stringify(output);

    return {
      type: 'user',
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
      parent_tool_use_id: update.toolCallId,
      isSynthetic: true,
      shouldQuery: false,
      tool_use_result: output,
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    } as SDKUserMessage;
  }

  /**
   * Translate a stop reason into an SDK result message.
   */
  translateResult(stopReason: AcpStopReason, isError = false): SDKResultMessage {
    const base = {
      type: 'result' as const,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: isError,
      num_turns: 1,
      stop_reason: stopReason,
      total_cost_usd: 0,
      usage: zeroUsage(),
      modelUsage: {},
      permission_denials: [],
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
    };

    if (isError) {
      return {
        ...base,
        subtype: 'error_during_execution' as const,
        errors: [stopReason],
      } as SDKResultMessage;
    }

    return {
      ...base,
      subtype: 'success' as const,
      result: '',
    } as SDKResultMessage;
  }

  private accumulateAgentChunk(update: AcpAgentMessageChunkUpdate): void {
    if (update.content.type === 'text') {
      this.textBuffer += update.content.text;
    }
  }

  private accumulateThoughtChunk(update: AcpAgentThoughtChunkUpdate): void {
    if (update.content.type === 'text') {
      this.thinkingBuffer += update.content.text;
    }
  }

  private buildAssistantMessage(content: ContentBlock[]): SDKAssistantMessage {
    return {
      type: 'assistant',
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content,
      },
    } as SDKAssistantMessage;
  }
}
