/**
 * OpenAI Responses Anthropic Bridge — HTTP Server
 *
 * Exposes a small Anthropic-compatible Messages API surface backed directly by
 * OpenAI's Responses API. The Anthropic Agent SDK remains the only local
 * harness: tools are translated to OpenAI function tools and function calls are
 * translated back to Anthropic tool_use blocks for the SDK to execute.
 */

import {
  type AnthropicContentBlock,
  type AnthropicContentBlockImage,
  type AnthropicContentBlockToolResult,
  type AnthropicRequest,
  type AnthropicTool,
  type ToolChoice,
  contentBlockStartTextSSE,
  contentBlockStartThinkingSSE,
  contentBlockStartToolUseSSE,
  contentBlockStopSSE,
  errorSSE,
  extractSystemText,
  inputJsonDeltaSSE,
  messageDeltaSSE,
  messageStartSSE,
  messageStopSSE,
  textDeltaSSE,
  thinkingDeltaSSE,
} from '../provider-anthropic-compat/translator.js';
import { getModelContextWindow as getCodexModelContextWindow } from '../codex-models.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import {
  anthropicErrorTypeForHttpStatus,
  httpStatusForSymbolicErrorType,
  isProviderErrorCodeOrType,
} from '@hyperneo/shared/provider/error-taxonomy';
import {
  isJsonContentType,
  normalizeOpenAiUpstreamError,
} from '../shared/normalize-upstream-error.js';
import { Logger } from '../../logger.js';

const logger = new Logger('openai-responses-bridge-server');

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_RESPONSE_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const SESSION_ROUTE_PREFIX = '/_hyperneo/session/';

export type OpenAIResponsesBridgeAuth = {
  apiKey: string;
  source: 'api_key' | 'chatgpt_oauth';
  accountId?: string;
  isFedrampAccount?: boolean;
  refreshAuthTokens?: () => Promise<{
    accessToken: string;
    accountId: string;
    isFedrampAccount?: boolean;
  } | null>;
};

export type OpenAIResponsesBridgeModel = {
  id: string;
  display_name: string;
  created_at: string;
  context_window: number;
  max_tokens?: number;
};

export type OpenAIResponsesBridgeServer = {
  port: number;
  baseUrlForSession?(sessionId: string): string;
  /** Set per-session thinking config so the bridge can include reasoning even when the Anthropic SDK client omits the thinking field. */
  setSessionThinkingConfig?(sessionId: string, thinking: AnthropicRequest['thinking']): void;
  /**
   * Override the resolved model ID for a specific session.
   * Used when the SDK sends a model ID that differs from the upstream
   * model ID (e.g., aliased Anthropic IDs for Copilot, or any provider
   * using model ID translation). For providers using real model IDs
   * directly (Codex, GLM, Kimi), both arguments are typically the same.
   */
  setSessionModelConfig?(sessionId: string, aliasModelId: string, realModelId: string): void;
  stop(): void;
};

export type OpenAIResponsesBridgeConfig = {
  auth: OpenAIResponsesBridgeAuth;
  models: OpenAIResponsesBridgeModel[];
  modelAliases?: Record<string, string>;
  openAIBaseUrl?: string;
  continuationTtlMs?: number;
  fetchImpl?: typeof fetch;
};

type ResponsesReasoningItem = {
  type: 'reasoning';
  encrypted_content: string;
};

type ResponsesInputText = { type: 'input_text'; text: string };
type ResponsesInputImage = {
  type: 'input_image';
  image_url: string;
  detail?: 'low' | 'high' | 'auto' | 'original';
};

type ResponsesInputItem =
  | {
      type: 'message';
      role: 'user' | 'system' | 'developer';
      content: Array<ResponsesInputText | ResponsesInputImage>;
    }
  | {
      type: 'message';
      role: 'assistant';
      content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      status?: 'completed';
    }
  | {
      type: 'function_call_output';
      call_id: string;
      // The OpenAI Responses API documents function_call_output.output as a
      // string. The ChatGPT Codex backend hard-rejects non-string shapes with
      // `{"detail":"Unsupported content type"}`, so this is always stringified
      // (see toolResultContent).
      output: string;
    }
  | ResponsesReasoningItem;

type ResponsesTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  previous_response_id?: string;
  tools?: ResponsesTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  max_output_tokens?: number;
  store: false;
  stream: true;
  parallel_tool_calls?: false;
  reasoning?: {
    effort: 'low' | 'medium' | 'high' | 'xhigh';
    summary?: 'auto' | 'concise' | 'detailed';
  };
  include?: string[];
};

type OpenAIStreamEvent = {
  type?: string;
  response?: Record<string, unknown>;
  delta?: string;
  arguments?: string;
  call_id?: string;
  name?: string;
  item?: Record<string, unknown>;
  error?: { message?: string; type?: string; code?: string };
};

type ResolvedResponsesAuth = {
  apiKey: string;
  accountId?: string;
  isFedrampAccount?: boolean;
};

type ResponseContinuation = {
  responseId: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type SessionReasoningEntry = {
  items: ResponsesReasoningItem[];
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type SessionThinkingConfigEntry = {
  thinking: AnthropicRequest['thinking'];
};

/**
 * Resolve the context window for a model.
 * Prefers the config-provided context window (from bridge models list, which may
 * include non-Codex models like OpenRouter models with 1M+ context), falling back
 * to the Codex-only static lookup for backward compatibility.
 */
function resolveContextWindow(model: string, configContextWindow?: number): number | undefined {
  return configContextWindow ?? getCodexModelContextWindow(model);
}

function generateMsgId(): string {
  return `msg_${Math.random().toString(36).slice(2, 14)}`;
}

function extractSessionId(req: Request): { sessionId: string; pathname: string } {
  const url = new URL(req.url);
  if (url.pathname.startsWith(SESSION_ROUTE_PREFIX)) {
    const remainder = url.pathname.slice(SESSION_ROUTE_PREFIX.length);
    const slashIndex = remainder.indexOf('/');
    if (slashIndex > 0) {
      const encodedSessionId = remainder.slice(0, slashIndex);
      try {
        return {
          sessionId: decodeURIComponent(encodedSessionId),
          pathname: remainder.slice(slashIndex) || '/',
        };
      } catch {
        // Fall back to legacy auth-header parsing below for malformed route IDs.
      }
    }
  }

  const auth =
    req.headers.get('Authorization') ??
    req.headers.get('authorization') ??
    req.headers.get('x-api-key') ??
    '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : auth;
  if (token.startsWith('codex-bridge-')) {
    return { sessionId: token.slice('codex-bridge-'.length), pathname: url.pathname };
  }
  return { sessionId: 'default', pathname: url.pathname };
}

function continuationKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

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
 * Emit a normalized retryable upstream error with `x-should-retry: true` so the
 * Claude Agent SDK retries (it already retries on 429 / >=500 status).
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

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  const characterEstimate = Math.ceil(text.length / 4);
  const lexicalPieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;

  return Math.max(1, Math.ceil((characterEstimate + lexicalPieces) / 2));
}

/** Fixed token estimate per image for OpenAI vision models.
 *
 * OpenAI bills vision tokens based on image dimensions and detail level,
 * not base64 payload size. Without access to actual image dimensions,
 * we use a conservative fixed estimate (~300 tokens) that covers the
 * common auto/high-detail case rather than a base64-length heuristic
 * that would inflate estimates for large encoded payloads.
 */
const ESTIMATED_IMAGE_TOKENS = 300;

function estimateResponsesContentTokens(item: ResponsesInputItem): number {
  if (item.type === 'function_call_output') {
    return estimateTextTokens(item.output);
  }
  if (item.type === 'function_call') {
    return estimateTextTokens(item.name) + estimateTextTokens(item.arguments);
  }
  if (item.type === 'reasoning') {
    return estimateTextTokens(item.encrypted_content);
  }
  return item.content.reduce((sum, block) => {
    if (block.type === 'input_image') {
      return sum + ESTIMATED_IMAGE_TOKENS;
    }
    return sum + estimateTextTokens(block.text);
  }, 0);
}

function estimateResponsesInputTokens(items: ResponsesInputItem[]): number {
  const requestOverheadTokens = 3;
  const itemOverheadTokens = 4;
  return (
    requestOverheadTokens +
    items.reduce((sum, item) => sum + itemOverheadTokens + estimateResponsesContentTokens(item), 0)
  );
}

function estimateResponsesToolTokens(tool: ResponsesTool): number {
  const toolOverheadTokens = 8;
  return (
    toolOverheadTokens +
    estimateTextTokens(tool.name) +
    (tool.description ? estimateTextTokens(tool.description) : 0) +
    estimateTextTokens(stableStringify(tool.parameters))
  );
}

function estimateResponsesPayloadTokens(
  body: AnthropicRequest,
  input: ResponsesInputItem[]
): number {
  const instructions = extractSystemText(body.system);
  const tools = toolsToResponsesTools(body.tools);
  const toolsOverheadTokens = tools && tools.length > 0 ? 4 : 0;
  return (
    estimateResponsesInputTokens(input) +
    (instructions ? estimateTextTokens(instructions) : 0) +
    toolsOverheadTokens +
    (tools?.reduce((sum, tool) => sum + estimateResponsesToolTokens(tool), 0) ?? 0)
  );
}

/**
 * Convert an Anthropic tool_result `content` into the string expected by the
 * OpenAI Responses API's `function_call_output.output` field.
 *
 * The Responses API documents `output` as a string; the ChatGPT Codex backend
 * hard-rejects non-string shapes with `{"detail":"Unsupported content type"}`.
 * Images cannot be carried in a string output, so non-text blocks are rendered
 * as descriptive placeholders (the model still learns that media was returned).
 */
function toolResultContent(content: AnthropicContentBlockToolResult['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      const source = block.source as { type?: string; media_type?: string; url?: string };
      parts.push(
        `[image: ${source.type === 'url' ? (source.url ?? 'url') : (source.media_type ?? 'unknown')}]`
      );
      continue;
    }
    parts.push(`[Unsupported content block: ${(block as { type?: string }).type ?? 'unknown'}]`);
  }
  return parts.filter(Boolean).join('\n');
}

