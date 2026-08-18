import type { AnthropicErrorType } from '../shared/error-envelope.js';
export type { AnthropicErrorType } from '../shared/error-envelope.js';

export type AnthropicContentBlockText = {
  type: 'text';
  text: string;
};

export type AnthropicContentBlockToolUse = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicContentBlockToolResult = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string } | AnthropicContentBlockImage>;
};

export type AnthropicContentBlockImage =
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
        data: string;
      };
    }
  | {
      type: 'image';
      source: {
        type: 'url';
        url: string;
      };
    };

export type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult
  | AnthropicContentBlockImage;

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
  tool_choice?: ToolChoice;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
};

export function extractSystemText(system: AnthropicRequest['system'] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n');
}

const SSE_SEP = '\n\n';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}${SSE_SEP}`;
}

export function messageStartSSE(
  messageId: string,
  model: string,
  inputTokens: number,
  modelContextWindow?: number | null
): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        model_context_window: modelContextWindow ?? null,
      },
    },
  });
}

export function contentBlockStartTextSSE(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  });
}

export function contentBlockStartToolUseSSE(
  index: number,
  toolUseId: string,
  name: string
): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
  });
}

export function contentBlockStartThinkingSSE(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '' },
  });
}

export function thinkingDeltaSSE(index: number, thinking: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  });
}

export function textDeltaSSE(index: number, text: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });
}

export function inputJsonDeltaSSE(index: number, partialJson: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });
}

export function contentBlockStopSSE(index: number): string {
  return sseEvent('content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

export type MessageDeltaUsage = {
  outputTokens: number;
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  modelContextWindow?: number | null;
  thinkingTokens?: number | null;
};

export function messageDeltaSSE(
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens',
  usage: MessageDeltaUsage
): string {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: usage.inputTokens ?? null,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? null,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? null,
      model_context_window: usage.modelContextWindow ?? null,
      thinking_tokens: usage.thinkingTokens ?? null,
    },
  });
}

export function messageStopSSE(): string {
  return sseEvent('message_stop', { type: 'message_stop' });
}

export function errorSSE(errorType: AnthropicErrorType, message: string): string {
  return sseEvent('error', { type: 'error', error: { type: errorType, message } });
}
