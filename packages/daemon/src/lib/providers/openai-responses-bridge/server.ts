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
  setSessionThinkingConfig?(sessionId: string, thinking: AnthropicRequest['thinking']): void;
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
      } catch {}
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
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function estimateTextTokens(text: string | undefined): number {
  if (!text || text.length === 0) return 0;

  const characterEstimate = Math.ceil(text.length / 4);
  const lexicalPieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;

  return Math.max(1, Math.ceil((characterEstimate + lexicalPieces) / 2));
}

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

const MODELS_SUPPORTING_XHIGH_REASONING = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
]);

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

function isJsonErrorBody(text: string): boolean {
  const parsed = parseJsonObject(text);
  if (!parsed) return false;
  if (parsed.error != null || parsed.detail != null) return true;
  return (
    isProviderErrorCodeOrType(parsed.type) ||
    isProviderErrorCodeOrType(parsed.code) ||
    isProviderErrorCodeOrType(parsed.status)
  );
}

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

function countBy<T>(arr: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    const key = String(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

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

function logUpstream4xx(status: number, requestBody: ResponsesRequest, errorText: string): void {
  if (status < 400 || status >= 500) return;

  if (status === 429 || status === 401 || status === 403) {
    logger.warn(`openai-responses: upstream rejected (HTTP ${status}): ${errorText.slice(0, 300)}`);
    return;
  }

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
  onProductive?: () => void;
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
  let producedContent = false;
  let streamedText = false;
  let streamedThinking = false;
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

  const extractOutputItems = (response: Record<string, unknown> | undefined): void => {
    const output = response?.output;
    if (!Array.isArray(output)) return;
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.type === 'function_call') {
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
        const encrypted =
          typeof record.encrypted_content === 'string' ? record.encrypted_content : undefined;
        if (encrypted) {
          responseReasoningItems.push({ type: 'reasoning', encrypted_content: encrypted });
        }
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
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) streamedText = true;
        emitTextContent(delta);
        continue;
      }

      if (event.type === 'response.reasoning_summary_part.added') {
        continue;
      }
      if (
        event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta'
      ) {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
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
        continue;
      }

      if (event.type === 'response.incomplete') {
        incomplete = true;
        completedUsage = responseUsage(event.response);
        const responseId = typeof event.response?.id === 'string' ? event.response.id : undefined;
        extractOutputItems(event.response);
        if (responseId) {
          for (const callId of emittedFunctionCalls) {
            onFunctionCallResponse?.(callId, responseId);
          }
        }
        continue;
      }

      const sseEvent = (event as { sseEvent?: string }).sseEvent;
      const payload = event as Record<string, unknown>;
      if (
        event.type === 'response.failed' ||
        event.type === 'error' ||
        sseEvent === 'error' ||
        sseEvent === 'response.failed' ||
        isProviderErrorCodeOrType(payload.type) ||
        isProviderErrorCodeOrType(payload.code) ||
        isProviderErrorCodeOrType(payload.status)
      ) {
        ensureStarted();
        closeThinkingBlock();
        closeTextBlock();
        const responseObject = event.response;
        const responseError =
          responseObject && typeof responseObject === 'object'
            ? (responseObject as Record<string, unknown>).error
            : undefined;
        const flatEvent = event as Record<string, unknown>;
        const topLevelError: Record<string, unknown> = {};
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
        let errorType: AnthropicErrorType;
        if (normalized) {
          errorType = normalized.type;
        } else {
          const symbolicStatus =
            httpStatusForSymbolicErrorType(
              typeof topLevelError.type === 'string' ? topLevelError.type : undefined
            ) ??
            httpStatusForSymbolicErrorType(
              typeof topLevelError.code === 'string' ? topLevelError.code : undefined
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
    if (producedContent || incomplete) {
      onReasoningItems?.(responseReasoningItems);
    }
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
  const contextWindowByModelId = new Map<string, number>();
  for (const model of config.models) {
    contextWindowByModelId.set(model.id, model.context_window);
  }
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
  const sessionReasoningItems = new Map<string, SessionReasoningEntry>();
  const sessionThinkingConfigs = new Map<string, SessionThinkingConfigEntry>();
  const sessionModelAliasOverrides = new Map<string, string>();
  let resolvedAuth: ResolvedResponsesAuth | undefined;
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
        if (
          !openAIResponse.ok &&
          openAIResponse.status === 400 &&
          requestBody.input.some((item) => item.type === 'reasoning')
        ) {
          const errorText = await openAIResponse.text();
          logUpstream4xx(openAIResponse.status, requestBody, errorText);
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
        if (isJsonErrorBody(bodyText)) {
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