function appendInputMessage(
  items: ResponsesInputItem[],
  role: 'user' | 'system' | 'developer',
  contentParts: Array<ResponsesInputText | ResponsesInputImage>
): void {
  if (contentParts.length === 0) return;
  // Merge consecutive input_text blocks into a single block so the upstream
  // API receives clean, consolidated text rather than fragmented pieces.
  const merged: Array<ResponsesInputText | ResponsesInputImage> = [];
  let pendingText: string[] = [];
  const flushText = () => {
    const text = pendingText.filter(Boolean).join('\n\n');
    if (text) {
      merged.push({ type: 'input_text', text });
    }
    pendingText = [];
  };
  for (const part of contentParts) {
    if (part.type === 'input_text') {
      pendingText.push(part.text);
    } else {
      flushText();
      merged.push(part);
    }
  }
  flushText();
  if (merged.length === 0) return;
  items.push({
    type: 'message',
    role,
    content: merged,
  });
}

function appendAssistantMessage(items: ResponsesInputItem[], textParts: string[]): void {
  const text = textParts.filter(Boolean).join('\n\n');
  if (!text) return;
  items.push({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  });
}

function imageBlockToInputImage(block: AnthropicContentBlockImage): ResponsesInputImage {
  if (block.source.type === 'url') {
    return { type: 'input_image', image_url: block.source.url };
  }
  if (block.source.type === 'base64') {
    const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
    return { type: 'input_image', image_url: dataUrl };
  }
  throw new Error(
    `Unsupported image source type: ${(block.source as { type?: string }).type ?? 'unknown'}`
  );
}

function appendUserBlocks(items: ResponsesInputItem[], blocks: AnthropicContentBlock[]): void {
  const contentParts: Array<ResponsesInputText | ResponsesInputImage> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      contentParts.push({ type: 'input_text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      contentParts.push(imageBlockToInputImage(block));
      continue;
    }
    if (block.type === 'tool_result') {
      const result = block as AnthropicContentBlockToolResult & { is_error?: boolean };
      const output = toolResultContent(result.content);
      appendInputMessage(items, 'user', contentParts);
      contentParts.length = 0;
      items.push({
        type: 'function_call_output',
        call_id: result.tool_use_id,
        output: result.is_error ? `[Tool error]\n${output}` : output,
      });
      continue;
    }
    throw new Error(`Unsupported user content block type: ${block.type}`);
  }
  appendInputMessage(items, 'user', contentParts);
}

function appendAssistantBlocks(items: ResponsesInputItem[], blocks: AnthropicContentBlock[]): void {
  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      appendAssistantMessage(items, textParts.splice(0));
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: stableStringify(block.input),
        status: 'completed',
      });
    }
  }
  appendAssistantMessage(items, textParts);
}

function latestContinuationInputItems(
  messages: AnthropicRequest['messages']
): ResponsesInputItem[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  if (!last.content.some((block) => block.type === 'tool_result')) return [];

  const items: ResponsesInputItem[] = [];
  appendUserBlocks(items, last.content);
  return items;
}

function resolveContinuation(
  sessionId: string,
  messages: AnthropicRequest['messages'],
  continuations: Map<string, ResponseContinuation>
): { previousResponseId: string; input: ResponsesInputItem[]; callIds: string[] } | undefined {
  const input = latestContinuationInputItems(messages);
  if (input.length === 0) return undefined;

  let previousResponseId: string | undefined;
  const callIds: string[] = [];
  for (const item of input) {
    if (item.type !== 'function_call_output') continue;
    const continuation = continuations.get(continuationKey(sessionId, item.call_id));
    if (!continuation) return undefined;
    callIds.push(item.call_id);
    if (!previousResponseId) {
      previousResponseId = continuation.responseId;
      continue;
    }
    if (previousResponseId !== continuation.responseId) return undefined;
  }

  return previousResponseId ? { previousResponseId, input, callIds } : undefined;
}

export function anthropicMessagesToResponsesInput(
  messages: AnthropicRequest['messages'],
  reasoningItems?: ResponsesReasoningItem[]
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  // Reasoning belongs to the most recent assistant turn, so it must be
  // inserted immediately before the *last* user message (the current turn).
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (typeof message.content === 'string') {
      if (message.role === 'assistant') {
        appendAssistantMessage(items, [message.content]);
      } else {
        if (reasoningItems && reasoningItems.length > 0 && i === lastUserIndex) {
          items.push(...reasoningItems);
        }
        appendInputMessage(items, 'user', [{ type: 'input_text', text: message.content }]);
      }
      continue;
    }
    if (message.role === 'assistant') {
      appendAssistantBlocks(items, message.content);
    } else {
      if (reasoningItems && reasoningItems.length > 0 && i === lastUserIndex) {
        items.push(...reasoningItems);
      }
      appendUserBlocks(items, message.content);
    }
  }
  return items;
}

function toolsToResponsesTools(tools: AnthropicTool[] | undefined): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema,
  }));
}

function toolChoiceToResponsesToolChoice(
  toolChoice: ToolChoice | undefined
): ResponsesRequest['tool_choice'] {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool') return { type: 'function', name: toolChoice.name };
  return undefined;
}

/**
 * Models known to support reasoning.effort="xhigh".
 */
const MODELS_SUPPORTING_XHIGH_REASONING = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
]);

/**
 * Map Anthropic SDK thinking config (budget_tokens) to OpenAI reasoning.effort.
 * Caps xhigh to high for models that do not support it.
 */
function mapThinkingToReasoningEffort(
  thinking: AnthropicRequest['thinking'],
  model?: string
): ResponsesRequest['reasoning'] {
  if (!thinking || thinking.type !== 'enabled') return undefined;
  const tokens = thinking.budget_tokens;
  if (tokens <= 8000) return { effort: 'low', summary: 'auto' };
  if (tokens <= 16000) return { effort: 'medium', summary: 'auto' };
  if (tokens <= 24000) return { effort: 'high', summary: 'auto' };
  const supportsXHigh = model ? MODELS_SUPPORTING_XHIGH_REASONING.has(model) : true;
  return { effort: supportsXHigh ? 'xhigh' : 'high', summary: 'auto' };
}

function buildResponsesRequest(
  body: AnthropicRequest,
  model: string,
  continuation?: { previousResponseId: string; input: ResponsesInputItem[] },
  options: {
    includeMaxOutputTokens?: boolean;
    includeParallelToolCalls?: boolean;
    isChatgptOAuth?: boolean;
  } = {},
  reasoningItems?: ResponsesReasoningItem[]
): ResponsesRequest {
  const instructions = extractSystemText(body.system) || undefined;
  const tools = toolsToResponsesTools(body.tools);
  const tool_choice = toolChoiceToResponsesToolChoice(body.tool_choice);
  const includeMaxOutputTokens = options.includeMaxOutputTokens ?? true;
  const includeParallelToolCalls = options.includeParallelToolCalls ?? true;
  const reasoning = mapThinkingToReasoningEffort(body.thinking, model);
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input: continuation?.input ?? anthropicMessagesToResponsesInput(body.messages, reasoningItems),
    ...(continuation ? { previous_response_id: continuation.previousResponseId } : {}),
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(includeMaxOutputTokens && typeof body.max_tokens === 'number'
      ? { max_output_tokens: body.max_tokens }
      : {}),
    store: false,
    stream: true,
    ...(includeParallelToolCalls ? { parallel_tool_calls: false } : {}),
    ...(reasoning ? { reasoning } : {}),
    // encrypted_content is required for multi-turn stateless continuation.
    // summary_text is required for the standard OpenAI API to stream reasoning
    // summary deltas (response.reasoning_summary_text.delta). The ChatGPT Codex
    // endpoint rejects summary_text, so keep it off that path.
    ...(reasoning || (reasoningItems && reasoningItems.length > 0)
      ? {
          include: [
            'reasoning.encrypted_content',
            ...(options.isChatgptOAuth ? [] : ['reasoning.summary_text']),
          ],
        }
      : {}),
  };
}

