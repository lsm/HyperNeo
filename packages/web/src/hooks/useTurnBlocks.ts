import { useMemo, useRef } from 'preact/hooks';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import {
  parseGroupMessage,
  type ParsedGroupMessage,
  type TaskMeta,
} from '../lib/parse-group-message';
import { ROLE_COLORS } from '../lib/task-constants';
import type { SessionGroupMessage } from './useGroupMessages';

export interface TurnBlock {
  id: string;
  sessionId: string;
  agentRole: string;
  agentLabel: string;
  startTime: number;
  endTime: number | null;
  messageCount: number;
  toolCallCount: number;
  thinkingCount: number;
  assistantCount: number;
  lastAction: string | null;
  previewMessage: SDKMessage | null;
  isActive: boolean;
  isError: boolean;
  errorMessage: string | null;
  messages: SDKMessage[];
  hiddenCount: number;
}

export interface RuntimeMessage {
  type: 'runtime';
  message: SDKMessage;
  index: number;
}

export type TurnBlockItem = { type: 'turn'; turn: TurnBlock } | RuntimeMessage;

function getTaskMeta(msg: SDKMessage): TaskMeta | null {
  const meta = (msg as ParsedGroupMessage)._taskMeta;
  return meta ?? null;
}

function getMessageUuid(msg: SDKMessage): string | null {
  const m = msg as { uuid?: string };
  return typeof m.uuid === 'string' ? m.uuid : null;
}

function getMessageTimestamp(msg: SDKMessage): number {
  const m = msg as { timestamp?: number };
  return typeof m.timestamp === 'number' ? m.timestamp : 0;
}

function countAssistantBlocks(msg: SDKMessage): { toolCalls: number; thinking: number } {
  if (msg.type !== 'assistant') return { toolCalls: 0, thinking: 0 };

  type Block = { type: string };
  const assistantMsg = msg as { type: 'assistant'; message?: { content?: Block[] } };
  const content = assistantMsg.message?.content;
  if (!Array.isArray(content)) return { toolCalls: 0, thinking: 0 };

  let toolCalls = 0;
  let thinking = 0;
  for (const block of content) {
    if (block.type === 'tool_use') toolCalls++;
    if (block.type === 'thinking') thinking++;
  }
  return { toolCalls, thinking };
}

function extractLastToolName(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null;

  type Block = { type: string; name?: string };
  const assistantMsg = msg as { type: 'assistant'; message?: { content?: Block[] } };
  const content = assistantMsg.message?.content;
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === 'tool_use' && typeof block.name === 'string') return block.name;
  }
  return null;
}

function extractErrorInfo(msg: SDKMessage): { isError: boolean; errorMessage: string | null } {
  if (msg.type === 'result') {
    const resultMsg = msg as { is_error?: boolean; errors?: string[] };
    if (!resultMsg.is_error) return { isError: false, errorMessage: null };
    const errorText =
      Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0 ? resultMsg.errors[0] : null;
    return { isError: true, errorMessage: errorText };
  }

  const m = msg as { error?: string };
  if (typeof m.error === 'string') {
    return { isError: true, errorMessage: m.error };
  }

  return { isError: false, errorMessage: null };
}

function extractTurnErrorInfo(msgs: SDKMessage[]): {
  isError: boolean;
  errorMessage: string | null;
} {
  let result: { isError: boolean; errorMessage: string | null } = {
    isError: false,
    errorMessage: null,
  };
  for (const msg of msgs) {
    const info = extractErrorInfo(msg);
    if (info.isError) result = info;
  }
  return result;
}

function hasResultMessage(msgs: SDKMessage[]): boolean {
  return msgs.some((m) => m.type === 'result');
}

interface TurnAccumulator {
  sessionId: string;
  agentRole: string;
  firstMsgUuid: string | null;
  startTime: number;
  msgs: SDKMessage[];
  toolCallCount: number;
  thinkingCount: number;
  assistantCount: number;
  lastAction: string | null;
}

