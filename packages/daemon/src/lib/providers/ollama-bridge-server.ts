import {
  type AnthropicContentBlockText,
  type AnthropicContentBlockToolResult,
  type AnthropicContentBlockToolUse,
  type AnthropicRequest,
  contentBlockStartTextSSE,
  contentBlockStartToolUseSSE,
  contentBlockStopSSE,
  errorSSE,
  inputJsonDeltaSSE,
  messageDeltaSSE,
  messageStartSSE,
  messageStopSSE,
  textDeltaSSE,
} from './provider-anthropic-compat/translator.js';
import { estimateAnthropicInputTokens } from './provider-anthropic-compat/token-estimator.js';
import { createAnthropicErrorBody, type AnthropicErrorType } from './shared/error-envelope.js';
import { anthropicErrorTypeForHttpStatus } from '@hyperneo/shared/provider/error-taxonomy';
import { Logger } from '../logger.js';

const logger = new Logger('ollama-bridge-server');

export type OllamaBridgeServer = {
  port: number;
  stop(): void;
};

export type OllamaBridgeConfig = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  toolUseSupported?: boolean;
  modelContextWindow?: number;
  hostname?: string;
};

type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

type OllamaTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type OllamaChatRequest = {
  model: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  stream: true;
  options?: {
    num_predict?: number;
    num_ctx?: number;
  };
};

type OllamaToolCall = {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
};

type OllamaChatChunk = {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function sendJsonError(status: number, type: AnthropicErrorType, message: string): Response {
  return new Response(createAnthropicErrorBody(type, message), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function toolResultText(toolResult: AnthropicContentBlockToolResult): string {
  if (typeof toolResult.content === 'string') return toolResult.content;
  if (toolResult.content.some((part) => part.type === 'image')) {
    throw new Error('Ollama bridge does not support image content blocks');
  }
  return toolResult.content.map((part) => (part as { type: 'text'; text: string }).text).join('');
}

function extractText(content: string | AnthropicRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is AnthropicContentBlockText => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function extractSystemText(system: AnthropicRequest['system'] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((block) => block.text).join('\n');
}

function toOllamaToolCall(toolUse: AnthropicContentBlockToolUse): OllamaToolCall {
  return {
    function: {
      name: toolUse.name,
      arguments: toolUse.input,
    },
  };
}

function appendOllamaMessages(
  messages: OllamaChatMessage[],
  message: AnthropicRequest['messages'][number],
  toolNameByUseId: Map<string, string>
): void {
  if (typeof message.content === 'string') {
    messages.push({ role: message.role, content: message.content });
    return;
  }

  const imageBlock = message.content.find((block) => block.type === 'image');
  if (imageBlock) {
    throw new Error('Ollama bridge does not support image content blocks');
  }

  const text = extractText(message.content);
  const toolUses = message.content.filter(
    (block): block is AnthropicContentBlockToolUse => block.type === 'tool_use'
  );
  if (message.role === 'assistant') {
    for (const toolUse of toolUses) toolNameByUseId.set(toolUse.id, toolUse.name);
    messages.push({
      role: 'assistant',
      content: text,
      ...(toolUses.length > 0 ? { tool_calls: toolUses.map(toOllamaToolCall) } : {}),
    });
    return;
  }

  const toolResults = message.content.filter(
    (block): block is AnthropicContentBlockToolResult => block.type === 'tool_result'
  );
  if (toolResults.length === 0) {
    messages.push({ role: 'user', content: text });
    return;
  }
  for (const result of toolResults) {
    messages.push({
      role: 'tool',
      content: toolResultText(result),
      tool_name: toolNameByUseId.get(result.tool_use_id) ?? result.tool_use_id,
    });
  }
  if (text) messages.push({ role: 'user', content: text });
}

function buildOllamaRequest(
  body: AnthropicRequest,
  options?: { toolUseSupported?: boolean; modelContextWindow?: number }
): OllamaChatRequest {
  const messages: OllamaChatMessage[] = [];
  const toolNameByUseId = new Map<string, string>();
  const system = extractSystemText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    appendOllamaMessages(messages, message, toolNameByUseId);
  }

  const request: OllamaChatRequest = {
    model: body.model,
    messages,
    stream: true,
  };
  const ollamaOptions: { num_predict?: number; num_ctx?: number } = {};
  if (body.max_tokens && body.max_tokens > 0) {
    ollamaOptions.num_predict = body.max_tokens;
  }
  if (options?.modelContextWindow && options.modelContextWindow > 0) {
    ollamaOptions.num_ctx = options.modelContextWindow;
  }
  if (Object.keys(ollamaOptions).length > 0) request.options = ollamaOptions;
  const allowTools = options?.toolUseSupported !== false;
  if (allowTools && body.tools && body.tools.length > 0) {
    request.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  return request;
}

function parseJsonLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaChatChunk;
  } catch {
    logger.warn(`ollama bridge: ignoring malformed stream line: ${trimmed.slice(0, 120)}`);
    return null;
  }
}

function toolArgumentsToJson(argumentsValue: Record<string, unknown> | string | undefined): string {
  if (typeof argumentsValue === 'string') return argumentsValue;
  return JSON.stringify(argumentsValue ?? {});
}

function emitToolCall(params: {
  send: (chunk: string) => void;
  toolCall: OllamaToolCall;
  index: number;
}): boolean {
  const name = params.toolCall.function?.name;
  if (!name) return false;
  params.send(
    contentBlockStartToolUseSSE(
      params.index,
      `toolu_ollama_${Math.random().toString(36).slice(2, 12)}`,
      name
    )
  );
  params.send(
    inputJsonDeltaSSE(params.index, toolArgumentsToJson(params.toolCall.function?.arguments))
  );
  params.send(contentBlockStopSSE(params.index));
  return true;
}

async function streamOllamaToAnthropic(params: {
  ollamaResponse: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
  model: string;
  inputTokens: number;
}): Promise<void> {
  const { ollamaResponse, controller, model, inputTokens } = params;
  const encoder = new TextEncoder();
  const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
  let outputText = '';
  let startedText = false;
  let nextBlockIndex = 0;
  let emittedToolUse = false;
  let finalPromptTokens: number | undefined;
  let finalOutputTokens: number | undefined;
  let finalDoneReason: string | undefined;

  try {
    send(
      messageStartSSE(`msg_ollama_${Math.random().toString(36).slice(2, 12)}`, model, inputTokens)
    );
    const reader = ollamaResponse.body?.getReader();
    if (!reader) throw new Error('Ollama response did not include a stream body');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const chunk = parseJsonLine(line);
        if (!chunk) continue;
        if (chunk.error) throw new Error(chunk.error);
        const text = chunk.message?.content ?? '';
        if (text) {
          if (!startedText) {
            send(contentBlockStartTextSSE(nextBlockIndex));
            startedText = true;
          }
          outputText += text;
          send(textDeltaSSE(nextBlockIndex, text));
        }
        for (const toolCall of chunk.message?.tool_calls ?? []) {
          if (startedText) {
            send(contentBlockStopSSE(nextBlockIndex));
            startedText = false;
            nextBlockIndex += 1;
          }
          emittedToolUse =
            emitToolCall({ send, toolCall, index: nextBlockIndex }) || emittedToolUse;
          nextBlockIndex += 1;
        }
        if (chunk.done) {
          finalPromptTokens = chunk.prompt_eval_count;
          finalOutputTokens = chunk.eval_count;
          finalDoneReason = chunk.done_reason;
        }
      }
    }
    const tail = parseJsonLine(buffer);
    if (tail) {
      if (tail.error) throw new Error(tail.error);
      const text = tail.message?.content ?? '';
      if (text) {
        if (!startedText) {
          send(contentBlockStartTextSSE(nextBlockIndex));
          startedText = true;
        }
        outputText += text;
        send(textDeltaSSE(nextBlockIndex, text));
      }
      for (const toolCall of tail.message?.tool_calls ?? []) {
        if (startedText) {
          send(contentBlockStopSSE(nextBlockIndex));
          startedText = false;
          nextBlockIndex += 1;
        }
        emittedToolUse = emitToolCall({ send, toolCall, index: nextBlockIndex }) || emittedToolUse;
        nextBlockIndex += 1;
      }
      if (tail.done) {
        finalPromptTokens = tail.prompt_eval_count;
        finalOutputTokens = tail.eval_count;
        finalDoneReason = tail.done_reason;
      }
    }
    if (startedText) {
      send(contentBlockStopSSE(nextBlockIndex));
    } else if (!emittedToolUse) {
      send(contentBlockStartTextSSE(nextBlockIndex));
      send(contentBlockStopSSE(nextBlockIndex));
    }
    const stopReason = emittedToolUse
      ? 'tool_use'
      : finalDoneReason === 'length'
        ? 'max_tokens'
        : 'end_turn';
    send(
      messageDeltaSSE(stopReason, {
        inputTokens: finalPromptTokens ?? inputTokens,
        outputTokens: finalOutputTokens ?? estimateTokens(outputText),
      })
    );
    send(messageStopSSE());
  } catch (error) {
    send(errorSSE('api_error', error instanceof Error ? error.message : 'Ollama stream failed'));
  } finally {
    controller.close();
  }
}

