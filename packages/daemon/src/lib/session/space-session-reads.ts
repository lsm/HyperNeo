import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';

export type SpaceSessionStatusFilter =
  | 'active'
  | 'idle'
  | 'waiting_for_input'
  | 'error'
  | 'archived';

export type SpaceSessionTypeFilter = 'worker' | 'ad-hoc';

export interface SpaceSessionRow {
  id: string;
  title: string;
  workspace_path: string | null;
  created_at: string;
  last_active_at: string;
  status: string;
  metadata: string | null;
  is_worktree: number;
  git_branch: string | null;
  processing_state: string | null;
  type: string | null;
  session_context: string | null;
}

export interface SpaceSessionSummary {
  id: string;
  title: string;
  status: string;
  type: SpaceSessionTypeFilter;
  processing_state: Record<string, unknown>;
  created_at: string;
  last_active_at: string;
  is_worktree: boolean;
  git_branch: string | null;
  workspace_path: string | null;
}

export interface SpaceSessionMessage {
  id: string;
  message_type: string;
  message_subtype: string | null;
  is_terminal: boolean;
  timestamp: string;
  cursor: string;
  content_summary: string;
}

export const SPACE_SESSION_LIMIT_MAX = 100;
export const SPACE_SESSION_LIMIT_DEFAULT = 50;
export const SESSION_MESSAGE_LIMIT_MAX = 100;
export const SESSION_MESSAGE_LIMIT_DEFAULT = 20;
export const SESSION_DETAIL_MESSAGE_LIMIT = 5;

const SPACE_SESSION_COLUMNS = `id, title, workspace_path, created_at, last_active_at, status, metadata,
                is_worktree, git_branch, processing_state, type, session_context`;

export function parseJsonValue(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseProcessingState(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { status: value ?? 'idle' };
}

function normalizeProcessingStatus(row: SpaceSessionRow): SpaceSessionStatusFilter {
  if (row.status === 'archived') return 'archived';
  const state = parseProcessingState(row.processing_state);
  const status = typeof state.status === 'string' ? state.status : 'idle';
  if (
    status === 'processing' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'rate_limit_cooldown'
  ) {
    return 'active';
  }
  if (status === 'waiting_for_input') return 'waiting_for_input';
  if (status === 'error') return 'error';
  return 'idle';
}

function sessionKind(row: SpaceSessionRow): SpaceSessionTypeFilter {
  const context = parseJsonValue(row.session_context) as Record<string, unknown> | null;
  return row.type === 'space_task_agent' || typeof context?.taskId === 'string'
    ? 'worker'
    : 'ad-hoc';
}

export function rowToSessionSummary(row: SpaceSessionRow): SpaceSessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: normalizeProcessingStatus(row),
    type: sessionKind(row),
    processing_state: parseProcessingState(row.processing_state),
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    is_worktree: row.is_worktree === 1,
    git_branch: row.git_branch,
    workspace_path: row.workspace_path,
  };
}

export function getSpaceSessionRow(
  db: BunDatabase,
  spaceId: string,
  sessionId: string
): SpaceSessionRow | null {
  const row = db
    .prepare(
      `SELECT ${SPACE_SESSION_COLUMNS}
           FROM sessions
          WHERE id = ?
            AND space_id = ?
          LIMIT 1`
    )
    .get(sessionId, spaceId) as SpaceSessionRow | undefined;
  return row ?? null;
}

export function listSpaceSessionRows(
  db: BunDatabase,
  spaceId: string,
  filters: { status?: SpaceSessionStatusFilter; type?: SpaceSessionTypeFilter },
  limit: number,
  offset: number
): SpaceSessionRow[] {
  const clauses = [`space_id = ?`];
  const params: Array<string | number> = [spaceId];
  const processingStatus = `COALESCE(json_extract(processing_state, '$.status'), 'idle')`;
  if (filters.status === 'archived') {
    clauses.push(`status = 'archived'`);
  } else if (filters.status === 'active') {
    clauses.push(`status != 'archived'`);
    clauses.push(
      `${processingStatus} IN ('processing', 'queued', 'running', 'rate_limit_cooldown')`
    );
  } else if (filters.status === 'waiting_for_input' || filters.status === 'error') {
    clauses.push(`status != 'archived'`);
    clauses.push(`${processingStatus} = ?`);
    params.push(filters.status);
  } else if (filters.status === 'idle') {
    clauses.push(`status != 'archived'`);
    clauses.push(
      `${processingStatus} NOT IN ('processing', 'queued', 'running', 'rate_limit_cooldown', 'waiting_for_input', 'error')`
    );
  }
  if (filters.type === 'worker') {
    clauses.push(`(type = 'space_task_agent' OR task_id IS NOT NULL)`);
  } else if (filters.type === 'ad-hoc') {
    clauses.push(`(type != 'space_task_agent' AND task_id IS NULL)`);
  }
  params.push(limit, offset);
  return db
    .prepare(
      `SELECT ${SPACE_SESSION_COLUMNS}
           FROM sessions
          WHERE ${clauses.join(' AND ')}
          ORDER BY last_active_at DESC
          LIMIT ? OFFSET ?`
    )
    .all(...params) as SpaceSessionRow[];
}

function summarizeMessageContent(raw: string): string {
  const parsed = parseJsonValue(raw) as Record<string, unknown> | null;
  const content = (parsed?.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const item = block as { text?: unknown; thinking?: unknown; type?: unknown };
        if (typeof item.text === 'string') return item.text;
        if (typeof item.thinking === 'string') return item.thinking;
        if (typeof item.type === 'string') return `[${item.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized;
}

export function listSessionMessages(
  db: BunDatabase,
  sessionId: string,
  limit: number,
  before?: string
): SpaceSessionMessage[] {
  const boundedLimit = Math.min(Math.max(limit, 1), SESSION_MESSAGE_LIMIT_MAX);
  const params: (string | number)[] = [sessionId];
  let beforeClause = '';
  if (before) {
    const [beforeTimestamp, beforeId] = before.includes('|') ? before.split('|', 2) : [before, ''];
    if (beforeId) {
      beforeClause = 'AND (timestamp < ? OR (timestamp = ? AND id < ?))';
      params.push(beforeTimestamp, beforeTimestamp, beforeId);
    } else {
      beforeClause = 'AND timestamp < ?';
      params.push(beforeTimestamp);
    }
  }
  params.push(boundedLimit);
  const rows = db
    .prepare(
      `SELECT id, message_type, message_subtype, is_terminal, timestamp, sdk_message
           FROM sdk_messages
          WHERE session_id = ? ${beforeClause}
            AND COALESCE(message_subtype, '') NOT IN ('thinking_tokens', 'session_state_changed', 'commands_changed')
            AND NOT EXISTS (
              SELECT 1
              FROM sdk_message_replacements replacement
              WHERE replacement.session_id = sdk_messages.session_id
                AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
            )
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`
    )
    .all(...params) as Array<{
    id: string;
    message_type: string;
    message_subtype: string | null;
    is_terminal: number | null;
    timestamp: string;
    sdk_message: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    message_type: row.message_type,
    message_subtype: row.message_subtype,
    is_terminal: row.is_terminal === 1,
    timestamp: row.timestamp,
    cursor: `${row.timestamp}|${row.id}`,
    content_summary: summarizeMessageContent(row.sdk_message),
  }));
}