export function useTurnBlocks(messages: SessionGroupMessage[], isAtTail = true): TurnBlockItem[] {
  const prevTurnsRef = useRef(new Map<string, TurnBlock>());

  return useMemo(() => {
    const parsedMessages = messages
      .map(parseGroupMessage)
      .filter((m): m is SDKMessage => m !== null);

    const items: TurnBlockItem[] = [];
    let current: TurnAccumulator | null = null;
    let pendingRuntime: RuntimeMessage[] = [];
    const pendingTaskMsg = new Map<string, SDKMessage>();

    const flushTurnAndRuntime = (bySessionChange = false): void => {
      if (!current) {
        for (const rt of pendingRuntime) {
          items.push(rt);
        }
        pendingRuntime = [];
        return;
      }

      const { sessionId, agentRole, firstMsgUuid, startTime, msgs } = current;

      if (msgs.length === 0) {
        current = null;
        for (const rt of pendingRuntime) {
          items.push(rt);
        }
        pendingRuntime = [];
        return;
      }

      if (
        bySessionChange &&
        msgs.length === 1 &&
        msgs[0].type === 'user' &&
        getMessageUuid(msgs[0]) !== null
      ) {
        pendingTaskMsg.set(sessionId, msgs[0]);
        current = null;
        for (const rt of pendingRuntime) {
          items.push(rt);
        }
        pendingRuntime = [];
        return;
      }

      const lastMsg = msgs[msgs.length - 1] ?? null;
      const agentLabel = ROLE_COLORS[agentRole]?.label ?? agentRole;
      const { isError, errorMessage } = extractTurnErrorInfo(msgs);

      const id = firstMsgUuid ?? `${sessionId}-${startTime}`;

      items.push({
        type: 'turn',
        turn: {
          id,
          sessionId,
          agentRole,
          agentLabel,
          startTime,
          endTime: lastMsg ? getMessageTimestamp(lastMsg) : null,
          messageCount: msgs.length,
          toolCallCount: current.toolCallCount,
          thinkingCount: current.thinkingCount,
          assistantCount: current.assistantCount,
          lastAction: current.lastAction,
          previewMessage: lastMsg,
          isActive: false,
          isError,
          errorMessage,
          messages: msgs,
          hiddenCount: 0,
        },
      });

      current = null;

      for (const rt of pendingRuntime) {
        items.push(rt);
      }
      pendingRuntime = [];
    };

    for (let i = 0; i < parsedMessages.length; i++) {
      const msg = parsedMessages[i];
      const meta = getTaskMeta(msg);

      if (!meta || meta.authorRole === 'system') {
        if (current) {
          pendingRuntime.push({ type: 'runtime', message: msg, index: i });
        } else {
          items.push({ type: 'runtime', message: msg, index: i });
        }
        continue;
      }

      const { authorRole, authorSessionId } = meta;

      if (msg.type === 'system') {
        continue;
      }

      if (current && current.sessionId !== authorSessionId) {
        flushTurnAndRuntime(true);
      }

      if (!current) {
        const held: SDKMessage | null = pendingTaskMsg.get(authorSessionId) ?? null;
        if (held) pendingTaskMsg.delete(authorSessionId);

        current = {
          sessionId: authorSessionId,
          agentRole: authorRole,
          firstMsgUuid: held ? getMessageUuid(held) : getMessageUuid(msg),
          startTime: held ? getMessageTimestamp(held) : getMessageTimestamp(msg),
          msgs: held ? [held] : [],
          toolCallCount: 0,
          thinkingCount: 0,
          assistantCount: 0,
          lastAction: null,
        };
      }

      const { toolCalls, thinking } = countAssistantBlocks(msg);
      current.toolCallCount += toolCalls;
      current.thinkingCount += thinking;
      if (msg.type === 'assistant') current.assistantCount++;

      const toolName = extractLastToolName(msg);
      if (toolName) current.lastAction = toolName;

      current.msgs.push(msg);

      if (msg.type === 'result') {
        flushTurnAndRuntime();
      }
    }

    flushTurnAndRuntime();

    for (const [sessionId, held] of pendingTaskMsg) {
      const meta = getTaskMeta(held);
      if (!meta) continue;
      const agentRole = meta.authorRole;
      const agentLabel = ROLE_COLORS[agentRole]?.label ?? agentRole;
      const startTime = getMessageTimestamp(held);
      items.push({
        type: 'turn',
        turn: {
          id: getMessageUuid(held) ?? `${sessionId}-${startTime}`,
          sessionId,
          agentRole,
          agentLabel,
          startTime,
          endTime: startTime,
          messageCount: 1,
          toolCallCount: 0,
          thinkingCount: 0,
          assistantCount: 0,
          lastAction: null,
          previewMessage: held,
          isActive: false,
          isError: false,
          errorMessage: null,
          messages: [held],
          hiddenCount: 0,
        },
      });
    }

    if (isAtTail && items.length > 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type === 'turn') {
          const isStillStreaming = !hasResultMessage(item.turn.messages);
          if (isStillStreaming) {
            item.turn.endTime = null;
            item.turn.isActive = true;
          }
          break;
        }
      }
    }

    const TURN_PREVIEW_TAIL = 3;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type !== 'turn' || item.turn.isActive) continue;
      const msgs = item.turn.messages;
      if (msgs.length > TURN_PREVIEW_TAIL + 1) {
        const hiddenCount = msgs.length - TURN_PREVIEW_TAIL - 1;
        items[i] = {
          type: 'turn',
          turn: {
            ...item.turn,
            messages: [msgs[0], ...msgs.slice(-TURN_PREVIEW_TAIL)],
            hiddenCount,
          },
        };
      }
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type !== 'turn' || item.turn.isActive) continue;
      const prev = prevTurnsRef.current.get(item.turn.id);
      if (
        prev &&
        prev.messageCount === item.turn.messageCount &&
        prev.endTime === item.turn.endTime &&
        prev.isError === item.turn.isError
      ) {
        items[i] = { type: 'turn', turn: prev };
      }
    }
    const nextCache = new Map<string, TurnBlock>();
    for (const item of items) {
      if (item.type === 'turn') nextCache.set(item.turn.id, item.turn);
    }
    prevTurnsRef.current = nextCache;

    return items;
  }, [messages, isAtTail]);
}
