import {
  claudeInputText,
  claudeTurnEnded,
  type ClaudeTranscriptEntry,
} from './claude-desktop-adapter.ts';
import type { WorkTurnQuestion } from './types.ts';

const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up';

type WrapUp = { ask?: unknown; recap?: unknown; blocked?: unknown; actions?: unknown };
type Message = { id?: unknown; content?: unknown };

function parseEntry(line: string): ClaudeTranscriptEntry | null {
  try {
    return JSON.parse(line) as ClaudeTranscriptEntry | null;
  } catch {
    return null;
  }
}

function wrapUpInput(entry: ClaudeTranscriptEntry): WrapUp | null {
  const content = (entry.message as Message | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const call = content.findLast(
    (part: { type?: unknown; name?: unknown }) =>
      part?.type === 'tool_use' && part.name === WRAP_UP_TOOL
  ) as { input?: WrapUp } | undefined;
  return call ? (call.input ?? {}) : null;
}

function wrapUpQuestion(input: WrapUp): WorkTurnQuestion | null {
  const text = input.ask ?? (input.blocked === true ? input.recap : undefined);
  if (typeof text !== 'string' || !text.trim()) return null;
  const actions = Array.isArray(input.actions) ? input.actions : [];
  return {
    text: text.trim(),
    actions: actions.flatMap((item: { label?: unknown; action?: unknown }) => {
      const label = item?.label ?? item?.action;
      return typeof label === 'string' ? [label] : [];
    }),
  };
}

export function claudeTurnQuestion(lines: readonly string[]): WorkTurnQuestion | null {
  let endedBy: unknown;
  let ended = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parseEntry(lines[index]);
    if (!entry || entry.isSidechain === true) continue;
    if (claudeInputText(entry) !== null) return null;
    if (entry.type !== 'assistant') continue;
    const input = wrapUpInput(entry);
    if (input) return ended ? wrapUpQuestion(input) : null;
    if (!claudeTurnEnded(entry)) continue;
    const id = (entry.message as Message | undefined)?.id;
    if (ended && id !== endedBy) return null;
    ended = true;
    endedBy = id;
  }
  return null;
}
