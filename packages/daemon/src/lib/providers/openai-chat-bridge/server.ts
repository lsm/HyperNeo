import {
  type AnthropicContentBlockImage,
  type AnthropicContentBlockText,
  type AnthropicContentBlockToolResult,
  type AnthropicContentBlockToolUse,
  type AnthropicRequest,
  contentBlockStartTextSSE,
  contentBlockStartThinkingSSE,
  contentBlockStartToolUseSSE,
  contentBlockStopSSE,
  errorSSE,
  inputJsonDeltaSSE,
  messageDeltaSSE,
  messageStartSSE,
  messageStopSSE,
  textDeltaSSE,
  thinkingDeltaSSE,
} from '../provider-anthropic-compat/translator.js';
import { estimateAnthropicInputTokens } from '../provider-anthropic-compat/token-estimator.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from '../shared/error-envelope.js';
import { anthropicErrorTypeForHttpStatus } from '@hyperneo/shared/provider/error-taxonomy';
import {
  isJsonContentType,
  isOpenAiTransientErrorType,
  normalizeOpenAiUpstreamError,
} from '../shared/normalize-upstream-error.js';
import { Logger } from '../../logger.js';

const logger = new Logger('openai-chat-bridge-server');

export type OpenAIChatBridgeServer = {
  port: number;
  setSessionThinkingConfig?(sessionId: string, thinking: AnthropicRequest['thinking']): void;
  stop(): void;
};

export type OpenAIChatBridgeConfig = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  toolUseSupported?: boolean;
  visionSupported?: boolean;
  thinkingSupported?: boolean;
  modelContextWindow?: number;
  streamUsageSupported?: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
};

type OpenAIChatTextPart = { type: 'text'; text: string };
type OpenAIChatImagePart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
};
type OpenAIChatContentPart = OpenAIChatTextPart | OpenAIChatImagePart;

type OpenAIChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIChatContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; content: string; tool_call_id: string };

type OpenAIChatTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAIChatRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  stream: true;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: 'low' | 'medium' | 'high';
  chat_template_kwargs?: Record<string, unknown>;
};

type OpenAIChatStreamChoice = {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
};

type OpenAIChatStreamChunk = {
  id?: string;
  object?: string;
  choices?: OpenAIChatStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string };
};

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

function genMessageId(): string {
  return `msg_oai_${Math.random().toString(36).slice(2, 14)}`;
}

function genToolUseId(): string {
  return `toolu_oai_${Math.random().toString(36).slice(2, 14)}`;
}

