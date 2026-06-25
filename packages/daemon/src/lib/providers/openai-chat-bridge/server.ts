/**
 * OpenAI Chat Completions Anthropic Bridge — HTTP Server
 *
 * Translates between the Anthropic Messages API and the OpenAI Chat Completions
 * API. Lets the Claude Agent SDK drive any OpenAI-compatible endpoint:
 * LM Studio, vLLM, LiteLLM, Ollama (OpenAI mode), self-hosted deployments, etc.
 *
 * Mapping summary:
 *   Anthropic system field         → OpenAI system message
 *   Anthropic user/assistant       → OpenAI user/assistant messages
 *   Anthropic tool_use (assistant) → OpenAI assistant tool_calls[]
 *   Anthropic tool_result (user)   → OpenAI tool role message
 *   Anthropic image blocks         → OpenAI image_url content parts
 *   OpenAI delta.content           → Anthropic content_block text_delta
 *   OpenAI delta.tool_calls        → Anthropic tool_use content blocks
 *
 * Capability gating is performed by `CustomEndpointProvider` before requests
 * reach this server (e.g. `tools` array is empty when toolUse=false on a model).
 */

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
import {
  isJsonContentType,
  normalizeOpenAiUpstreamError,
} from '../shared/normalize-upstream-error.js';
import { Logger } from '../../logger.js';

const logger = new Logger('openai-chat-bridge-server');

export type OpenAIChatBridgeServer = {
  port: number;
  /** Set per-session thinking config so the bridge can include reasoning even when the Anthropic SDK client omits the thinking field. */
  setSessionThinkingConfig?(sessionId: string, thinking: AnthropicRequest['thinking']): void;
  stop(): void;
};

export type OpenAIChatBridgeConfig = {
  /** Upstream OpenAI-compatible base URL. The bridge appends `/chat/completions`. */
  baseUrl: string;
  /** Optional bearer token for `Authorization: Bearer ...` header. */
  apiKey?: string;
  /** Extra headers attached to every upstream request. */
  headers?: Record<string, string>;
  /** Override fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Whether the active model supports tool use. Tools are dropped when false. */
  toolUseSupported?: boolean;
  /** Whether the active model supports vision. Images are dropped when false. */
  visionSupported?: boolean;
  /**
   * Whether the active model supports extended thinking / reasoning. When
   * true, the bridge maps `AnthropicRequest.thinking` to OpenAI
   * `reasoning_effort` so the upstream actually sees the request.
   */
  thinkingSupported?: boolean;
  /** Max context window for the active model (used in usage events). */
  modelContextWindow?: number;
  /**
   * Whether the upstream accepts `stream_options: { include_usage: true }`.
   * Off by default because many strict OpenAI-compatible backends reject
   * unknown request fields with HTTP 400/422 before any generation. When
   * false the bridge still produces usage events using a token estimator
   * — accuracy degrades but the endpoint remains usable.
   */
  streamUsageSupported?: boolean;
  /**
   * Per-model `chat_template_kwargs` forwarded verbatim into every upstream
   * request body. Used for fields the OpenAI Chat schema does not define but
   * llama.cpp / vLLM templates read — most notably
   * `{ enable_thinking: false }` to skip Qwen3 `<think>` blocks.
   */
  chatTemplateKwargs?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// OpenAI Chat Completions wire types (minimal subset)
// ---------------------------------------------------------------------------

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
  /**
   * Maps from Anthropic `thinking.budget_tokens`. Forwarded only when the
   * caller declared the model `thinkingSupported`. Most OpenAI-compatible
   * endpoints either honour this (o-series, modern reasoning models) or
   * ignore unknown fields silently.
   */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /**
   * Jinja template kwargs (e.g. `{ enable_thinking: false }`). Forwarded
   * verbatim; only llama.cpp / vLLM-style backends interpret it. Other
   * OpenAI-compatible servers ignore unknown fields silently.
   */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function mapUpstreamStatus(status: number): AnthropicErrorType {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
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

/**
 * Convert Anthropic messages → OpenAI chat messages. Tool results become
 * `tool` role messages with `tool_call_id`. Assistant tool_use blocks become
 * `tool_calls` on the assistant message. Vision blocks dropped when not
 * supported.
 */
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

    // User role: may contain text, images, tool_result blocks. Emit any
    // tool_result as its own `tool` message; the remainder as one user
    // message with mixed content parts.
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
      // If only text, collapse to string for endpoints that don't accept arrays.
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
  // `stream_options` is opt-in. Strict OpenAI-compatible backends reject
  // unknown request fields with HTTP 400/422, which would break the entire
  // endpoint. The bridge still emits usage events via a token estimator when
  // the upstream doesn't echo `usage` chunks, so omitting this field only
  // degrades accuracy, not availability.
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
  // llama.cpp / vLLM-style Jinja kwargs. Forwarded verbatim; other
  // OpenAI-compatible servers ignore unknown fields silently. Most
  // common use: `{ enable_thinking: false }` to skip Qwen3 `<think>`
  // blocks for simple prompts that don't need reasoning.
  if (chatTemplateKwargs) {
    request.chat_template_kwargs = chatTemplateKwargs;
  }
  return request;
}

/**
 * Map Anthropic thinking config to OpenAI `reasoning_effort`. Anthropic's
 * config is a token budget; OpenAI uses a coarse three-step enum. We bucket
 * by budget so the upstream still gets *some* signal even though the
 * granularity is lost.
 */
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

/**
 * Build the final Chat Completions request URL from a user-supplied baseUrl.
 *
 * Users routinely paste either:
 *   - the OpenAI-style root, e.g. `https://api.example.com/v1`
 *   - the full chat endpoint, e.g. `https://api.example.com/v1/chat/completions`
 *   - Azure-style URLs with a query string, e.g.
 *     `https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview`
 *
 * Naive string concatenation produces malformed targets like
 * `.../chat/completions/chat/completions` (404) or
 * `...?api-version=.../chat/completions` (also broken). Parse the URL,
 * strip a trailing `/chat/completions` from the path, reattach the chat
 * suffix to the path, and preserve any query string by re-serialising via
 * the `URL` API.
 */
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
  // Strip trailing slashes from the path, then any trailing `/chat/completions`,
  // then re-add a single `/chat/completions` suffix. This keeps `?api-version=...`
  // and any other query string intact since we only mutate `pathname`.
  let path = parsed.pathname.replace(/\/+$/, '');
  path = path.replace(/\/chat\/completions$/i, '');
  parsed.pathname = `${path}/chat/completions`;
  return parsed.toString();
}

