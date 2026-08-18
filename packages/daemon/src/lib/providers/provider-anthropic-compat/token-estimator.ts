import type {
  AnthropicContentBlock,
  AnthropicContentBlockToolResult,
  AnthropicRequest,
  AnthropicTool,
} from './translator.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const SYSTEM_OVERHEAD_TOKENS = 4;
const TOOL_SCHEMA_OVERHEAD_TOKENS = 12;
const REQUEST_OVERHEAD_TOKENS = 3;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  const characterEstimate = Math.ceil(text.length / 4);
  const lexicalPieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;

  return Math.max(1, Math.ceil((characterEstimate + lexicalPieces) / 2));
}

const ESTIMATED_IMAGE_TOKENS = 300;

function estimateToolResultContent(content: AnthropicContentBlockToolResult['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  return content.reduce((sum, block) => {
    if (block.type === 'text') return sum + estimateTextTokens(block.text);
    if (block.type === 'image') return sum + ESTIMATED_IMAGE_TOKENS;
    return (
      sum + estimateTextTokens(`[Unsupported: ${(block as { type?: string }).type ?? 'unknown'}]`)
    );
  }, 0);
}

function estimateContentBlockTokens(block: AnthropicContentBlock): number {
  if (block.type === 'text') {
    return estimateTextTokens(block.text);
  }
  if (block.type === 'tool_use') {
    return (
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(block.name) +
      estimateTextTokens(stableJson(block.input))
    );
  }
  if (block.type === 'tool_result') {
    return MESSAGE_OVERHEAD_TOKENS + estimateToolResultContent(block.content);
  }
  if (block.type === 'image') {
    return ESTIMATED_IMAGE_TOKENS;
  }
  return estimateTextTokens(stableJson(block));
}

function estimateMessageContentTokens(
  content: AnthropicRequest['messages'][number]['content']
): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  return content.reduce((sum, block) => sum + estimateContentBlockTokens(block), 0);
}

function estimateSystemTokens(system: AnthropicRequest['system']): number {
  if (!system) return 0;
  if (typeof system === 'string') {
    return SYSTEM_OVERHEAD_TOKENS + estimateTextTokens(system);
  }
  return (
    SYSTEM_OVERHEAD_TOKENS + system.reduce((sum, block) => sum + estimateTextTokens(block.text), 0)
  );
}

function estimateToolTokens(tool: AnthropicTool): number {
  return (
    TOOL_SCHEMA_OVERHEAD_TOKENS +
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description ?? '') +
    estimateTextTokens(stableJson(tool.input_schema))
  );
}

export function estimateAnthropicInputTokens(request: AnthropicRequest): number {
  const systemTokens = estimateSystemTokens(request.system);
  const messageTokens = request.messages.reduce(
    (sum, message) =>
      sum +
      MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(message.role) +
      estimateMessageContentTokens(message.content),
    0
  );
  const toolTokens = (request.tools ?? []).reduce((sum, tool) => sum + estimateToolTokens(tool), 0);

  return Math.max(0, REQUEST_OVERHEAD_TOKENS + systemTokens + messageTokens + toolTokens);
}
