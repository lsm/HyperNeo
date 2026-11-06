import { workEntryTime } from './work-messages.ts';

export const INJECTED_INPUT = /^<([a-z_]+)>[\s\S]*<\/\1>$/;

export function parseLine(
  line: string
): { type?: unknown; payload?: Record<string, unknown>; timestamp?: unknown } | null {
  try {
    const entry = JSON.parse(line) as {
      type?: unknown;
      payload?: Record<string, unknown>;
      timestamp?: unknown;
    };
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

export function messageText(payload: Record<string, unknown>, role: string): string | null {
  if (payload.type !== 'message' || payload.role !== role) return null;
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const text = parts
    .flatMap((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : []
    )
    .join('\n')
    .trim();
  return text || null;
}

export function codexUserInput(
  entry: ReturnType<typeof parseLine>
): { id: string; text: string; at: number | undefined } | null {
  const payload = entry?.type === 'response_item' ? (entry.payload ?? {}) : null;
  const text = payload ? messageText(payload, 'user') : null;
  if (!payload || text === null || INJECTED_INPUT.test(text) || typeof payload.id !== 'string')
    return null;
  return payload.id ? { id: payload.id, text, at: workEntryTime(entry?.timestamp) } : null;
}
