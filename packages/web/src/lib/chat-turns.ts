import type { ChatMessage } from '@hyperneo/shared';

export type TurnOutcome = 'running' | 'done' | 'failed' | 'stopped';

export interface ChatTurn {
  key: string;
  messages: ChatMessage[];
  toolCount: number;
  errorCount: number;
  startedAt: number | null;
  durationMs: number | null;
  outcome: TurnOutcome;
}

type Loose = Record<string, unknown>;

function contentBlocks(message: ChatMessage): Loose[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) ? (content as Loose[]) : [];
}

function isTopLevel(message: ChatMessage): boolean {
  return !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
}

function startsTurn(message: ChatMessage): boolean {
  return (
    message.type === 'user' &&
    isTopLevel(message) &&
    !contentBlocks(message).some((block) => block?.type === 'tool_result')
  );
}

function timestampOf(message: ChatMessage): number | null {
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === 'number' && value > 0 ? value : null;
}

function summarize(messages: ChatMessage[], isLast: boolean): ChatTurn {
  let toolCount = 0;
  let errorCount = 0;
  let result: Loose | null = null;
  for (const message of messages) {
    if (!isTopLevel(message)) continue;
    const blocks = contentBlocks(message);
    if (message.type === 'assistant')
      toolCount += blocks.filter((block) => block?.type === 'tool_use').length;
    if (message.type === 'user')
      errorCount += blocks.filter(
        (block) => block?.type === 'tool_result' && block.is_error
      ).length;
    if (message.type === 'result') result = message as unknown as Loose;
  }
  const startedAt = timestampOf(messages[0]);
  const lastAt = timestampOf(messages[messages.length - 1]);
  const failed = !!result && (result.is_error === true || result.subtype !== 'success');
  return {
    key: (messages[0] as { uuid?: string }).uuid ?? `turn-${startedAt ?? 0}`,
    messages,
    toolCount,
    errorCount,
    startedAt,
    durationMs:
      typeof result?.duration_ms === 'number'
        ? result.duration_ms
        : startedAt !== null && lastAt !== null
          ? lastAt - startedAt
          : null,
    outcome: result ? (failed ? 'failed' : 'done') : isLast ? 'running' : 'stopped',
  };
}

export function buildChatTurns(messages: ChatMessage[]): ChatTurn[] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (groups.length === 0 || startsTurn(message)) groups.push([message]);
    else groups[groups.length - 1].push(message);
  }
  return groups.map((group, index) => summarize(group, index === groups.length - 1));
}
