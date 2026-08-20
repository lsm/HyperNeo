import type { UUID } from 'crypto';
import type {
  SDKAssistantMessage,
  SDKToolProgressMessage,
  SDKResultMessage,
  SDKMessage,
  SDKUserMessage,
} from '@hyperneo/shared/sdk';
import type { ContentBlock } from '@hyperneo/shared/sdk';
import { generateUUID } from '@hyperneo/shared';
import type {
  AcpAgentMessageChunkUpdate,
  AcpAgentThoughtChunkUpdate,
  AcpToolCallUpdateNotification,
  AcpToolCallUpdateUpdate,
  AcpSessionUpdate,
  AcpStopReason,
} from '@hyperneo/shared/acp';

const TOKEN_CHARS = 4;

function zeroUsage(): {
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  inference_geo: string;
  iterations: [];
  server_tool_use: {
    web_fetch_requests: number;
    web_search_requests: number;
  };
  service_tier: 'standard';
  speed: 'standard';
} {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: '',
    iterations: [],
    server_tool_use: {
      web_fetch_requests: 0,
      web_search_requests: 0,
    },
    service_tier: 'standard',
    speed: 'standard',
  };
}

export class AcpMessageTranslator {
  private textBuffer = '';
  private thinkingBuffer = '';
  private readonly sessionId: string;
  private inputTokenEstimate = 0;
  private outputTokenEstimate = 0;
  private costUsdEstimate = 0;
  private contextUsageEstimate = 0;
  private reportedContextUsage: number | null = null;
  private inProgressToolUseIds = new Set<string>();
  private toolCallTitles = new Map<string, string>();

  constructor(
    sessionId: string,
    private contextWindow = 0,
    initialUsageEstimate = 0,
    initialInputTokenEstimate = 0
  ) {
    this.sessionId = sessionId;
    this.contextUsageEstimate = initialUsageEstimate;
    this.inputTokenEstimate = initialInputTokenEstimate;
  }

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
        const messages: SDKMessage[] = [];
        if (update.content || update.rawOutput !== undefined) {
          this.inProgressToolUseIds.delete(update.toolCallId);
          messages.push(this.translateToolResult(update));
        } else if (!this.inProgressToolUseIds.has(update.toolCallId)) {
          this.inProgressToolUseIds.add(update.toolCallId);
          messages.push(this.translateToolCallUpdate(update));
        }
        return messages;
      }
      case 'plan':
        return [...this.flush(), this.translateSyntheticAssistant('Plan', update.entries)];
      case 'current_mode_update':
        return [
          ...this.flush(),
          this.translateSyntheticAssistant('Current mode', update.currentModeId),
        ];
      case 'session_info_update':
        return [...this.flush(), this.translateSyntheticAssistant('Session info', update)];
      case 'available_commands_update':
        return [...this.flush()];
      case 'usage_update':
        this.reportedContextUsage = update.used;
        this.contextWindow = update.size;
        if (update.cost) {
          this.costUsdEstimate =
            update.cost.currency.toUpperCase() === 'USD' ? update.cost.amount : 0;
        }
        return [];
      default:
        return [];
    }
  }

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

  translateToolCall(call: AcpToolCallUpdateNotification): SDKAssistantMessage {
    this.contextUsageEstimate += estimateTokens(
      JSON.stringify({ name: call.title, input: call.rawInput ?? {} })
    );
    this.toolCallTitles.set(call.toolCallId, call.title);

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

  translateToolCallUpdate(update: AcpToolCallUpdateUpdate): SDKToolProgressMessage {
    return {
      type: 'tool_progress',
      uuid: generateUUID() as UUID,
      session_id: this.sessionId,
      tool_use_id: update.toolCallId,
      tool_name: update.title ?? this.toolCallTitles.get(update.toolCallId) ?? 'unknown',
      parent_tool_use_id: null,
      elapsed_time_seconds: 0,
    };
  }

  translateToolResult(update: AcpToolCallUpdateUpdate): SDKUserMessage {
    const output = update.rawOutput ?? update.content;
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    this.contextUsageEstimate += estimateTokens(text);

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

  translateResult(stopReason: AcpStopReason, isError = false): SDKResultMessage {
    const base = {
      type: 'result' as const,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: isError,
      num_turns: 1,
      stop_reason: stopReason,
      total_cost_usd: this.costUsdEstimate,
      usage: {
        ...zeroUsage(),
        input_tokens: this.inputTokenEstimate,
        output_tokens: this.outputTokenEstimate,
      },
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
      } as unknown as SDKResultMessage;
    }

    return {
      ...base,
      subtype: 'success' as const,
      result: '',
    } as unknown as SDKResultMessage;
  }

  getContextUsage(): { used: number; size: number } | null {
    if (this.reportedContextUsage !== null) {
      return { used: this.reportedContextUsage, size: this.contextWindow };
    }

    const used = this.contextUsageEstimate + this.outputTokenEstimate;
    return used > 0 ? { used, size: this.contextWindow } : null;
  }

  private accumulateAgentChunk(update: AcpAgentMessageChunkUpdate): void {
    if (update.content.type === 'text') {
      this.textBuffer += update.content.text;
      this.outputTokenEstimate += estimateTokens(update.content.text);
    }
  }

  private accumulateThoughtChunk(update: AcpAgentThoughtChunkUpdate): void {
    if (update.content.type === 'text') {
      this.thinkingBuffer += update.content.text;
      this.outputTokenEstimate += estimateTokens(update.content.text);
    }
  }

  private translateSyntheticAssistant(label: string, payload: unknown): SDKAssistantMessage {
    const text = `${label}: ${formatPayload(payload)}`;
    this.outputTokenEstimate += estimateTokens(text);
    return this.buildAssistantMessage([{ type: 'text', text }]);
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

function formatPayload(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}
