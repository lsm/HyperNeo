import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { SessionGroupMessage } from '../hooks/useGroupMessages';

export interface TaskMeta {
  authorRole: 'planner' | 'coder' | 'general' | 'leader' | 'craft' | 'lead' | 'human' | 'system';
  authorSessionId: string;
  turnId: string;
}

export type ParsedGroupMessage = SDKMessage & { _taskMeta?: TaskMeta };

export function parseGroupMessage(msg: SessionGroupMessage): SDKMessage | null {
  // messageType is used for DB records; type is used for WebSocket real-time events.
  // Normalize to whichever field is set.
  const msgAny = msg as unknown as Record<string, unknown>;
  const msgType = msgAny.messageType ?? msgAny.type;

  // Status messages are plain text, not JSON
  if (msgType === 'status') {
    return {
      type: 'status',
      text: msg.content,
      timestamp: msg.createdAt,
      _taskMeta: {
        authorRole: 'system',
        authorSessionId: '',
        turnId: `status-${msg.id}`,
      },
    } as unknown as SDKMessage;
  }

  // Leader summary messages: rendered as a distinct card
  if (msgType === 'leader_summary') {
    return {
      type: 'leader_summary',
      text: msg.content,
      timestamp: msg.createdAt,
      _taskMeta: {
        authorRole: 'system',
        authorSessionId: '',
        turnId: `leader-summary-${msg.id}`,
      },
    } as unknown as SDKMessage;
  }

  // Rate limited: stored as JSON with rich payload (resetsAt, sessionRole).
  // Fall back to content as plain text if not valid JSON.
  if (msgType === 'rate_limited') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(msg.content) as Record<string, unknown>;
    } catch {
      parsed = { text: msg.content };
    }
    return {
      ...parsed,
      type: 'rate_limited',
      timestamp: msg.createdAt,
      _taskMeta: {
        authorRole: 'system',
        authorSessionId: '',
        turnId: `rate-limited-${msg.id}`,
      },
    } as unknown as SDKMessage;
  }

  // Model fallback: stored as JSON with rich payload (fromModel, toModel, sessionRole).
  // Fall back to content as plain text if not valid JSON.
  if (msgType === 'model_fallback') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(msg.content) as Record<string, unknown>;
    } catch {
      parsed = { text: msg.content };
    }
    return {
      ...parsed,
      type: 'model_fallback',
      timestamp: msg.createdAt,
      _taskMeta: {
        authorRole: 'system',
        authorSessionId: '',
        turnId: `model-fallback-${msg.id}`,
      },
    } as unknown as SDKMessage;
  }

  try {
    const parsed = JSON.parse(msg.content) as SDKMessage;
    // Inject timestamp from the database row so message components render the correct creation time
    return { ...parsed, timestamp: msg.createdAt } as unknown as SDKMessage;
  } catch {
    return null;
  }
}
