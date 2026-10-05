import type { SDKMessage } from '@hyperneo/shared/sdk';

export interface MessageSearchParams {
  query: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
  from?: number;
  to?: number;
  messageType?: string;
}

export interface MessageSearchLoadTarget {
  sessionId: string;
  before?: number;
}

export interface MessageSearchResult {
  kind: 'message' | 'task';
  sourceId: string;
  messageId?: string;
  sessionId?: string;
  taskId?: string;
  spaceId?: string;
  taskNumber?: number;
  messageType?: string;
  title: string;
  snippet: string;
  timestamp: number;
  loadTarget?: MessageSearchLoadTarget;
  rank: number;
}

export interface MessageSearchResponse {
  results: MessageSearchResult[];
  limit: number;
  offset: number;
}

export function extractVisibleSearchText(message: SDKMessage | Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = message as Record<string, unknown>;
  const sdkMessage = msg.message as Record<string, unknown> | undefined;
  const content = sdkMessage?.content;

  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        parts.push(block.thinking);
      }
    }
  }

  if (msg.type === 'result' && typeof msg.result === 'string') {
    parts.push(msg.result);
  }

  if (msg.type === 'hyperneo_action') {
    for (const key of ['title', 'message', 'question', 'prompt', 'action']) {
      const value = msg[key];
      if (typeof value === 'string') parts.push(value);
    }
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

export const MESSAGE_SEARCH_MIN_TERM_LENGTH = 3;
export const MESSAGE_SEARCH_BROAD_TERM_LENGTH = 4;

export function buildFtsTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((term) => term.length >= MESSAGE_SEARCH_MIN_TERM_LENGTH)
    .slice(0, 12);
}

export function isBroadMessageSearchQuery(query: string): boolean {
  const terms = buildFtsTerms(query);
  return terms.length <= 1 || terms.some((term) => term.length <= MESSAGE_SEARCH_BROAD_TERM_LENGTH);
}

export function buildFtsQuery(query: string): string {
  const terms = buildFtsTerms(query);
  return terms.map((term) => `"${term}"*`).join(' ');
}

export function messageSearchPolicy(tables: { sessions: boolean; spaceTasks: boolean }): {
  joins: string;
  where: string;
} {
  const joins = [
    tables.sessions ? 'LEFT JOIN sessions s ON s.id = msc.session_id' : '',
    tables.spaceTasks ? 'LEFT JOIN space_tasks st ON st.id = msc.task_id' : '',
  ].join('\n');
  const sessionPolicy = tables.sessions
    ? `AND COALESCE(s.status, '') != 'archived'
				AND NOT (
					COALESCE(s.status, '') = 'ended'
					AND strftime('%s', s.last_active_at) < strftime('%s', 'now', '-30 days')
				)`
    : '';
  const taskPolicy = tables.spaceTasks
    ? `AND COALESCE(st.status, '') != 'archived'
				AND NOT (
					COALESCE(st.status, '') IN ('done', 'cancelled', 'completed')
					AND COALESCE(st.completed_at, st.updated_at, 0) < unixepoch('now', '-30 days') * 1000
				)`
    : '';
  return { joins, where: `${sessionPolicy}\n${taskPolicy}` };
}