/**
 * Legacy export retained for the rare caller that wanted the "base prefix"
 * (everything except `/chat/completions`). Now expressed in terms of the
 * URL-aware builder so query strings are preserved consistently.
 */
export function normaliseChatBaseUrl(input: string): string {
  const full = buildChatCompletionsUrl(input);
  // Strip the `/chat/completions` suffix that buildChatCompletionsUrl just
  // added, leaving the base prefix (with any query string preserved).
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

/** Parse a single SSE `data:` payload (possibly multi-line, already joined). */
function parseSseDataPayload(data: string): OpenAIChatStreamChunk | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  const parsed = parseJsonObject(trimmed);
  return parsed ? (parsed as OpenAIChatStreamChunk) : null;
}

/**
 * Collect all `data:` lines from a single SSE event block into one payload.
 *
 * Per the SSE spec one event may carry multiple consecutive `data:` lines,
 * which the parser MUST concatenate with `\n` before treating the result as
 * the event payload. Some OpenAI-compatible proxies wrap-fold large JSON
 * chunks across lines; parsing each line independently would fail JSON
 * decoding and silently drop the event (and could trigger our "non-SSE 200"
 * guard against an otherwise valid stream).
 *
 * Lines that are not `data:` (e.g. `event:`, `id:`, `:keepalive` comments)
 * are ignored — we only consume Chat Completions data frames.
 */
function joinSseDataLines(block: string): string | null {
  const parts: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.startsWith('data:')) continue;
    // Per the spec, a single space immediately after the colon is stripped;
    // anything else is preserved.
    let value = rawLine.slice('data:'.length);
    if (value.startsWith(' ')) value = value.slice(1);
    parts.push(value);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** Read an OpenAI Chat Completions SSE stream as chunks. */
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

/**
 * Extract a serialized `{error: ...}` body from a chat-stream chunk, for both
 * the standard nested `chunk.error` shape and a FLAT payload.
 *
 * `readChatStream` discards the SSE `event:` line, so a flat `event: error`
 * block like `data: {"type":"server_error","message":"overloaded"}` reaches the
 * loop with no `error` wrapper. Without this, the flat error chunk has no
 * choices, is skipped, and the bridge ends with a normal `end_turn` instead of
 * surfacing the (retryable) error. A flat chunk is only treated as an error
 * when it has no choices and no usage but carries error-like top-level fields.
 */
function chatChunkErrorBody(chunk: OpenAIChatStreamChunk): string | undefined {
  if (chunk.error) return JSON.stringify({ error: chunk.error });
  if (!chunk.choices?.length && !chunk.usage) {
    const flat = chunk as Record<string, unknown>;
    const message = typeof flat.message === 'string' ? flat.message : undefined;
    const type = typeof flat.type === 'string' ? flat.type : undefined;
    const code = typeof flat.code === 'string' ? flat.code : undefined;
    // Require an actual error signal (a message or a code) — NOT a bare `type`.
    // Some OpenAI-compatible endpoints send JSON heartbeat/metadata frames like
    // `{"type":"ping"}`; treating type-only frames as errors would abort a
    // valid stream with a terminal api_error before later choices arrive.
    // A `type` is still folded into the body for classification when present.
    if (message || code) {
      const error: Record<string, unknown> = {};
      if (message) error.message = message;
      if (type) error.type = type;
      if (code) error.code = code;
      return JSON.stringify({ error });
    }
  }
  return undefined;
}

