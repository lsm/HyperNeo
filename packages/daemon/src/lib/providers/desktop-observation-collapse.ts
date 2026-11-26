import catalog from '../desktop/tool-catalog.json' with { type: 'json' };
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import type {
  AnthropicContentBlockToolResult,
  AnthropicContentBlockToolUse,
  AnthropicRequest,
} from './provider-anthropic-compat/translator.ts';

const prefix = `mcp__${OPERATIONS_MCP_SERVER_NAME}__`;
const desktopTools = new Set(catalog.map(({ name }) => name));
const reads = new Set(['list_windows', 'get_window_state', 'zoom']);
const targets = [
  'bundle_id',
  'pid',
  'window_id',
  'element_token',
  'x',
  'y',
  'from_x',
  'from_y',
  'to_x',
  'to_y',
  'x1',
  'y1',
  'x2',
  'y2',
];

type DesktopCall = { name: string; input: Record<string, unknown>; batch: number };

function desktopCall(use: AnthropicContentBlockToolUse, batch: number): DesktopCall | undefined {
  if (typeof use.name !== 'string' || !use.name.startsWith(prefix)) return;
  const name = use.name.slice(prefix.length);
  if (desktopTools.has(name)) return { name, input: use.input, batch };
  if (name === 'invoke' && use.input?.name === 'desktop.call') {
    const call = use.input.input as { tool?: string; args?: Record<string, unknown> } | undefined;
    if (call?.tool && desktopTools.has(call.tool)) {
      return { name: call.tool, input: call.args ?? {}, batch };
    }
  }
}

function desktopStatus(result: AnthropicContentBlockToolResult & { is_error?: boolean }) {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text =
    typeof result.content === 'string' ? result.content : first?.type === 'text' ? first.text : '';
  let status: { ok?: boolean; reason?: unknown; code?: unknown } | undefined;
  if (text?.trimStart().startsWith('{')) {
    try {
      status = JSON.parse(text);
    } catch {
      status = undefined;
    }
  }
  const outcome =
    result.is_error === true || status?.ok === false
      ? 'failed'
      : status?.ok === true
        ? 'ok'
        : 'unknown';
  return { outcome, reason: status?.reason ?? status?.code };
}

export function collapseDesktopObservations(body: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(body?.messages)) return body;
  const calls = new Map<string, DesktopCall>();
  let newestBatch = -1;
  for (const [batch, message] of body.messages.entries()) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'tool_use') continue;
      const call = desktopCall(block, batch);
      if (!call) continue;
      calls.set(block.id, call);
      newestBatch = batch;
    }
  }
  if (newestBatch < 0) return body;

  let retainFailure = true;
  let messages: AnthropicRequest['messages'] | undefined;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    let content: typeof message.content | undefined;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (block?.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const { outcome, reason } = desktopStatus(block);
      const keepFailure = outcome === 'failed' && retainFailure;
      if (outcome === 'failed' || (outcome === 'ok' && !reads.has(call.name))) {
        retainFailure = false;
      }
      if (call.batch === newestBatch || keepFailure) continue;
      const fields = [call.name];
      for (const key of targets) {
        const value = call.input?.[key];
        if (typeof value === 'number' || typeof value === 'string') fields.push(`${key}=${value}`);
      }
      fields.push(outcome);
      if (outcome === 'failed' && typeof reason === 'string' && reason) fields.push(reason);
      content ??= message.content.slice();
      content[j] = { ...block, content: fields.join(' ').replace(/[\r\n]+/g, ' ') };
    }
    if (content) {
      messages ??= body.messages.slice();
      messages[i] = { ...message, content };
    }
  }
  return messages ? { ...body, messages } : body;
}