function defaultBaseUrlForAuth(auth: OpenAIResponsesBridgeAuth): string {
  return auth.source === 'chatgpt_oauth' ? DEFAULT_CHATGPT_CODEX_BASE_URL : DEFAULT_OPENAI_BASE_URL;
}

function buildOpenAIHeaders(
  auth: OpenAIResponsesBridgeAuth,
  resolvedAuth?: ResolvedResponsesAuth
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolvedAuth?.apiKey ?? auth.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (auth.source === 'chatgpt_oauth') {
    const accountId = resolvedAuth?.accountId ?? auth.accountId;
    if (accountId) {
      // Matches Codex's BearerAuthProvider for ChatGPT-backed Codex requests.
      headers['ChatGPT-Account-ID'] = accountId;
    }
    if (resolvedAuth?.isFedrampAccount ?? auth.isFedrampAccount) {
      headers['X-OpenAI-Fedramp'] = 'true';
    }
  }
  return headers;
}

async function refreshOpenAIResponsesAuth(
  auth: OpenAIResponsesBridgeAuth
): Promise<ResolvedResponsesAuth | null> {
  if (auth.source !== 'chatgpt_oauth' || !auth.refreshAuthTokens) return null;
  const refreshed = await auth.refreshAuthTokens();
  if (!refreshed) return null;
  return {
    apiKey: refreshed.accessToken,
    accountId: refreshed.accountId,
    isFedrampAccount: refreshed.isFedrampAccount,
  };
}

function readUsageNumber(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFirstUsageNumber(
  record: Record<string, unknown> | undefined,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = readUsageNumber(record, key);
    if (value !== null) return value;
  }
  return null;
}

function responseUsage(response: Record<string, unknown> | undefined): {
  inputTokens?: number | null;
  outputTokens: number;
  reasoningTokens?: number | null;
} {
  const usage = response?.usage;
  const usageRecord =
    usage && typeof usage === 'object' && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : undefined;
  const outputTokensDetails = usageRecord?.output_tokens_details;
  const detailsRecord =
    outputTokensDetails &&
    typeof outputTokensDetails === 'object' &&
    !Array.isArray(outputTokensDetails)
      ? (outputTokensDetails as Record<string, unknown>)
      : undefined;
  return {
    inputTokens: readFirstUsageNumber(usageRecord, [
      'input_tokens',
      'prompt_tokens',
      'inputTokens',
    ]),
    outputTokens:
      readFirstUsageNumber(usageRecord, ['output_tokens', 'completion_tokens', 'outputTokens']) ??
      0,
    reasoningTokens: readFirstUsageNumber(detailsRecord, ['reasoning_tokens']),
  };
}

function streamErrorMessage(event: OpenAIStreamEvent): string {
  if (typeof event.error?.message === 'string') return event.error.message;
  const responseError = event.response?.error;
  if (responseError && typeof responseError === 'object' && !Array.isArray(responseError)) {
    const message = (responseError as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'OpenAI Responses API error';
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseOpenAIError(status: number, text: string): string {
  const parsed = parseJsonObject(text);
  const error = parsed?.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return text || `OpenAI API request failed with status ${status}`;
}

/**
 * True when a JSON body is an error response, vs. a non-streaming success body.
 * Recognizes three shapes so a non-transient 200-with-JSON-error surfaces as a
 * terminal error instead of letting the empty-stream guard relabel it as a
 * retryable overload:
 *   - OpenAI/Anthropic wrapped `error` field,
 *   - RFC 7807 `detail`, or
 *   - a FLAT body carrying only a recognized top-level error type/code, e.g.
 *     `{"type":"invalid_request_error","message":"bad input"}` (no wrapper).
 */
function isJsonErrorBody(text: string): boolean {
  const parsed = parseJsonObject(text);
  if (!parsed) return false;
  // `!= null` (not `!== undefined`): a success body may carry `"error": null`,
  // which must NOT be treated as an error.
  if (parsed.error != null || parsed.detail != null) return true;
  // A flat error (no error/detail wrapper) may carry only a recognized error
  // type/code/status at the top level — a symbolic name (e.g.
  // `invalid_request_error`), a terminal provider code (`model_not_found`), or a
  // numeric 4xx/5xx (`401`). Recognize any of them so the body routes here
  // (terminal JSON-error path) rather than to the SSE parser, which sees no
  // events and would relabel the permanent failure as overloaded_error. Accepts
  // number-or-string, so a numeric `code`/`status` is covered too.
  return (
    isProviderErrorCodeOrType(parsed.type) ||
    isProviderErrorCodeOrType(parsed.code) ||
    isProviderErrorCodeOrType(parsed.status)
  );
}

/**
 * Extract a numeric HTTP status embedded in a JSON error body, so a
 * non-transient 200-with-JSON-error surfaces with its REAL classification
 * (e.g. 401 authentication_error) instead of being hardcoded to 400
 * invalid_request_error — which would mislabel a provider auth/quota failure and
 * risk tripping the fatal invalid-request circuit breaker. Recognizes, in order:
 * a numeric `error.status`/`error.code` (or RFC 7807 top-level `status`, incl.
 * its 3-digit string form), then a symbolic `error.type`/`type` (e.g.
 * `authentication_error` → 401) via the shared taxonomy. Returns undefined when
 * no embedded status or recognized symbol is present.
 */
function readEmbeddedErrorStatus(text: string): number | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const errorObj =
    parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const candidates = [errorObj?.status, parsed.status, errorObj?.code, parsed.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      const n = Math.trunc(candidate);
      if (n >= 400 && n < 600) return n;
    } else if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) {
      const n = Number(candidate);
      if (n >= 400 && n < 600) return n;
    }
  }
  // No numeric status — fall back to a symbolic type/code classification so a
  // credential/overload/rate-limit error isn't mislabeled as a 400. Some proxies
  // carry the classification in `error.code` (or a top-level `code`) rather than
  // `type`, so check both fields, nested then top-level.
  const symbolicCandidates = [
    typeof errorObj?.type === 'string' ? errorObj.type : undefined,
    typeof errorObj?.code === 'string' ? errorObj.code : undefined,
    typeof parsed.type === 'string' ? parsed.type : undefined,
    typeof parsed.code === 'string' ? parsed.code : undefined,
  ];
  for (const candidate of symbolicCandidates) {
    const symbolicStatus = httpStatusForSymbolicErrorType(candidate);
    if (symbolicStatus !== undefined) return symbolicStatus;
  }
  return undefined;
}

/** Count occurrences of each distinct value in an array, keyed by its string form. */
function countBy<T>(arr: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    const key = String(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build a compact, payload-free summary of a Responses request body for
 * diagnostic logging when the upstream rejects it (4xx).
 *
 * The ChatGPT Codex backend returns `{"detail":"Unsupported content type"}` on
 * 400 without identifying which item it rejected. This summary captures, per
 * input item: its `type`, the shapes most likely to trigger that error
 * (function_call_output.output form, function_call.status presence, reasoning
 * encrypted_content, message content block types) — without dumping potentially
 * large or sensitive text payloads.
 *
 * Item and content-block types are reported as histograms (counts per type),
 * not arrays, so a long session (hundreds of tool calls) can't balloon the log
 * line.
 */
function summarizeResponsesRequestFor4xx(body: ResponsesRequest): Record<string, unknown> {
  const input = body.input.map((item) => {
    if (item.type === 'function_call_output') {
      return {
        type: item.type,
        call_id: item.call_id,
        outputType: typeof item.output === 'string' ? 'string' : typeof item.output,
      };
    }
    if (item.type === 'function_call') {
      return {
        type: item.type,
        call_id: item.call_id,
        name: item.name,
        hasStatus: item.status !== undefined,
      };
    }
    if (item.type === 'reasoning') {
      return {
        type: item.type,
        encryptedContentLength: item.encrypted_content.length,
      };
    }
    // message
    return {
      type: item.type,
      role: item.role,
      contentBlockTypeCounts: countBy(item.content.map((block) => block.type)),
    };
  });
  return {
    model: body.model,
    inputItemCount: body.input.length,
    inputItemTypeCounts: countBy(body.input.map((i) => i.type)),
    input,
    ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}),
    ...(body.reasoning ? { reasoning: body.reasoning } : {}),
    ...(body.include ? { include: body.include } : {}),
    ...(body.tools ? { toolCount: body.tools.length } : {}),
  };
}

