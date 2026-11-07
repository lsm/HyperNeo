import { createHash, type UUID } from 'node:crypto';
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface OapTranslatorState {
  sessionId: string;
  terminal: boolean;
  tools: ReadonlyArray<{ id: string; settled: boolean }>;
}

export interface OapTranslatorEvent {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

export interface OapTranslation {
  state: OapTranslatorState;
  messages: SDKMessage[];
}

export function initialOapTranslatorState(sessionId: string): OapTranslatorState {
  return { sessionId, terminal: false, tools: [] };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function eventUuid(sessionId: string, id: string): UUID {
  const bytes = createHash('sha256')
    .update(JSON.stringify([sessionId, id]))
    .digest('hex');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-5${bytes.slice(13, 16)}-a${bytes.slice(17, 20)}-${bytes.slice(20, 32)}` as UUID;
}

function zeroUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: '',
    iterations: [],
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard' as const,
    speed: 'standard' as const,
  };
}

function assistantMessage(
  state: OapTranslatorState,
  event: OapTranslatorEvent
): SDKAssistantMessage | null {
  const part = record(event.payload.part);
  const content =
    part.type === 'text' && typeof part.text === 'string'
      ? { type: 'text' as const, text: part.text, citations: null }
      : part.type === 'reasoning' && typeof part.reasoning === 'string'
        ? { type: 'thinking' as const, thinking: part.reasoning, signature: '' }
        : null;
  if (!content) return null;
  return {
    type: 'assistant',
    uuid: eventUuid(state.sessionId, event.id),
    session_id: state.sessionId,
    parent_tool_use_id: null,
    message: {
      id: event.id,
      type: 'message',
      role: 'assistant',
      model: '',
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: zeroUsage(),
      content: [content],
    },
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function usageFor(event: OapTranslatorEvent) {
  const usage = record(event.payload.usage);
  return {
    ...zeroUsage(),
    input_tokens: count(usage.input_tokens),
    output_tokens: count(usage.output_tokens),
    cache_read_input_tokens: count(usage.cache_read_input_tokens),
    cache_creation_input_tokens: count(usage.cache_write_input_tokens),
    output_tokens_details: { thinking_tokens: count(usage.reasoning_tokens) },
  };
}

function toolUse(
  state: OapTranslatorState,
  event: OapTranslatorEvent,
  id: string
): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: eventUuid(state.sessionId, `${event.id}:tool-use`),
    session_id: state.sessionId,
    parent_tool_use_id: null,
    message: {
      id: event.id,
      type: 'message',
      role: 'assistant',
      model: '',
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: zeroUsage(),
      content: [
        {
          type: 'tool_use',
          id,
          name: typeof event.payload.name === 'string' ? event.payload.name : 'unknown',
          input: Object.hasOwn(event.payload, 'arguments_json') ? event.payload.arguments_json : {},
        },
      ],
    },
  };
}

function toolResult(
  state: OapTranslatorState,
  event: OapTranslatorEvent,
  id: string
): SDKUserMessage {
  const failed = event.type !== 'action.call.completed';
  const output = failed
    ? (event.payload.error ?? event.payload.reason ?? event.type)
    : event.payload.result;
  const content = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
  return {
    type: 'user',
    uuid: eventUuid(state.sessionId, `${event.id}:tool-result`),
    session_id: state.sessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
    shouldQuery: false,
    tool_use_result: output,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }],
    },
  };
}

function translateTool(state: OapTranslatorState, event: OapTranslatorEvent): OapTranslation {
  const id = event.payload.tool_call_id;
  if (typeof id !== 'string' || !id) return { state, messages: [] };
  const prior = state.tools.find((tool) => tool.id === id);
  if (prior?.settled) return { state, messages: [] };
  const begins = event.type === 'action.call.requested' || event.type === 'action.call.started';
  const ends = ['action.call.completed', 'action.call.failed', 'action.call.cancelled'].includes(
    event.type
  );
  if (!begins && !ends) return { state, messages: [] };
  const messages: SDKMessage[] = [];
  if (!prior) messages.push(toolUse(state, event, id));
  if (ends) messages.push(toolResult(state, event, id));
  const tools = [...state.tools.filter((tool) => tool.id !== id), { id, settled: ends }];
  return { state: { ...state, tools }, messages };
}

function terminalMessage(state: OapTranslatorState, event: OapTranslatorEvent): SDKResultMessage {
  const failed = event.type !== 'run.completed';
  const error = record(event.payload.error);
  const reason = typeof event.payload.stop_reason === 'string' ? event.payload.stop_reason : null;
  const response = record(event.payload.final_response);
  const base = {
    type: 'result' as const,
    uuid: eventUuid(state.sessionId, event.id),
    session_id: state.sessionId,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    is_error: failed,
    stop_reason: reason,
    total_cost_usd: 0,
    usage: usageFor(event),
    modelUsage: {},
    permission_denials: [],
  };
  if (failed) {
    const message =
      typeof error.message === 'string'
        ? error.message
        : typeof event.payload.reason === 'string'
          ? event.payload.reason
          : event.type;
    return { ...base, subtype: 'error_during_execution', errors: [message] };
  }
  return {
    ...base,
    subtype: 'success',
    result: typeof response.content === 'string' ? response.content : '',
  };
}

function translate(state: OapTranslatorState, event: OapTranslatorEvent): OapTranslation {
  if (state.terminal) return { state, messages: [] };
  if (event.type === 'content.delta') {
    const message = assistantMessage(state, event);
    return { state, messages: message ? [message] : [] };
  }
  if (event.type.startsWith('action.call.')) return translateTool(state, event);
  if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
    return { state: { ...state, terminal: true }, messages: [terminalMessage(state, event)] };
  }
  return { state, messages: [] };
}

export const translateOapEvent = (superpipe({})('oap.sdk.translate') as PipelineAPI)
  .input(['state', 'event'])
  .pipe(translate, ['state', 'event'], 'translation')
  .end('translation') as (state: OapTranslatorState, event: OapTranslatorEvent) => OapTranslation;
