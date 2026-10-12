import { createHttpWsServer, type ServerOptions } from '../runtime-server/index.ts';

type Block = Record<string, unknown> & { type?: string };
type AnthropicEvent = {
  type?: string;
  index?: number;
  message?: Record<string, unknown>;
  content_block?: Block;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: unknown;
};

function parseToolInput(json: string | undefined, fallback: unknown): unknown {
  if (!json) return fallback ?? {};
  try {
    return JSON.parse(json);
  } catch {
    return fallback ?? {};
  }
}

export function assembleAnthropicMessage(
  sse: string
): { message: Record<string, unknown> } | { error: unknown } {
  let message: Record<string, unknown> = { type: 'message', role: 'assistant', content: [] };
  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  for (const chunk of sse.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: AnthropicEvent;
    try {
      event = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue;
    }
    const index = event.index ?? 0;
    if (event.type === 'error') return { error: event.error ?? event };
    if (event.type === 'message_start' && event.message) message = { ...event.message };
    if (event.type === 'content_block_start' && event.content_block)
      blocks[index] = { ...event.content_block };
    if (event.type === 'content_block_delta' && event.delta && blocks[index]) {
      const block = blocks[index];
      const delta = event.delta;
      if (delta.type === 'text_delta') block.text = `${block.text ?? ''}${delta.text ?? ''}`;
      if (delta.type === 'thinking_delta')
        block.thinking = `${block.thinking ?? ''}${delta.thinking ?? ''}`;
      if (delta.type === 'signature_delta') block.signature = delta.signature;
      if (delta.type === 'input_json_delta')
        partialJson.set(index, `${partialJson.get(index) ?? ''}${delta.partial_json ?? ''}`);
    }
    if (event.type === 'content_block_stop' && blocks[index]?.type === 'tool_use') {
      blocks[index].input = parseToolInput(partialJson.get(index), blocks[index].input);
    }
    if (event.type === 'message_delta') {
      message = { ...message, ...(event.delta ?? {}) };
      if (event.usage)
        message.usage = { ...((message.usage as object | undefined) ?? {}), ...event.usage };
    }
  }
  return { message: { ...message, content: blocks.filter(Boolean) } };
}

const ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  overloaded_error: 529,
};

export function anthropicErrorStatus(error: unknown): number {
  const type = (error as { type?: unknown } | null)?.type;
  return (typeof type === 'string' && ERROR_STATUS[type]) || 500;
}

async function serveNonStreaming(
  req: Request,
  upgrade: Parameters<ServerOptions['fetch']>[1],
  fetch: ServerOptions['fetch']
): Promise<Response | undefined> {
  if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/v1/messages'))
    return fetch(req, upgrade);
  const text = await req.text();
  const rebuild = (body: string) =>
    new Request(req.url, { method: req.method, headers: req.headers, body, signal: req.signal });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fetch(rebuild(text), upgrade);
  }
  if (!body || typeof body !== 'object' || (body as { stream?: unknown }).stream !== false)
    return fetch(rebuild(text), upgrade);
  const response = await fetch(rebuild(JSON.stringify({ ...body, stream: true })), upgrade);
  if (!response?.ok || !(response.headers.get('content-type') ?? '').includes('event-stream'))
    return response;
  const assembled = assembleAnthropicMessage(await response.text());
  return 'error' in assembled
    ? new Response(JSON.stringify({ type: 'error', error: assembled.error }), {
        status: anthropicErrorStatus(assembled.error),
        headers: { 'Content-Type': 'application/json' },
      })
    : new Response(JSON.stringify(assembled.message), {
        headers: { 'Content-Type': 'application/json' },
      });
}

export function createMessagesBridgeServer(options: ServerOptions) {
  return createHttpWsServer({
    ...options,
    fetch: (req, upgrade) => serveNonStreaming(req, upgrade, options.fetch),
  });
}