/** Log a 4xx upstream rejection with the translated request body summary. */
function logUpstream4xx(status: number, requestBody: ResponsesRequest, errorText: string): void {
  // 5xx is server-side, so the request-body summary is noise there.
  if (status < 400 || status >= 500) return;

  // 429 / 401 / 403 = rate-limit / quota / auth — not a request-body problem.
  // The full translated request structure is pure noise here; a short line is
  // enough to surface that the upstream rejected us.
  if (status === 429 || status === 401 || status === 403) {
    logger.warn(`openai-responses: upstream rejected (HTTP ${status}): ${errorText.slice(0, 300)}`);
    return;
  }

  // 400 / 422 / other 4xx = genuine body problem. The full summary is useful
  // for diagnosing which item was rejected, capped to bound log line size.
  const summary = summarizeResponsesRequestFor4xx(requestBody);
  const summaryJson = JSON.stringify(summary).slice(0, 1000);
  logger.warn(
    `openai-responses: upstream rejected request (HTTP ${status}): ${errorText.slice(0, 500)} | requestBodySummary=${summaryJson}`
  );
}

function parseSSEBlock(block: string): OpenAIStreamEvent | null {
  let eventType = '';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return null;
  const parsed = parseJsonObject(data);
  if (!parsed) return null;
  return {
    type: eventType || (parsed.type as string | undefined),
    ...parsed,
    // Preserve the raw SSE `event:` name. The spread above lets the payload
    // `type` overwrite it, so a flat `event: error` block whose data has a
    // different type (e.g. {"type":"server_error"}) would otherwise lose the
    // fact that it was an error frame.
    ...(eventType ? { sseEvent: eventType } : {}),
  };
}

async function* readOpenAIStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = parseSSEBlock(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSSEBlock(buffer);
    if (event) yield event;
  }
}

type PendingFunctionCall = {
  callId: string;
  name: string;
  argumentsText: string;
};

function functionCallFromEvent(event: OpenAIStreamEvent): PendingFunctionCall | null {
  if (event.type === 'response.function_call_arguments.done') {
    if (typeof event.call_id !== 'string' || typeof event.name !== 'string') return null;
    return {
      callId: event.call_id,
      name: event.name,
      argumentsText: typeof event.arguments === 'string' ? event.arguments : '{}',
    };
  }

  const item = event.item;
  if (
    event.type === 'response.output_item.done' &&
    item?.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string'
  ) {
    return {
      callId: item.call_id,
      name: item.name,
      argumentsText: typeof item.arguments === 'string' ? item.arguments : '{}',
    };
  }

  return null;
}

function isControllerInvalidStateError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    ((err as { code?: string }).code === 'ERR_INVALID_STATE' ||
      err.message.includes('Controller is already closed'))
  );
}