function imageBlockToImageUrl(block: AnthropicContentBlockImage): string {
  if (block.source.type === 'url') return block.source.url;
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

function toolResultToText(result: AnthropicContentBlockToolResult): string {
  if (typeof result.content === 'string') return result.content;
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

function extractSystemText(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n');
}

function toOpenAIMessages(body: AnthropicRequest, visionSupported: boolean): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const system = extractSystemText(body.system);
  if (system) out.push({ role: 'system', content: system });

  for (const message of body.messages) {
    const content = message.content;
    if (typeof content === 'string') {
      out.push({ role: message.role, content });
      continue;
    }

    if (message.role === 'assistant') {
      const textParts = content
        .filter((b): b is AnthropicContentBlockText => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolUses = content.filter(
        (b): b is AnthropicContentBlockToolUse => b.type === 'tool_use'
      );
      out.push({
        role: 'assistant',
        content: textParts || (toolUses.length > 0 ? null : ''),
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((u) => ({
                id: u.id,
                type: 'function' as const,
                function: {
                  name: u.name,
                  arguments: JSON.stringify(u.input ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    const toolResults = content.filter(
      (b): b is AnthropicContentBlockToolResult => b.type === 'tool_result'
    );
    const userParts: OpenAIChatContentPart[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && visionSupported) {
        userParts.push({ type: 'image_url', image_url: { url: imageBlockToImageUrl(block) } });
      }
    }
    for (const result of toolResults) {
      out.push({
        role: 'tool',
        content: toolResultToText(result),
        tool_call_id: result.tool_use_id,
      });
    }
    if (userParts.length > 0) {
      const onlyText = userParts.every((p) => p.type === 'text');
      if (onlyText) {
        const joined = userParts.map((p) => (p as OpenAIChatTextPart).text).join('\n');
        if (joined) out.push({ role: 'user', content: joined });
      } else {
        out.push({ role: 'user', content: userParts });
      }
    }
  }

  return out;
}

function toOpenAITools(body: AnthropicRequest): OpenAIChatTool[] | undefined {
  if (!body.tools || body.tools.length === 0) return undefined;
  return body.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));
}

function toOpenAIToolChoice(body: AnthropicRequest): OpenAIChatRequest['tool_choice'] {
  if (!body.tool_choice) return undefined;
  switch (body.tool_choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: body.tool_choice.name } };
    default:
      return undefined;
  }
}

function buildChatRequest(
  body: AnthropicRequest,
  model: string,
  toolUseSupported: boolean,
  visionSupported: boolean,
  thinkingSupported: boolean,
  streamUsageSupported = false,
  chatTemplateKwargs?: Record<string, unknown>
): OpenAIChatRequest {
  const request: OpenAIChatRequest = {
    model,
    messages: toOpenAIMessages(body, visionSupported),
    stream: true,
  };
  if (streamUsageSupported) {
    request.stream_options = { include_usage: true };
  }
  if (body.max_tokens && body.max_tokens > 0) request.max_tokens = body.max_tokens;
  if (toolUseSupported) {
    const tools = toOpenAITools(body);
    if (tools) request.tools = tools;
    const choice = toOpenAIToolChoice(body);
    if (choice) request.tool_choice = choice;
  }
  if (thinkingSupported) {
    const effort = thinkingToReasoningEffort(body.thinking);
    if (effort) request.reasoning_effort = effort;
  }
  if (chatTemplateKwargs) {
    request.chat_template_kwargs = chatTemplateKwargs;
  }
  return request;
}

function thinkingToReasoningEffort(
  thinking: AnthropicRequest['thinking']
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'adaptive') return 'medium';
  if (thinking.type === 'enabled') {
    const budget = thinking.budget_tokens;
    if (!Number.isFinite(budget) || budget <= 0) return undefined;
    if (budget < 4000) return 'low';
    if (budget < 16000) return 'medium';
    return 'high';
  }
  return undefined;
}

export function buildChatCompletionsUrl(input: string): string {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error(
      `Custom endpoint baseUrl is not a valid URL: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  path = path.replace(/\/chat\/completions$/i, '');
  parsed.pathname = `${path}/chat/completions`;
  return parsed.toString();
}

export function normaliseChatBaseUrl(input: string): string {
  const full = buildChatCompletionsUrl(input);
  const parsed = new URL(full);
  parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/i, '');
  return parsed.toString().replace(/\/$/, '');
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

function parseUpstreamError(status: number, text: string): string {
  const parsed = parseJsonObject(text);
  const error = parsed?.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return text || `Upstream API request failed with status ${status}`;
}

function parseSseDataPayload(data: string): OpenAIChatStreamChunk | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  const parsed = parseJsonObject(trimmed);
  return parsed ? (parsed as OpenAIChatStreamChunk) : null;
}

function joinSseDataLines(block: string): string | null {
  const parts: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.startsWith('data:')) continue;
    let value = rawLine.slice('data:'.length);
    if (value.startsWith(' ')) value = value.slice(1);
    parts.push(value);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

async function* readChatStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIChatStreamChunk> {
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
      const payload = joinSseDataLines(block);
      if (payload === null) continue;
      const chunk = parseSseDataPayload(payload);
      if (chunk) yield chunk;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const payload = joinSseDataLines(buffer);
    if (payload !== null) {
      const chunk = parseSseDataPayload(payload);
      if (chunk) yield chunk;
    }
  }
}

function chatChunkErrorBody(chunk: OpenAIChatStreamChunk): string | undefined {
  if (chunk.error) return JSON.stringify({ error: chunk.error });
  if (!chunk.choices?.length && !chunk.usage) {
    const flat = chunk as Record<string, unknown>;
    const message = typeof flat.message === 'string' ? flat.message : undefined;
    const detail = typeof flat.detail === 'string' ? flat.detail : undefined;
    const type = typeof flat.type === 'string' ? flat.type : undefined;
    const rawCode = flat.code;
    const code =
      typeof rawCode === 'string'
        ? rawCode
        : typeof rawCode === 'number' && Number.isFinite(rawCode)
          ? String(rawCode)
          : undefined;
    const rawStatus = flat.status;
    const status =
      typeof rawStatus === 'string'
        ? rawStatus
        : typeof rawStatus === 'number' && Number.isFinite(rawStatus)
          ? String(rawStatus)
          : undefined;
    if (
      message ||
      detail ||
      code ||
      status ||
      (type !== undefined && isOpenAiTransientErrorType(type))
    ) {
      const error: Record<string, unknown> = {};
      if (message ?? detail) error.message = message ?? detail;
      if (type) error.type = type;
      if (code ?? status) error.code = code ?? status;
      return JSON.stringify({ error });
    }
  }
  return undefined;
}

async function streamChatToAnthropic(params: {
  upstreamResponse: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
  model: string;
  inputTokens: number;
  modelContextWindow?: number;
}): Promise<void> {
  const { upstreamResponse, controller, model, inputTokens, modelContextWindow } = params;
  const encoder = new TextEncoder();
  const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
  const messageId = genMessageId();
  let started = false;
  let textOpen = false;
  let textBlockIndex = -1;
  let thinkingOpen = false;
  let thinkingBlockIndex = -1;
  let nextBlockIndex = 0;
  let heuristicOutputText = '';
  let heuristicOutputThinking = '';
  let finalPromptTokens: number | undefined;
  let finalCompletionTokens: number | undefined;
  let finishReason: string | null = null;
  type PendingToolCall = {
    blockIndex: number;
    id: string;
    name: string;
    argumentsText: string;
    opened: boolean;
  };
  const pendingByIdx = new Map<number, PendingToolCall>();
  const emittedIds = new Set<string>();

  const ensureStarted = () => {
    if (started) return;
    started = true;
    send(messageStartSSE(messageId, model, inputTokens, modelContextWindow));
  };

  const closeTextBlock = () => {
    if (!textOpen) return;
    send(contentBlockStopSSE(textBlockIndex));
    textOpen = false;
  };

  const startThinkingBlock = () => {
    if (thinkingOpen) return;
    ensureStarted();
    closeTextBlock();
    thinkingBlockIndex = nextBlockIndex++;
    send(contentBlockStartThinkingSSE(thinkingBlockIndex));
    thinkingOpen = true;
  };

  const closeThinkingBlock = () => {
    if (!thinkingOpen) return;
    send(contentBlockStopSSE(thinkingBlockIndex));
    thinkingOpen = false;
    thinkingBlockIndex = -1;
  };

  const openToolCall = (call: PendingToolCall) => {
    if (call.opened) return;
    ensureStarted();
    closeThinkingBlock();
    closeTextBlock();
    call.blockIndex = nextBlockIndex++;
    send(contentBlockStartToolUseSSE(call.blockIndex, call.id, call.name));
    call.opened = true;
  };

  const finishToolCall = (call: PendingToolCall) => {
    if (!call.opened) return;
    send(inputJsonDeltaSSE(call.blockIndex, call.argumentsText || '{}'));
    send(contentBlockStopSSE(call.blockIndex));
    emittedIds.add(call.id);
  };

  try {
    if (!upstreamResponse.body) throw new Error('Upstream returned empty stream body');

    let sawAnyChunk = false;
    for await (const chunk of readChatStream(upstreamResponse.body)) {
      sawAnyChunk = true;
      const errorBody = chatChunkErrorBody(chunk);
      if (errorBody) {
        let errorMessage = 'OpenAI stream error';
        try {
          const err = (JSON.parse(errorBody).error ?? {}) as { message?: string };
          if (typeof err.message === 'string' && err.message) errorMessage = err.message;
        } catch {
          // keep default
        }
        const streamErr = new Error(errorMessage);
        (streamErr as { upstreamErrorBody?: string }).upstreamErrorBody = errorBody;
        throw streamErr;
      }
      if (chunk.usage) {
        finalPromptTokens = chunk.usage.prompt_tokens ?? finalPromptTokens;
        finalCompletionTokens = chunk.usage.completion_tokens ?? finalCompletionTokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        startThinkingBlock();
        send(thinkingDeltaSSE(thinkingBlockIndex, delta.reasoning_content));
        heuristicOutputThinking += delta.reasoning_content;
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        ensureStarted();
        closeThinkingBlock();
        if (!textOpen) {
          textBlockIndex = nextBlockIndex++;
          send(contentBlockStartTextSSE(textBlockIndex));
          textOpen = true;
        }
        send(textDeltaSSE(textBlockIndex, delta.content));
        heuristicOutputText += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let pending = pendingByIdx.get(idx);
          if (!pending) {
            pending = {
              blockIndex: -1,
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              argumentsText: '',
              opened: false,
            };
            pendingByIdx.set(idx, pending);
          } else {
            if (tc.id && !pending.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
          }
          if (tc.function?.arguments) pending.argumentsText += tc.function.arguments;
        }
      }
    }

    if (!sawAnyChunk) {
      throw new Error(
        'Upstream returned a non-SSE 200 response. Check that the endpoint supports streaming Chat Completions and that any proxy preserves text/event-stream framing.'
      );
    }

    ensureStarted();
    for (const call of pendingByIdx.values()) {
      if (!call.opened && call.name) {
        if (!call.id) call.id = genToolUseId();
        openToolCall(call);
      }
      if (call.opened && !emittedIds.has(call.id)) finishToolCall(call);
    }

    closeThinkingBlock();
    closeTextBlock();

    const stopReason: 'tool_use' | 'max_tokens' | 'end_turn' =
      emittedIds.size > 0 || finishReason === 'tool_calls'
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn';

    const textTokens =
      heuristicOutputText.length > 0 ? Math.ceil(heuristicOutputText.length / 4) : 0;
    const thinkingTokens =
      heuristicOutputThinking.length > 0 ? Math.ceil(heuristicOutputThinking.length / 4) : 0;
    send(
      messageDeltaSSE(stopReason, {
        inputTokens: finalPromptTokens ?? inputTokens,
        outputTokens: finalCompletionTokens ?? Math.max(1, textTokens + thinkingTokens),
        modelContextWindow,
      })
    );
    send(messageStopSSE());
  } catch (error) {
    logger.warn(
      'openai-chat-bridge: streaming failed:',
      error instanceof Error ? error.message : String(error)
    );
    const upstreamErrorBody = (error as { upstreamErrorBody?: string }).upstreamErrorBody;
    const normalized = upstreamErrorBody
      ? normalizeOpenAiUpstreamError(upstreamErrorBody, 200)
      : undefined;
    const errorType: AnthropicErrorType = normalized?.type ?? 'api_error';
    try {
      ensureStarted();
      closeThinkingBlock();
      closeTextBlock();
    } catch {
      // Controller already closed (client disconnect or upstream tear-down).
    }
    try {
      send(errorSSE(errorType, error instanceof Error ? error.message : 'OpenAI stream failed'));
    } catch {
      // Controller already closed (client disconnect or upstream tear-down).
    }
    try {
      send(messageStopSSE());
    } catch {
      // Controller already closed.
    }
  } finally {
    try {
      controller.close();
    } catch {
      // Already closed.
    }
  }
}

export function createOpenAIChatBridgeServer(
  config: OpenAIChatBridgeConfig
): OpenAIChatBridgeServer {
  const fetchImpl = config.fetchImpl ?? fetch;
  const chatCompletionsUrl = buildChatCompletionsUrl(config.baseUrl);
  const toolUseSupported = config.toolUseSupported ?? true;
  const visionSupported = config.visionSupported ?? false;
  const thinkingSupported = config.thinkingSupported ?? false;
  const streamUsageSupported = config.streamUsageSupported ?? false;
  const chatTemplateKwargs = config.chatTemplateKwargs;
  const modelContextWindow = config.modelContextWindow;

  const sessionThinkingConfigs = new Map<string, { thinking: AnthropicRequest['thinking'] }>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const authHeader = req.headers.get('Authorization') ?? '';
      const sessionId = authHeader.startsWith('Bearer custom-endpoint:')
        ? authHeader.slice('Bearer custom-endpoint:'.length)
        : 'default';

      if (url.pathname === '/health' || url.pathname === '/v1/health') return new Response('ok');

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return new Response(
          JSON.stringify({
            data: [{ id: 'default', type: 'model', display_name: 'Custom OpenAI Endpoint' }],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        try {
          const body = (await req.json()) as AnthropicRequest;
          return new Response(
            JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch {
          return sendJsonError(400, 'invalid_request_error', 'Bad Request');
        }
      }

      if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
        return sendJsonError(501, 'api_error', 'Not implemented');
      }

      let body: AnthropicRequest;
      try {
        body = (await req.json()) as AnthropicRequest;
      } catch {
        return sendJsonError(400, 'invalid_request_error', 'Bad Request: invalid JSON');
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

      const sessionThinkingEntry = sessionThinkingConfigs.get(sessionId);
      if (sessionThinkingEntry?.thinking && !body.thinking) {
        body = { ...body, thinking: sessionThinkingEntry.thinking };
      }

      const chatRequest = buildChatRequest(
        body,
        body.model,
        toolUseSupported,
        visionSupported,
        thinkingSupported,
        streamUsageSupported,
        chatTemplateKwargs
      );
      const inputTokens = estimateAnthropicInputTokens(body);

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchImpl(chatCompletionsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify(chatRequest),
        });
      } catch (error) {
        return sendJsonError(
          502,
          'api_error',
          error instanceof Error ? error.message : 'Upstream API request failed'
        );
      }

      if (!upstreamResponse.ok) {
        const text = await upstreamResponse.text();
        const normalized = normalizeOpenAiUpstreamError(text, upstreamResponse.status);
        if (normalized) {
          logger.warn(
            `openai-chat-bridge: normalized upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        return sendJsonError(
          upstreamResponse.status,
          anthropicErrorTypeForHttpStatus(upstreamResponse.status),
          parseUpstreamError(upstreamResponse.status, text)
        );
      }

      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
      if (isJsonContentType(upstreamContentType)) {
        const bodyText = await upstreamResponse.text();
        const normalized = normalizeOpenAiUpstreamError(bodyText, upstreamResponse.status);
        if (normalized) {
          logger.warn(
            `openai-chat-bridge: normalized 200-with-body upstream error to retryable ` +
              `${normalized.type} (${normalized.status}): ${normalized.message.slice(0, 200)}`
          );
          return sendRetryableUpstreamError(normalized);
        }
        upstreamResponse = new Response(bodyText, {
          status: upstreamResponse.status,
          headers: { 'Content-Type': upstreamContentType },
        });
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void streamChatToAnthropic({
            upstreamResponse,
            controller,
            model: body.model,
            inputTokens,
            ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
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
  if (typeof port !== 'number')
    throw new Error('OpenAI chat bridge server did not bind to a TCP port');
  logger.info(`openai-chat-bridge: HTTP server listening on port ${port}`);

  return {
    port,
    setSessionThinkingConfig: (sessionId: string, thinking: AnthropicRequest['thinking']) => {
      sessionThinkingConfigs.set(sessionId, { thinking });
    },
    stop: () => {
      sessionThinkingConfigs.clear();
      server.stop(true);
    },
  };
}

export const _openAIChatBridgeTesting = {
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIToolChoice,
  buildChatRequest,
  streamChatToAnthropic,
  normaliseChatBaseUrl,
  buildChatCompletionsUrl,
  thinkingToReasoningEffort,
};
