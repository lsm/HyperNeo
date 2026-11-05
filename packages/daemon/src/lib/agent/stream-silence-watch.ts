export const STREAM_STALL_ERROR = 'Model stream stalled';

const DEFAULT_STREAM_SILENCE_TIMEOUT_MS = 180_000;
const DEFAULT_OPEN_TOOL_STALL_TIMEOUT_MS = 30 * 60_000;

export function getStreamSilenceTimeoutMs(): number {
  const raw = process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS;
  if (!raw) return DEFAULT_STREAM_SILENCE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_SILENCE_TIMEOUT_MS;
}

export function getOpenToolStallTimeoutMs(): number {
  const raw = process.env.HYPERNEO_SDK_OPEN_TOOL_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_OPEN_TOOL_STALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPEN_TOOL_STALL_TIMEOUT_MS;
}

export interface StreamSilenceState {
  lastActivityAt: number;
  openTools: readonly string[];
}

interface WatchedMessage {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  retry_delay_ms?: number;
  message?: unknown;
}

const contentOf = (message: WatchedMessage): unknown =>
  typeof message.message === 'object' && message.message !== null
    ? (message.message as { content?: unknown }).content
    : undefined;

const blocks = (message: WatchedMessage, type: string, key: 'id' | 'tool_use_id'): string[] => {
  const content = contentOf(message);
  return Array.isArray(content)
    ? content.flatMap((block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === type &&
        typeof (block as Record<string, unknown>)[key] === 'string'
          ? [(block as Record<string, string>)[key]]
          : []
      )
    : [];
};

export function noteStreamFed(state: StreamSilenceState, now: number): StreamSilenceState {
  return { ...state, lastActivityAt: Math.max(state.lastActivityAt, now) };
}

export function noteStreamMessage(
  state: StreamSilenceState,
  message: WatchedMessage,
  now: number
): StreamSilenceState {
  const quietUntil = now + (message.subtype === 'api_retry' ? (message.retry_delay_ms ?? 0) : 0);
  const lastActivityAt = Math.max(state.lastActivityAt, quietUntil);
  if (message.parent_tool_use_id) return { ...state, lastActivityAt };
  if (message.type === 'result') return { lastActivityAt, openTools: [] };
  if (message.type === 'assistant')
    return {
      lastActivityAt,
      openTools: [...state.openTools, ...blocks(message, 'tool_use', 'id')],
    };
  if (message.type === 'user') {
    const done = new Set(blocks(message, 'tool_result', 'tool_use_id'));
    return { lastActivityAt, openTools: state.openTools.filter((id) => !done.has(id)) };
  }
  return { ...state, lastActivityAt };
}

export function planStreamSilence(input: {
  state: StreamSilenceState;
  processing: boolean;
  now: number;
  thresholdMs: number;
  openToolStallMs: number;
}): { stalled: true; silentMs: number } | { stalled: false; waitMs: number } {
  const { state, processing, now, thresholdMs, openToolStallMs } = input;
  if (!processing) return { stalled: false, waitMs: thresholdMs };
  const silentMs = now - state.lastActivityAt;
  const boundMs = state.openTools.length ? openToolStallMs : thresholdMs;
  return silentMs >= boundMs
    ? { stalled: true, silentMs }
    : { stalled: false, waitMs: boundMs - silentMs };
}