async function streamResponsesToAnthropic({
  openAIResponse,
  controller,
  model,
  estimatedInputTokens,
  onFunctionCallResponse,
  onReasoningItems,
  onProductive,
  modelContextWindow,
}: {
  openAIResponse: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
  model: string;
  estimatedInputTokens: number;
  onFunctionCallResponse?: (callId: string, responseId: string) => void;
  onReasoningItems?: (items: ResponsesReasoningItem[]) => void;
  /**
   * Fired once, when the first content block is produced. The request handler
   * uses it to consume the tool-turn continuation only once the stream is
   * confirmed productive — so an empty/non-productive stream that triggers a
   * retry leaves the continuation intact for the retry to reuse.
   */
  onProductive?: () => void;
  /**
   * Context window for the active model, resolved from the bridge config's models
   * list at session creation time. Takes precedence over the Codex-only
   * `getModelContextWindow()` lookup so that non-Codex models (e.g. OpenRouter
   * models with large context windows) are reported correctly to the SDK.
   */
  modelContextWindow?: number;
}): Promise<void> {
  const enc = new TextEncoder();
  let closed = false;
  const send = (chunk: string): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(enc.encode(chunk));
      return true;
    } catch (err) {
      if (isControllerInvalidStateError(err)) {
        closed = true;
        logger.warn('openai-responses: SSE controller was already closed while sending');
        return false;
      }
      throw err;
    }
  };
  const closeController = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch (err) {
      if (!isControllerInvalidStateError(err)) throw err;
      logger.warn('openai-responses: SSE controller was already closed while closing');
    }
  };
  const messageId = generateMsgId();
  let started = false;
  let textOpen = false;
  let thinkingOpen = false;
  let thinkingBlockIndex = -1;
  let blockIndex = 0;
  let heuristicOutputTokens = 0;
  let completedUsage: {
    inputTokens?: number | null;
    outputTokens: number;
    reasoningTokens?: number | null;
  } | null = null;
  let incomplete = false;
  // True once any content block (text / thinking / tool_use) has been emitted.
  // The bridge commits HTTP 200 before reading the upstream body (see the
  // fire-and-forget streamResponsesToAnthropic at the call site), so when the
  // upstream returns a non-productive 200 (overload / aborted) we cannot retry
  // at the transport layer. If this stays false after the stream completes, we
  // surface a retryable overloaded_error SSE instead of an empty end_turn — an
  // empty turn is malformed per the Messages spec and the SDK would otherwise
  // fail the turn terminally (the compaction-killer this guards against).
  let producedContent = false;
  // True once any non-empty text/refusal was STREAMED (via output_text.delta /
  // refusal.delta). Used to suppress re-emitting the same text from the
  // response.completed output array, which some upstreams include alongside the
  // deltas (otherwise the assistant text would be duplicated).
  let streamedText = false;
  // True once any non-empty thinking was STREAMED (via reasoning_summary_text /
  // reasoning_text deltas). Used to suppress re-emitting the same summary from a
  // terminal reasoning item's `summary` array in one-shot (delta-less) responses.
  let streamedThinking = false;
  // Set producedContent and fire onProductive once, on the first content block.
  // The early-return makes producedContent double as the "already notified" flag,
  // so onProductive fires exactly once without a second boolean.
  const markProducedContent = (): void => {
    if (producedContent) return;
    producedContent = true;
    onProductive?.();
  };
  const emittedFunctionCalls = new Set<string>();
  const responseReasoningItems: ResponsesReasoningItem[] = [];

  const ensureStarted = (): boolean => {
    if (started) return !closed;
    started = true;
    return send(
      messageStartSSE(
        messageId,
        model,
        estimatedInputTokens,
        resolveContextWindow(model, modelContextWindow)
      )
    );
  };

  const closeTextBlock = () => {
    if (!textOpen) return;
    if (!send(contentBlockStopSSE(blockIndex))) return;
    blockIndex++;
    textOpen = false;
  };

  const startThinkingBlock = () => {
    if (thinkingOpen) return;
    ensureStarted();
    closeTextBlock();
    thinkingBlockIndex = blockIndex;
    send(contentBlockStartThinkingSSE(thinkingBlockIndex));
    thinkingOpen = true;
    markProducedContent();
  };

  const closeThinkingBlock = () => {
    if (!thinkingOpen) return;
    send(contentBlockStopSSE(thinkingBlockIndex));
    blockIndex++;
    thinkingOpen = false;
    thinkingBlockIndex = -1;
  };

  const emitFunctionCall = (call: PendingFunctionCall) => {
    if (emittedFunctionCalls.has(call.callId)) return;
    if (!ensureStarted()) return;
    closeThinkingBlock();
    closeTextBlock();
    if (!send(contentBlockStartToolUseSSE(blockIndex, call.callId, call.name))) return;
    markProducedContent();
    if (!send(inputJsonDeltaSSE(blockIndex, call.argumentsText || '{}'))) return;
    if (!send(contentBlockStopSSE(blockIndex))) return;
    blockIndex++;
    emittedFunctionCalls.add(call.callId);
  };

  /**
   * Open a text block and emit a non-empty text delta, marking the turn
   * productive. An empty delta (e.g. an empty output_text.delta frame) is a
   * no-op — it must not open an empty block or mark the turn productive, or the
   * empty-stream guard would be skipped and an empty end_turn emitted.
   */
  const emitTextContent = (delta: string) => {
    if (!delta) return;
    ensureStarted();
    closeThinkingBlock();
    if (!textOpen) {
      send(contentBlockStartTextSSE(blockIndex));
      textOpen = true;
      markProducedContent();
    }
    send(textDeltaSSE(blockIndex, delta));
    heuristicOutputTokens += Math.max(1, Math.ceil(delta.length / 4));
  };

  /**
   * Extract content items from a terminal response object's `output` array
   * (function_call / reasoning / message). Shared by the `response.completed`
   * and `response.incomplete` handlers so a one-shot (non-streamed) response —
   * whose entire payload lives in the output array, with no preceding delta
   * frames — surfaces its text/tools instead of being mistaken for an empty
   * stream. Text/refusal emission is a FALLBACK guarded by `!streamedText`, so
   * the same content already delivered as deltas is not duplicated.
   */
  const extractOutputItems = (response: Record<string, unknown> | undefined): void => {
    const output = response?.output;
    if (!Array.isArray(output)) return;
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.type === 'function_call') {
        // Skip a function_call whose arguments the token limit interrupted
        // (item status `incomplete`): emitting it would set a tool_use stop
        // reason that shadows max_tokens, and the SDK would attempt an
        // unfinished/default-`{}` invocation. Only terminal (completed) calls
        // are emitted; absent status is treated as completed for back-compat.
        if (
          record.status !== 'incomplete' &&
          typeof record.call_id === 'string' &&
          typeof record.name === 'string'
        ) {
          emitFunctionCall({
            callId: record.call_id,
            name: record.name,
            argumentsText: typeof record.arguments === 'string' ? record.arguments : '{}',
          });
        }
      }
      if (record.type === 'reasoning') {
        // Collect encrypted reasoning for multi-turn continuation. Encrypted
        // reasoning alone is NOT displayable, so it does not mark the turn
        // productive — a reasoning-only turn stays non-productive so it hits the
        // empty-stream guard (and the reasoning cache gate preserves the prior
        // turn's cache on a retried turn).
        const encrypted =
          typeof record.encrypted_content === 'string' ? record.encrypted_content : undefined;
        if (encrypted) {
          responseReasoningItems.push({ type: 'reasoning', encrypted_content: encrypted });
        }
        // The visible reasoning SUMMARY (summary_text entries), however, IS
        // displayable — the streaming path emits it as thinking deltas. For a
        // one-shot (delta-less) response, emit it here so a turn whose only
        // visible content is reasoning isn't mistaken for an empty stream
        // (mislabeled as overload when completed, or contentless when
        // incomplete). FALLBACK only: if the same summary was already streamed
        // as deltas, emitting it again would duplicate the thinking block.
        const summary = record.summary;
        if (Array.isArray(summary) && !streamedThinking) {
          for (const part of summary) {
            if (!part || typeof part !== 'object') continue;
            const partRecord = part as Record<string, unknown>;
            if (partRecord.type !== 'summary_text') continue;
            const text = partRecord.text;
            if (typeof text === 'string' && text) {
              startThinkingBlock();
              send(thinkingDeltaSSE(thinkingBlockIndex, text));
              heuristicOutputTokens += Math.max(1, Math.ceil(text.length / 4));
            }
          }
        }
      }
      if (record.type === 'message') {
        // output_text → text; refusal → text (a refusal is the assistant's text
        // response). Symmetric to the streamed refusal.delta handling, so content
        // delivered only in the output array isn't mistaken for an empty stream.
        const content = record.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const blockRecord = block as Record<string, unknown>;
            if (!streamedText && blockRecord.type === 'output_text') {
              const text = blockRecord.text;
              if (typeof text === 'string') emitTextContent(text);
            } else if (!streamedText && blockRecord.type === 'refusal') {
              const refusal = blockRecord.refusal;
              if (typeof refusal === 'string') emitTextContent(refusal);
            }
          }
        }
      }
    }
  };

  try {
    if (!openAIResponse.body) {
      throw new Error('OpenAI API returned an empty streaming body');
    }

    for await (const event of readOpenAIStream(openAIResponse.body)) {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        // A refusal is the assistant's text response (the model declining to
        // answer); surface its delta as an ordinary text block so the SDK — and
        // the empty-stream guard below — see real content rather than an empty
        // turn that would otherwise be retried as an overload.
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) streamedText = true;
        emitTextContent(delta);
        continue;
      }

      if (event.type === 'response.reasoning_summary_part.added') {
        // Part marker only — wait for the actual thinking delta before opening a
        // block, so an empty/aborted reasoning stream (only an `added` frame, or
        // empty deltas) isn't marked productive and isn't mistaken for content.
        continue;
      }
      if (
        event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta'
      ) {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          // Open the thinking block (and mark the turn productive) only once
          // real reasoning text arrives.
          streamedThinking = true;
          startThinkingBlock();
          send(thinkingDeltaSSE(thinkingBlockIndex, delta));
          heuristicOutputTokens += Math.max(1, Math.ceil(delta.length / 4));
        }
        continue;
      }

      if (
        event.type === 'response.reasoning_summary_part.done' ||
        event.type === 'response.reasoning_summary_text.done' ||
        event.type === 'response.reasoning_text.done'
      ) {
        closeThinkingBlock();
        continue;
      }

      const call = functionCallFromEvent(event);
      if (call) {
        emitFunctionCall(call);
        continue;
      }

      if (event.type === 'response.completed') {
        completedUsage = responseUsage(event.response);
        const responseId = typeof event.response?.id === 'string' ? event.response.id : undefined;
        extractOutputItems(event.response);
        if (responseId) {
          for (const callId of emittedFunctionCalls) {
            onFunctionCallResponse?.(callId, responseId);
          }
        }
        // NOTE: onReasoningItems is deferred to after the stream completes (see
        // the fall-through below) so a non-productive completion does not
        // overwrite the last successful turn's cached reasoning.
        continue;
      }

      if (event.type === 'response.incomplete') {
        incomplete = true;
        completedUsage = responseUsage(event.response);
        // A one-shot (non-streamed) incomplete response carries its partial
        // output only in the output array. Extract it so partial text is
        // surfaced (with a max_tokens stop reason, set below) rather than lost,
        // and so a contentless incomplete turn is not retried as an overload.
        extractOutputItems(event.response);
        continue;
      }

      const sseEvent = (event as { sseEvent?: string }).sseEvent;
      // An error frame is signalled by the payload type (`error` /
      // `response.failed`), the raw SSE `event:` name, OR a data-only frame
      // whose payload `type`/`code` is ANY recognized error indicator — a
      // symbolic name (transient or terminal), a terminal provider code, or a
      // numeric 4xx/5xx. Admitting terminal codes too prevents a permanent
      // error data-only frame from falling through to the empty-stream guard
      // and being retried as an overloaded_error.
      if (
        event.type === 'response.failed' ||
        event.type === 'error' ||
        sseEvent === 'error' ||
        sseEvent === 'response.failed' ||
        (event.type !== undefined && isProviderErrorCodeOrType(event.type))
      ) {
        ensureStarted();
        closeThinkingBlock();
        closeTextBlock();
        // Classify a transient mid-stream error (rate_limit / overloaded) so the
        // correct Anthropic type surfaces. The SDK cannot retry a stream it has
        // already started, but the right type lets the query-runner (B4)
        // recognise and re-issue the whole query.
        // `response.failed` carries the error under `event.response.error`; the
        // `error` event under `event.error`; some upstreams put code/message at
        // the event top level. Inspect whichever shape the upstream used.
        const responseObject = event.response;
        const responseError =
          responseObject && typeof responseObject === 'object'
            ? (responseObject as Record<string, unknown>).error
            : undefined;
        const flatEvent = event as Record<string, unknown>;
        const topLevelError: Record<string, unknown> = {};
        // Accept numeric codes (e.g. {"code":429}) and RFC 7807 problem-detail
        // fields (status→code, detail→message), coercing to strings.
        const rawCode = flatEvent.code;
        if (typeof rawCode === 'string') topLevelError.code = rawCode;
        else if (typeof rawCode === 'number' && Number.isFinite(rawCode))
          topLevelError.code = String(rawCode);
        else {
          const rawStatus = flatEvent.status;
          if (typeof rawStatus === 'string') topLevelError.code = rawStatus;
          else if (typeof rawStatus === 'number' && Number.isFinite(rawStatus))
            topLevelError.code = String(rawStatus);
        }
        if (typeof flatEvent.message === 'string') topLevelError.message = flatEvent.message;
        else if (typeof flatEvent.detail === 'string') topLevelError.message = flatEvent.detail;
        // The payload `type` is the error category when it is not the literal
        // event discriminator ("error" / "response.failed").
        if (
          typeof flatEvent.type === 'string' &&
          flatEvent.type !== 'error' &&
          flatEvent.type !== 'response.failed'
        )
          topLevelError.type = flatEvent.type;
        const errorBody =
          event.error ??
          responseError ??
          (Object.keys(topLevelError).length > 0 ? topLevelError : undefined);
        const normalized = normalizeOpenAiUpstreamError(
          JSON.stringify({ error: errorBody ?? {} }),
          200
        );
        const bodyMessage =
          errorBody && typeof (errorBody as Record<string, unknown>).message === 'string'
            ? ((errorBody as Record<string, unknown>).message as string)
            : undefined;
        // A transient payload (rate_limit / overloaded) is classified by the
        // normalizer. A terminal payload (e.g. invalid_request_error,
        // authentication_error) is NOT transient, so the normalizer returns null
        // — surface its real Anthropic type (derived from the symbolic payload)
        // so the upstream diagnostic is visible and the error is not retried.
        // Keep the retryable `api_error` default only for a bare/unknown error
        // (no recognizable type), matching prior behavior.
        let errorType: AnthropicErrorType;
        if (normalized) {
          errorType = normalized.type;
        } else {
          const symbolicStatus = httpStatusForSymbolicErrorType(
            typeof topLevelError.type === 'string' ? topLevelError.type : undefined
          );
          errorType =
            symbolicStatus !== undefined
              ? anthropicErrorTypeForHttpStatus(symbolicStatus)
              : 'api_error';
        }
        send(errorSSE(errorType, bodyMessage ?? streamErrorMessage(event)));
        send(messageStopSSE());
        closeController();
        return;
      }
    }

    ensureStarted();
    closeThinkingBlock();
    closeTextBlock();
    // Cache this turn's reasoning for multi-turn continuation whenever the turn
    // is ACCEPTED — i.e. it is NOT about to be retried as an overloaded error.
    // The only retried case is a fully contentless, non-incomplete stream
    // (`!producedContent && !incomplete`), which hits the guard below and would
    // have its (reasoning-only or empty) cache corrupt the retry
    // (anthropicMessagesToResponsesInput would reinsert it before the wrong user
    // message, and a nonempty cache disables the previous_response_id path on
    // tool-result turns). A contentless `response.incomplete`, by contrast, is
    // ACCEPTED as a max_tokens turn — not retried — so it must still refresh the
    // cache (replacing the prior turn's reasoning, or clearing it when this turn
    // added none); otherwise the next user turn reuses stale reasoning from an
    // older assistant turn and can alter the request or trip a stale-reasoning
    // 400. Deferring past the loop lets us distinguish retried vs accepted here.
    if (producedContent || incomplete) {
      onReasoningItems?.(responseReasoningItems);
    }
    // The upstream returned 200 and the stream completed without an error event,
    // yet produced ZERO content blocks (no text / reasoning / tool_use) and was
    // not truncated by max_output_tokens. An empty Anthropic turn is malformed per
    // the Messages spec, and because the bridge already committed the 200 headers
    // before reading the body, the SDK cannot retry it at the transport layer.
    // Emit a retryable overloaded_error SSE instead of an empty end_turn: the SDK
    // surfaces the overloaded_error type (see core/streaming.js), the query-runner
    // (B4) recognises 'overloaded' as a transient provider error, and re-issues
    // the whole query — so compaction self-heals instead of dying on the empty
    // 200. This is the failure mode that killed compaction on very large OpenAI
    // requests (empty/non-productive 200).
    //
    // A contentless `response.incomplete` is excluded: that is max_output_tokens
    // exhaustion (the model spent its budget on reasoning before any visible
    // output), not a transient overload — retrying would not help — so it falls
    // through to the `max_tokens` stop reason below.
    if (!producedContent && !incomplete) {
      logger.warn(
        'openai-responses: upstream 200 produced an empty stream with no content ' +
          'blocks; surfacing as retryable overloaded_error instead of an empty end_turn'
      );
      send(
        errorSSE(
          'overloaded_error',
          'OpenAI returned an empty response stream (HTTP 200, no content blocks) — ' +
            'likely a transient overloaded response.'
        )
      );
      send(messageStopSSE());
      closeController();
      return;
    }
    // If the model emitted tool calls before an incomplete event, let the SDK execute
    // them; the follow-up turn can carry the continuation forward.
    const stopReason =
      emittedFunctionCalls.size > 0 ? 'tool_use' : incomplete ? 'max_tokens' : 'end_turn';
    send(
      messageDeltaSSE(stopReason, {
        inputTokens: completedUsage?.inputTokens ?? estimatedInputTokens,
        outputTokens: completedUsage?.outputTokens || heuristicOutputTokens,
        thinkingTokens: completedUsage?.reasoningTokens,
        modelContextWindow: resolveContextWindow(model, modelContextWindow),
      })
    );
    send(messageStopSSE());
    closeController();
  } catch (err) {
    if (isControllerInvalidStateError(err)) {
      closed = true;
      logger.warn('openai-responses: SSE controller closed during streaming');
      return;
    }
    logger.error('openai-responses: streaming failed:', err);
    try {
      ensureStarted();
      closeThinkingBlock();
      closeTextBlock();
      send(errorSSE('api_error', err instanceof Error ? err.message : 'OpenAI streaming failed'));
      send(messageStopSSE());
    } finally {
      closeController();
    }
  }
}

