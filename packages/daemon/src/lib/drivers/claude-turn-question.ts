import {
  claudeInputText,
  claudeTurnEnded,
  type ClaudeTranscriptEntry,
} from './claude-desktop-adapter.ts';
import type { WorkTurnQuestion } from './types.ts';

const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up';

type WrapUp = { ask?: unknown; recap?: unknown; blocked?: unknown; actions?: unknown };
type WrapUpCall = { id?: unknown; input?: WrapUp };
type Message = { id?: unknown; content?: unknown };

function parseEntry(line: string): ClaudeTranscriptEntry | null {
  try {
    return JSON.parse(line) as ClaudeTranscriptEntry | null;
  } catch {
    return null;
  }
}

function wrapUpCall(entry: ClaudeTranscriptEntry): WrapUpCall | null {
  const content = (entry.message as Message | undefined)?.content;
  if (!Array.isArray(content)) return null;
  return (
    (content.findLast(
      (part: { type?: unknown; name?: unknown }) =>
        part?.type === 'tool_use' && part.name === WRAP_UP_TOOL
    ) as WrapUpCall | undefined) ?? null
  );
}

function wrapUpQuestion(call: WrapUpCall, entry: ClaudeTranscriptEntry): WorkTurnQuestion | null {
  const input = call.input ?? {};
  const text = input.ask ?? (input.blocked === true ? input.recap : undefined);
  if (typeof text !== 'string' || !text.trim()) return null;
  const actions = Array.isArray(input.actions) ? input.actions : [];
  return {
    id: typeof call.id === 'string' ? call.id : String(entry.uuid),
    at: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) || 0 : 0,
    text: text.trim(),
    actions: actions.flatMap((item: { label?: unknown; action?: unknown }) => {
      const label = item?.label ?? item?.action;
      return typeof label === 'string' ? [label] : [];
    }),
  };
}

const queuedReply = (entry: ClaudeTranscriptEntry & { operation?: unknown; content?: unknown }) =>
  entry.type === 'queue-operation' &&
  (entry.operation === undefined || entry.operation === 'enqueue') &&
  typeof entry.content === 'string' &&
  entry.content.trim().length > 0;

export function claudeTurnQuestion(lines: readonly string[]): WorkTurnQuestion | null {
  let endedBy: unknown;
  let ended = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parseEntry(lines[index]);
    if (!entry || entry.isSidechain === true) continue;
    if (claudeInputText(entry) !== null || queuedReply(entry)) return null;
    if (entry.type !== 'assistant') continue;
    const call = wrapUpCall(entry);
    if (call) return ended ? wrapUpQuestion(call, entry) : null;
    if (!claudeTurnEnded(entry)) continue;
    const id = (entry.message as Message | undefined)?.id;
    if (ended && id !== endedBy) return null;
    ended = true;
    endedBy = id;
  }
  return null;
}