/**
 * Translate the upstream OpenAI Chat Completions SSE stream into Anthropic
 * Messages SSE events. Handles incremental tool_calls accumulation.
 */
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
    /**
     * Upstream `tool_calls[].id` if seen, else empty string until we
     * synthesize one at stream end. We MUST NOT open the Anthropic
     * tool_use block before this is known (or finalised) — otherwise
     * the client sees one id but the model's follow-up `tool` message
     * references a different upstream id, and OpenAI-compatible
     * backends reject the continuation via `tool_call_id` validation.
     */
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
    // Emit the (possibly accumulated) JSON args once, then close. Endpoints
    // stream arguments in fragments; we buffer until completion to avoid
    // emitting partial JSON deltas with stale partial_json strings that
    // would not parse downstream.
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
        // Carry the serialized error body so the catch handler can classify a
        // transient mid-stream error (rate_limit / overloaded) instead of
        // defaulting to a terminal api_error. The SDK cannot retry a stream it
        // has already started, so the correct type also lets the query-runner
        // (B4) recognise and re-issue the whole query. Handles both the nested
        // `chunk.error` shape and flat payloads (see chatChunkErrorBody).
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
              // Don't synthesize here — wait for upstream id; if none
              // arrives by stream end we synthesize once in the flush
              // pass below. Opening the block with a placeholder and
              // then overwriting `pending.id` would leak a bogus id
              // to the client that no follow-up `tool` message can
              // match.
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              argumentsText: '',
              opened: false,
            };
            pendingByIdx.set(idx, pending);
          } else {
            // First non-empty upstream id wins; subsequent chunks
            // generally repeat it but we keep the first to be safe.
            if (tc.id && !pending.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
          }
          if (tc.function?.arguments) pending.argumentsText += tc.function.arguments;
          // Open only when BOTH name and upstream id are known so the
          // client sees the same id the model will reference later.
          if (pending.name && pending.id && !pending.opened) {
            openToolCall(pending);
          }
        }
      }
    }

    if (!sawAnyChunk) {
      // Upstream returned 200 but the body contained no SSE `data:` chunks
      // (e.g. a non-streaming endpoint that ignored `stream: true` and
      // returned a one-shot JSON object, or a misconfigured proxy that
      // stripped the SSE framing). Fail loudly instead of emitting an
      // empty `end_turn` that hides the incompatibility from the user.
      throw new Error(
        'Upstream returned a non-SSE 200 response. Check that the endpoint supports streaming Chat Completions and that any proxy preserves text/event-stream framing.'
      );
    }

    ensureStarted();
    // Flush any tool calls that received a name but never closed via finish_reason.
    for (const call of pendingByIdx.values()) {
      if (!call.opened && call.name) {
        // No upstream id ever arrived — synthesize one so we can still
        // emit a valid Anthropic tool_use block. Backends that strictly
        // validate `tool_call_id` will already be unhappy with this
        // stream, but emitting *something* is better than dropping the
        // call entirely.
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
    // Classify a transient mid-stream error body to the right Anthropic type so
    // the SDK (and query-runner B4) can recognise it as retryable.
    const upstreamErrorBody = (error as { upstreamErrorBody?: string }).upstreamErrorBody;
    const normalized = upstreamErrorBody
      ? normalizeOpenAiUpstreamError(upstreamErrorBody, 200)
      : undefined;
    const errorType: AnthropicErrorType = normalized?.type ?? 'api_error';
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

  // Per-session thinking config injected by the daemon when the Anthropic SDK client
  // (Claude Code CLI) omits the thinking field from request bodies.
  const sessionThinkingConfigs = new Map<string, { thinking: AnthropicRequest['thinking'] }>();

  const server = Bun.serve({
    // Bind to loopback so other local users cannot probe the ephemeral port
    // and reach this bridge with the configured upstream API key. The SDK
    // connects via ANTHROPIC_BASE_URL=http://127.0.0.1:<port>.
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

      // The Claude Code CLI handles thinking internally and does not include the
      // thinking field in Anthropic Messages API requests. Merge the per-session
      // thinking config injected by the daemon so reasoning is forwarded to OpenAI.
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
        // Inspect the BODY for transient signals (rate_limit_exceeded /
        // server_error / overload text) that the status alone misses — e.g. a
        // 4xx carrying a rate-limit body, or a 5xx that should surface as
        // overloaded_error. Reclassify so the SDK retries.
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
          mapUpstreamStatus(upstreamResponse.status),
          parseUpstreamError(upstreamResponse.status, text)
        );
      }

      // Some OpenAI-compatible proxies return 200 with a JSON error body instead
      // of an SSE stream. Only pre-buffer when the content-type explicitly says
      // JSON — gating on "not event-stream" would also buffer endpoints that
      // stream valid SSE with a missing/mislabeled content-type, waiting for the
      // whole body and breaking incremental output. A real SSE stream (any other
      // content-type, or none) flows straight through to readChatStream.
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
        // Non-transient: reconstruct the response so the streaming path handles
        // the non-SSE body exactly as before (terminal api_error for the user).
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

// Exports for testing.
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