export const _openAIResponsesBridgeServerTesting = {
  streamResponsesToAnthropic,
  summarizeResponsesRequestFor4xx,
  logUpstream4xx,
};

function modelsListResponse(models: OpenAIResponsesBridgeModel[]): object {
  const data = models.map((model) => {
    const autoCompactTokenLimit = Math.floor(model.context_window * 0.9);
    return {
      id: model.id,
      type: 'model',
      display_name: model.display_name,
      created_at: model.created_at,
      max_input_tokens: model.context_window,
      context_window: model.context_window,
      max_context_window: model.context_window,
      model_context_window: model.context_window,
      auto_compact_token_limit: autoCompactTokenLimit,
      model_auto_compact_token_limit: autoCompactTokenLimit,
      max_tokens: model.max_tokens ?? 16384,
    };
  });
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

function resolveModelId(model: string, aliases: Record<string, string> | undefined): string {
  return aliases?.[model] ?? model;
}

export function createOpenAIResponsesBridgeServer(
  config: OpenAIResponsesBridgeConfig
): OpenAIResponsesBridgeServer {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.openAIBaseUrl ?? defaultBaseUrlForAuth(config.auth);
  const modelsResponse = modelsListResponse(config.models);
  // Build a model ID → context_window lookup from the bridge config's models
  // list. This includes both Codex models and any non-Codex models passed at
  // bridge creation time (e.g. OpenRouter models with 1M+ context). The lookup
  // is used by the streaming path to report the correct context window to the SDK
  // instead of falling back to the Codex-only getModelContextWindow().
  const contextWindowByModelId = new Map<string, number>();
  for (const model of config.models) {
    contextWindowByModelId.set(model.id, model.context_window);
  }
  // Also index by aliases so that resolved alias → context_window works.
  if (config.modelAliases) {
    for (const [alias, modelId] of Object.entries(config.modelAliases)) {
      const cw = contextWindowByModelId.get(modelId);
      if (cw !== undefined) {
        contextWindowByModelId.set(alias, cw);
      }
    }
  }
  const continuationTtlMs = config.continuationTtlMs ?? DEFAULT_RESPONSE_CONTINUATION_TTL_MS;
  const continuations = new Map<string, ResponseContinuation>();
  // Per-session reasoning items for multi-turn continuation when store: false.
  const sessionReasoningItems = new Map<string, SessionReasoningEntry>();
  // Per-session thinking config injected by the daemon when the Anthropic SDK client
  // (Claude Code CLI) omits the thinking field from request bodies.
  const sessionThinkingConfigs = new Map<string, SessionThinkingConfigEntry>();
  // Per-session model overrides. When the SDK sends a model ID that differs from
  // the upstream model ID (e.g., aliased Anthropic IDs for Copilot, or any
  // provider using model ID translation), this map lets the daemon override the
  // default mapping per session. For providers using real model IDs directly
  // (Codex, GLM, Kimi), the SDK and upstream IDs are typically the same.
  // Keyed by (sessionId, sdkModelId) so different SDK tiers within the same
  // session are independently overridden and fallback model registration does
  // not clobber the primary model's override.
  const sessionModelAliasOverrides = new Map<string, string>();
  let resolvedAuth: ResolvedResponsesAuth | undefined;
  // ChatGPT Codex endpoint rejects max_output_tokens and parallel_tool_calls.
  const isChatgptOAuth = config.auth.source === 'chatgpt_oauth' && !config.openAIBaseUrl;
  const buildOpts = {
    includeMaxOutputTokens: !isChatgptOAuth,
    includeParallelToolCalls: !isChatgptOAuth,
    isChatgptOAuth,
  };

  const deleteContinuation = (sessionId: string, callId: string): void => {
    const key = continuationKey(sessionId, callId);
    const continuation = continuations.get(key);
    if (!continuation) return;
    clearTimeout(continuation.cleanupTimer);
    continuations.delete(key);
  };

  const storeContinuation = (sessionId: string, callId: string, responseId: string): void => {
    deleteContinuation(sessionId, callId);
    const key = continuationKey(sessionId, callId);
    const cleanupTimer = setTimeout(() => {
      logger.warn(
        `openai-responses: continuation TTL expired sessionId=${sessionId} callId=${callId}`
      );
      continuations.delete(key);
    }, continuationTtlMs);
    continuations.set(key, { responseId, cleanupTimer });
  };

  const deleteReasoningItems = (sessionId: string): void => {
    const entry = sessionReasoningItems.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.cleanupTimer);
    sessionReasoningItems.delete(sessionId);
  };

  const storeReasoningItems = (sessionId: string, items: ResponsesReasoningItem[]): void => {
    deleteReasoningItems(sessionId);
    const cleanupTimer = setTimeout(() => {
      logger.warn(`openai-responses: reasoning items TTL expired sessionId=${sessionId}`);
      sessionReasoningItems.delete(sessionId);
    }, continuationTtlMs);
    sessionReasoningItems.set(sessionId, { items, cleanupTimer });
  };

  const deleteSessionThinkingConfig = (sessionId: string): void => {
    sessionThinkingConfigs.delete(sessionId);
  };

  const storeSessionThinkingConfig = (
    sessionId: string,
    thinking: AnthropicRequest['thinking']
  ): void => {
    deleteSessionThinkingConfig(sessionId);
    sessionThinkingConfigs.set(sessionId, { thinking });
  };

  const sessionModelKey = (sessionId: string, aliasModelId: string): string =>
    `${sessionId}\0${aliasModelId}`;

  const _deleteSessionModelAliasOverrides = (sessionId: string): void => {
    for (const key of sessionModelAliasOverrides.keys()) {
      if (key.startsWith(`${sessionId}\0`)) {
        sessionModelAliasOverrides.delete(key);
      }
    }
  };

  const consumeContinuation = (
    sessionId: string,
    continuation:
      | { previousResponseId: string; input: ResponsesInputItem[]; callIds: string[] }
      | undefined
  ): void => {
    for (const callId of continuation?.callIds ?? []) {
      deleteContinuation(sessionId, callId);
    }
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const route = extractSessionId(req);

      if (route.pathname === '/health' || route.pathname === '/v1/health') {
        return new Response('ok');
      }

      if (route.pathname === '/v1/models' && req.method === 'GET') {
        return new Response(JSON.stringify(modelsResponse), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (route.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        try {
          const body = (await req.json()) as AnthropicRequest;
          const storedReasoning = sessionReasoningItems.get(route.sessionId)?.items;
          let continuation = resolveContinuation(route.sessionId, body.messages, continuations);
          if (storedReasoning && storedReasoning.length > 0) {
            continuation = undefined;
          }
          const inputTokens = continuation
            ? estimateResponsesPayloadTokens(body, continuation.input)
            : estimateResponsesPayloadTokens(
                body,
                anthropicMessagesToResponsesInput(body.messages, storedReasoning)
              );
          return new Response(JSON.stringify({ input_tokens: inputTokens }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch {
          return sendJsonError(400, 'invalid_request_error', 'Bad Request');
        }
      }

      if (route.pathname !== '/v1/messages' || req.method !== 'POST') {
        return sendJsonError(501, 'api_error', 'Not implemented');
      }

      let body: AnthropicRequest;
      try {
        body = (await req.json()) as AnthropicRequest;
      } catch {
        return sendJsonError(400, 'invalid_request_error', 'Bad Request: invalid JSON');
      }

      // The Claude Code CLI handles thinking internally and does not include the
      // thinking field in Anthropic Messages API requests. Merge the per-session
      // thinking config injected by the daemon so reasoning is forwarded to OpenAI.
      // If the SDK sends a non-enabled thinking payload (e.g. {type:'adaptive'}),
      // override it with the session's explicit enabled config.
      const sessionThinkingEntry = sessionThinkingConfigs.get(route.sessionId);
      if (sessionThinkingEntry?.thinking && (!body.thinking || body.thinking.type !== 'enabled')) {
        body = { ...body, thinking: sessionThinkingEntry.thinking };
      }

      if (!body.model || !Array.isArray(body.messages)) {
        return sendJsonError(
          400,
          'invalid_request_error',
          'Missing required fields: model and messages'
        );
      }
      if (body.stream === false) {
        return sendJsonError(
          400,
          'invalid_request_error',
          'Only streaming responses are supported'
        );
      }

      let model = resolveModelId(body.model, config.modelAliases);
      const sessionId = route.sessionId;
      // If the daemon has registered a per-(session, alias) model override, use it
      // so the originally-selected Codex model is preserved upstream. This only
      // overrides when the incoming model matches the registered alias, so different
      // SDK tiers (opus/sonnet/haiku) are independently resolved.
      const sessionModelOverride = sessionModelAliasOverrides.get(
        sessionModelKey(sessionId, body.model)
      );
      if (sessionModelOverride) {
        model = sessionModelOverride;
      }
      const resolvedContinuation = isChatgptOAuth
        ? undefined
        : resolveContinuation(sessionId, body.messages, continuations);
      let continuation = resolvedContinuation;
      // When reasoning items are stored for this session, we must send full history
      // (previous_response_id doesn't work with store:false for reasoning).
      const storedReasoning = sessionReasoningItems.get(sessionId)?.items;
      if (storedReasoning && storedReasoning.length > 0) {
        continuation = undefined;
      }
      let requestBody: ResponsesRequest;
      try {
        requestBody = buildResponsesRequest(body, model, continuation, buildOpts, storedReasoning);
      } catch (err) {
        return sendJsonError(
          400,
          'invalid_request_error',
          err instanceof Error ? err.message : 'Bad Request'
        );
      }
      const upstreamUrl = `${baseUrl.replace(/\/$/, '')}/responses`;
      let openAIResponse: Response;
      try {
        openAIResponse = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: buildOpenAIHeaders(config.auth, resolvedAuth),
          body: JSON.stringify(requestBody),
        });
        if (openAIResponse.status === 401) {
          const refreshed = await refreshOpenAIResponsesAuth(config.auth);
          if (refreshed) {
            resolvedAuth = refreshed;
            openAIResponse = await fetchImpl(upstreamUrl, {
              method: 'POST',
              headers: buildOpenAIHeaders(config.auth, resolvedAuth),
              body: JSON.stringify(requestBody),
            });
          }
        }
        if (continuation && !openAIResponse.ok && openAIResponse.status === 400) {
          const errorText = await openAIResponse.text();
          if (errorText.includes('previous_response_id')) {
            logger.warn(
              'openai-responses: endpoint rejects previous_response_id, retrying with full history'
            );
            try {
              requestBody = buildResponsesRequest(
                body,
                model,
                undefined,
                buildOpts,
                storedReasoning
              );
            } catch (err) {
              return sendJsonError(
                400,
                'invalid_request_error',
                err instanceof Error ? err.message : 'Bad Request'
              );
            }
            openAIResponse = await fetchImpl(upstreamUrl, {
              method: 'POST',
              headers: buildOpenAIHeaders(config.auth, resolvedAuth),
              body: JSON.stringify(requestBody),
            });
            continuation = undefined;
          } else {
            logUpstream4xx(openAIResponse.status, requestBody, errorText);
            // The 400 isn't about previous_response_id — still inspect the body
            // for a transient signal (a proxy may return 400 with a structured
            // rate_limit/server body) before falling back to invalid_request.
            const normalized = normalizeOpenAiUpstreamError(errorText, openAIResponse.status);
            if (normalized) {
              logger.warn(
                `openai-responses: normalized continuation 400 to retryable ` +
                  `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
              );
              return sendRetryableUpstreamError(normalized);
            }
            return sendJsonError(
              openAIResponse.status,
              anthropicErrorTypeForHttpStatus(openAIResponse.status),
              parseOpenAIError(openAIResponse.status, errorText)
            );
          }
        }
        // Reasoning `encrypted_content` replay can trigger a 400
        // "Unsupported content type" on the ChatGPT Codex backend when the
        // encrypted blob is stale (e.g. after an SDK context rewrite). The
        // error is terminal for the worker turn, so retry once without the
        // replayed reasoning items so the turn completes. The streaming
        // response refreshes/clears the per-session reasoning cache via
        // onReasoningItems, so subsequent turns stop replaying the bad blob.
        if (
          !openAIResponse.ok &&
          openAIResponse.status === 400 &&
          requestBody.input.some((item) => item.type === 'reasoning')
        ) {
          const errorText = await openAIResponse.text();
          logUpstream4xx(openAIResponse.status, requestBody, errorText);
          // A transient 400 (rate_limit/overload in the body) is NOT a
          // stale-reasoning failure. Normalize it to retryable so the SDK
          // retries with backoff, instead of self-healing by dropping reasoning
          // (which would mask the real rate-limit and skip the SDK retry path).
          const reasoningNormalized = normalizeOpenAiUpstreamError(
            errorText,
            openAIResponse.status
          );
          if (reasoningNormalized) {
            logger.warn(
              `openai-responses: normalized reasoning 400 to retryable ` +
                `${reasoningNormalized.type} (${reasoningNormalized.status}): ${reasoningNormalized.message.slice(0, 200)}`
            );
            return sendRetryableUpstreamError(reasoningNormalized);
          }
          logger.warn(
            'openai-responses: 400 with replayed reasoning present — retrying once without reasoning items'
          );
          try {
            requestBody = buildResponsesRequest(body, model, continuation, buildOpts, undefined);
          } catch (err) {
            return sendJsonError(
              400,
              'invalid_request_error',
              err instanceof Error ? err.message : 'Bad Request'
            );
          }
          openAIResponse = await fetchImpl(upstreamUrl, {
            method: 'POST',
            headers: buildOpenAIHeaders(config.auth, resolvedAuth),
            body: JSON.stringify(requestBody),
          });
        }
      } catch (err) {
        logger.warn('openai-responses: upstream request failed:', err);
        return sendJsonError(
          502,
          'api_error',
          err instanceof Error ? err.message : 'OpenAI API request failed'
        );
      }

      if (!openAIResponse.ok) {
        const text = await openAIResponse.text();
        logUpstream4xx(openAIResponse.status, requestBody, text);
        // Inspect the BODY for transient signals (rate_limit_exceeded /
        // server_error / overload text) the status alone misses — e.g. a 4xx
        // carrying a rate-limit body. Reclassify so the SDK retries.
        const normalized = normalizeOpenAiUpstreamError(text, openAIResponse.status);
        if (normalized) {
          logger.warn(
            `openai-responses: normalized upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        return sendJsonError(
          openAIResponse.status,
          anthropicErrorTypeForHttpStatus(openAIResponse.status),
          parseOpenAIError(openAIResponse.status, text)
        );
      }

      // Some Responses-compatible proxies return 200 with a JSON error body
      // instead of an SSE stream. With no SSE events the streamer below would
      // emit a successful empty end_turn, hiding a body-embedded transient
      // error. Only pre-buffer when the content-type explicitly says JSON — a
      // real SSE stream with a missing/mislabeled content-type flows straight
      // through to the streamer, which separately detects a non-productive
      // empty SSE stream and surfaces a retryable overloaded_error.
      const upstreamContentType = openAIResponse.headers.get('content-type') ?? '';
      if (openAIResponse.ok && isJsonContentType(upstreamContentType)) {
        const bodyText = await openAIResponse.text();
        const normalized = normalizeOpenAiUpstreamError(bodyText, openAIResponse.status);
        if (normalized) {
          logger.warn(
            `openai-responses: normalized 200-with-body upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        // A non-transient JSON *error* body (e.g. invalid_request_error) must
        // surface as a terminal error. Otherwise the JSON yields no SSE events
        // and the empty-stream guard below would relabel it as a retryable
        // overload, causing repeated requests that hide the upstream diagnostic.
        // A JSON body that is NOT an error (e.g. a non-streaming success) still
        // flows through to the streamer.
        if (isJsonErrorBody(bodyText)) {
          // Derive the terminal status/type from the embedded error when present,
          // so an auth/quota failure (e.g. embedded 401 authentication_error)
          // surfaces with its real classification rather than a hardcoded 400
          // invalid_request_error (which could trip the fatal invalid-request
          // circuit breaker).
          const embeddedStatus = readEmbeddedErrorStatus(bodyText);
          const errorStatus = embeddedStatus ?? 400;
          logger.warn(
            `openai-responses: upstream returned a non-transient JSON error (HTTP 200 → ${errorStatus}): ` +
              `${parseOpenAIError(openAIResponse.status, bodyText).slice(0, 200)}`
          );
          return sendJsonError(
            errorStatus,
            anthropicErrorTypeForHttpStatus(errorStatus),
            parseOpenAIError(openAIResponse.status, bodyText)
          );
        }
        // Non-error JSON: a Responses-compatible endpoint may have ignored
        // stream:true and returned a one-shot JSON response. Wrap a recognizable
        // response object as a terminal SSE event so the streamer emits its
        // output instead of seeing no events and retrying as overloaded. Preserve
        // the object's own terminal status: an `incomplete` response (e.g.
        // max_output_tokens exhaustion) must surface as `response.incomplete` so
        // the bridge reports `max_tokens` (and skips the empty-stream overload
        // guard) rather than mislabeling truncation as a clean `end_turn`.
        const parsedResponse = parseJsonObject(bodyText);
        if (
          parsedResponse &&
          (parsedResponse.output !== undefined ||
            parsedResponse.object === 'response' ||
            typeof parsedResponse.id === 'string')
        ) {
          const isIncomplete = parsedResponse.status === 'incomplete';
          const terminalType = isIncomplete ? 'response.incomplete' : 'response.completed';
          const sseBody = `event: ${terminalType}\ndata: ${JSON.stringify({
            type: terminalType,
            response: parsedResponse,
          })}\n\n`;
          openAIResponse = new Response(sseBody, {
            status: openAIResponse.status,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        } else {
          openAIResponse = new Response(bodyText, {
            status: openAIResponse.status,
            headers: { 'Content-Type': upstreamContentType },
          });
        }
      }

      const estimatedInputTokens = continuation
        ? estimateResponsesPayloadTokens(body, continuation.input)
        : estimateResponsesPayloadTokens(body, requestBody.input);
      const resolvedModelContextWindow = contextWindowByModelId.get(model);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Each HTTP request creates its own ReadableStream controller. SDK-level retries issue
          // a new /v1/messages request, so a timed-out request cannot reuse an aborted controller.
          void streamResponsesToAnthropic({
            openAIResponse,
            controller,
            model,
            estimatedInputTokens,
            ...(resolvedModelContextWindow !== undefined
              ? { modelContextWindow: resolvedModelContextWindow }
              : {}),
            ...(isChatgptOAuth
              ? {}
              : {
                  onFunctionCallResponse(callId: string, responseId: string) {
                    storeContinuation(sessionId, callId, responseId);
                  },
                }),
            onReasoningItems(items) {
              storeReasoningItems(sessionId, items);
            },
            // Consume the tool-turn continuation only once the stream produces
            // content. The bridge commits HTTP 200 before reading the body, so an
            // empty/non-productive stream surfaces as a retryable error and the
            // query-runner re-issues the turn — if the continuation were consumed
            // eagerly, the retry could no longer attach previous_response_id and
            // would resend the whole conversation.
            onProductive() {
              consumeContinuation(sessionId, resolvedContinuation);
            },
          });
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    },
  });

  const port = server.port;
  if (typeof port !== 'number') {
    throw new Error('OpenAI Responses bridge server did not bind to a TCP port');
  }

  logger.info(`openai-responses: HTTP server listening on port ${port}`);
  return {
    port,
    baseUrlForSession: (sessionId: string) =>
      `http://127.0.0.1:${port}${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`,
    setSessionThinkingConfig: (sessionId: string, thinking: AnthropicRequest['thinking']) => {
      storeSessionThinkingConfig(sessionId, thinking);
    },
    setSessionModelConfig: (sessionId: string, aliasModelId: string, realModelId: string) => {
      // Simple overwrite: last registration wins. This correctly handles
      // model switching within the same alias tier (e.g. gpt-5.3-codex →
      // gpt-5.4). When a session has a same-tier fallback model, the
      // fallback registration overwrites the primary. This is an acceptable
      // trade-off: same-tier fallbacks are rare (both models are similar),
      // while model switching is common and must work correctly.
      sessionModelAliasOverrides.set(sessionModelKey(sessionId, aliasModelId), realModelId);
    },
    stop: () => {
      for (const continuation of continuations.values()) {
        clearTimeout(continuation.cleanupTimer);
      }
      continuations.clear();
      for (const entry of sessionReasoningItems.values()) {
        clearTimeout(entry.cleanupTimer);
      }
      sessionReasoningItems.clear();
      sessionThinkingConfigs.clear();
      sessionModelAliasOverrides.clear();
      server.stop(true);
    },
  };
}