export function createOllamaAnthropicBridgeServer(config: OllamaBridgeConfig): OllamaBridgeServer {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '').replace(/\/api\/chat\/?$/i, '');
  const server = Bun.serve({
    ...(config.hostname ? { hostname: config.hostname } : {}),
    port: 0,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/health' || url.pathname === '/v1/health') return new Response('ok');
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return new Response(
          JSON.stringify({
            data: [{ id: 'default', type: 'model', display_name: 'Ollama' }],
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        try {
          const body = (await req.json()) as AnthropicRequest;
          return new Response(
            JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
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

      let requestBody: OllamaChatRequest;
      try {
        requestBody = buildOllamaRequest(body, {
          toolUseSupported: config.toolUseSupported,
          modelContextWindow: config.modelContextWindow,
        });
      } catch (error) {
        return sendJsonError(
          400,
          'invalid_request_error',
          error instanceof Error ? error.message : 'Unsupported request content'
        );
      }
      const inputTokens = estimateTokens(
        requestBody.messages
          .map((message) => message.content)
          .filter(Boolean)
          .join('\n')
      );
      let ollamaResponse: Response;
      try {
        ollamaResponse = await fetchImpl(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        return sendJsonError(
          502,
          'api_error',
          error instanceof Error ? error.message : 'Ollama API request failed'
        );
      }
      if (!ollamaResponse.ok) {
        const text = await ollamaResponse.text();
        return sendJsonError(
          ollamaResponse.status,
          anthropicErrorTypeForHttpStatus(ollamaResponse.status),
          text || `Ollama API returned HTTP ${ollamaResponse.status}`
        );
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void streamOllamaToAnthropic({
            ollamaResponse,
            controller,
            model: body.model,
            inputTokens,
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
  if (typeof port !== 'number') throw new Error('Ollama bridge server did not bind to a TCP port');
  logger.info(`ollama bridge: HTTP server listening on port ${port}`);
  return {
    port,
    stop: () => server.stop(true),
  };
}
