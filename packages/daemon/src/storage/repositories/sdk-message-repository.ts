import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID, sendStatusToDeliveryStatus } from '@hyperneo/shared';
import type {
  MessageContent,
  MessageDeliveryStatus,
  MessageOrigin,
  HyperNeoActionMessage,
  ChatMessage,
} from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import type { ReactiveDatabase } from '../reactive-database';
import { Logger } from '../../lib/logger';
import {
  buildFtsQuery,
  extractVisibleSearchText,
  isBroadMessageSearchQuery,
  type MessageSearchParams,
  type MessageSearchResponse,
  type MessageSearchResult,
} from '../message-search';
import type { SQLiteValue } from '../types';

export type SendStatus = 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';

const MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_SESSION_PREFIXES = ['room:chat:', 'planner:', 'coder:', 'leader:', 'general:'];
const ROOM_SESSION_TYPES = new Set(['room_chat', 'planner', 'coder', 'leader', 'general']);
const TERMINAL_SPACE_TASK_STATUSES = new Set(['done', 'cancelled', 'completed']);
const SEARCHABLE_MESSAGE_TYPES = new Set(['system', 'user', 'assistant']);
const RENDERABLE_TEXT_MESSAGE_BATCH_SIZE = 50;
const RENDERABLE_TEXT_MESSAGE_MAX_SCAN = 250;
const STATUS_MESSAGE_HYDRATION_BATCH_SIZE = 900;
const USER_STATUS_MESSAGE_SQL = `message_type = 'user'
  AND json_valid(sdk_message)
  AND json_extract(sdk_message, '$.type') = 'user'
  AND (
    json_type(sdk_message, '$.isReplay') IS NULL
    OR json_type(sdk_message, '$.isReplay') = 'false'
  )`;

const LAST_MESSAGE_PROGRESS_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated']);
const BACKGROUND_TASK_METADATA_SUBTYPES = ['task_started', 'task_updated', 'task_notification'];
const BACKGROUND_TASK_METADATA_BATCH_SIZE = 300;

function toSqlStringList(subtypes: Iterable<string>): string {
  return [...subtypes].map((subtype) => `'${subtype.replace(/'/g, "''")}'`).join(', ');
}

const EXCLUDED_FROM_PAGINATION_SQL_LIST = toSqlStringList([
  ...HIDDEN_SYSTEM_SUBTYPES,
  'thinking_tokens',
]);

const BACKGROUND_TASK_METADATA_SQL_LIST = toSqlStringList(BACKGROUND_TASK_METADATA_SUBTYPES);

const EXCLUDED_FROM_LAST_MESSAGE_SQL_LIST = toSqlStringList([
  ...[...HIDDEN_SYSTEM_SUBTYPES].filter((subtype) => !LAST_MESSAGE_PROGRESS_SUBTYPES.has(subtype)),
  'thinking_tokens',
  'model_refusal_fallback',
]);

const BADGE_HIDDEN_SUBTYPES = new Set<string>([...HIDDEN_SYSTEM_SUBTYPES, 'thinking_tokens']);

function isVisibleBadgeRow(opts: {
  parentToolUseId: string | null;
  messageType: string;
  messageSubtype: string | null;
  sendStatus: SendStatus | null;
}): boolean {
  if (opts.parentToolUseId !== null) return false;
  if (BADGE_HIDDEN_SUBTYPES.has(opts.messageSubtype ?? '')) return false;
  if (opts.messageType === 'user') {
    const status = opts.sendStatus ?? 'consumed';
    return status === 'consumed' || status === 'failed';
  }
  return true;
}

function isOlderThanMessageSearchTtl(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp < Date.now() - MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS;
}

export function computeIsRenderable(message: SDKMessage): 0 | 1 {
  const messageType = message.type;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) {
    return 1;
  }

  if (messageType === 'user') {
    const hasToolResult = content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result'
    );
    return hasToolResult ? 0 : 1;
  }

  if (messageType === 'assistant') {
    const hasRenderable = content.some((block) => {
      if (typeof block !== 'object' || block === null) return false;
      const blockObj = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (blockObj.type === 'tool_use') return true;
      if (blockObj.type === 'text') {
        const text = typeof blockObj.text === 'string' ? blockObj.text : '';
        return text.trim().length > 0;
      }
      if (blockObj.type === 'thinking') {
        const thinking = typeof blockObj.thinking === 'string' ? blockObj.thinking : '';
        return thinking.trim().length > 0;
      }
      return false;
    });
    return hasRenderable ? 1 : 0;
  }

  return 1;
}

export function computeIsTerminal(message: SDKMessage): 0 | 1 {
  return message.type === 'result' ? 1 : 0;
}

export function extractParentToolUseId(message: SDKMessage): string | null {
  const candidate = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof candidate === 'string' ? candidate : null;
}

export function extractSdkUuid(message: SDKMessage): string | null {
  const candidate = (message as { uuid?: unknown }).uuid;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export interface SDKMessageReplacementEdge {
  targetUuid: string;
  kind: 'superseded' | 'retracted';
}

export function extractReplacementEdges(message: SDKMessage): SDKMessageReplacementEdge[] {
  const replacementMessage = message as SDKMessage & {
    supersedes?: unknown;
    retracted_message_uuids?: unknown;
  };
  const edges: SDKMessageReplacementEdge[] = [];
  const seen = new Set<string>();
  const append = (values: unknown, kind: SDKMessageReplacementEdge['kind']) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) continue;
      const key = `${kind}\0${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ targetUuid: value, kind });
    }
  };
  append(replacementMessage.supersedes, 'superseded');
  if ('subtype' in replacementMessage && replacementMessage.subtype === 'model_refusal_fallback') {
    append(replacementMessage.retracted_message_uuids, 'retracted');
  }
  return edges;
}

export class SDKMessageRepository {
  private logger = new Logger('Database');

  private tableExistsCache = new Map<string, boolean>();
  private tableColumnsCache = new Map<string, Set<string> | null>();

  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  private hasMessageSearchIndex(): boolean {
    return this.tableExists('message_search_content');
  }

  private tableExists(tableName: string): boolean {
    const cached = this.tableExistsCache.get(tableName);
    if (cached !== undefined) return cached;
    try {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
      const exists = !!row;
      this.tableExistsCache.set(tableName, exists);
      return exists;
    } catch {
      return false;
    }
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    const columns = this.tableColumns(tableName);
    return columns !== null && columns.has(columnName);
  }

  private tableColumns(tableName: string): Set<string> | null {
    const cached = this.tableColumnsCache.get(tableName);
    if (cached !== undefined) return cached;
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name?: string;
      }>;
      const columns = new Set(
        rows.map((row) => row.name).filter((name): name is string => name !== undefined)
      );
      this.tableColumnsCache.set(tableName, columns);
      return columns;
    } catch {
      return null;
    }
  }

  private saveReplacementEdges(
    sourceMessageId: string,
    sessionId: string,
    taskId: string | null,
    message: SDKMessage
  ): void {
    const edges = extractReplacementEdges(message);
    if (edges.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO sdk_message_replacements (
         source_message_id, session_id, task_id, target_uuid, kind
       ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const edge of edges) {
      insert.run(sourceMessageId, sessionId, taskId, edge.targetUuid, edge.kind);
    }
  }

  private upsertMessageSearchRow(rowId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    const hasSessions = this.tableExists('sessions');
    const hasSpaceTasks = this.tableExists('space_tasks');
    const hasSessionTitle = hasSessions && this.tableHasColumn('sessions', 'title');
    const hasSessionStatus = hasSessions && this.tableHasColumn('sessions', 'status');
    const hasSessionType = hasSessions && this.tableHasColumn('sessions', 'type');
    const hasSessionLastActiveAt = hasSessions && this.tableHasColumn('sessions', 'last_active_at');
    const hasSessionContext = hasSessions && this.tableHasColumn('sessions', 'session_context');
    const hasTaskStatus = hasSpaceTasks && this.tableHasColumn('space_tasks', 'status');
    const hasTaskCompletedAt = hasSpaceTasks && this.tableHasColumn('space_tasks', 'completed_at');
    const hasTaskUpdatedAt = hasSpaceTasks && this.tableHasColumn('space_tasks', 'updated_at');
    const sessionTitleSelect = hasSessionTitle
      ? 's.title AS session_title'
      : 'sm.session_id AS session_title';
    const sessionPolicySelect = `${hasSessionStatus ? 's.status' : 'NULL'} AS session_status,
			   ${hasSessionType ? 's.type' : 'NULL'} AS session_type,
			   ${hasSessionLastActiveAt ? 's.last_active_at' : 'NULL'} AS session_last_active_at,
			   ${hasSessionContext ? 's.session_context' : 'NULL'} AS session_context`;
    const spaceTaskSelect = hasSpaceTasks
      ? `st.space_id, st.task_number,
			   ${hasTaskStatus ? 'st.status' : 'NULL'} AS task_status,
			   ${hasTaskCompletedAt ? 'st.completed_at' : 'NULL'} AS task_completed_at,
			   ${hasTaskUpdatedAt ? 'st.updated_at' : 'NULL'} AS task_updated_at`
      : `NULL AS space_id, NULL AS task_number,
			   NULL AS task_status,
			   NULL AS task_completed_at,
			   NULL AS task_updated_at`;
    const sessionJoin = hasSessions ? 'LEFT JOIN sessions s ON s.id = sm.session_id' : '';
    const spaceTaskJoin = hasSpaceTasks ? 'LEFT JOIN space_tasks st ON st.id = sm.task_id' : '';
    const row = this.db
      .prepare(
        `SELECT sm.id, sm.session_id, sm.task_id, sm.message_type, sm.sdk_message, sm.timestamp,
				        ${sessionTitleSelect}, ${sessionPolicySelect}, ${spaceTaskSelect}
				 FROM sdk_messages sm
				 ${sessionJoin}
				 ${spaceTaskJoin}
				 WHERE sm.id = ?`
      )
      .get(rowId) as
      | {
          id: string;
          session_id: string;
          task_id: string | null;
          message_type: string;
          sdk_message: string;
          timestamp: string;
          session_title: string | null;
          session_status: string | null;
          session_type: string | null;
          session_last_active_at: string | null;
          session_context: string | null;
          space_id: string | null;
          task_number: number | null;
          task_status: string | null;
          task_completed_at: number | null;
          task_updated_at: number | null;
        }
      | undefined;
    if (!row) return;

    let parsed: SDKMessage | null = null;
    try {
      parsed = JSON.parse(row.sdk_message) as SDKMessage;
    } catch {
      return;
    }
    const body = extractVisibleSearchText(parsed);
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND source_id = ?`)
      .run(row.id);
    if (this.isMessageSuperseded(row.id, row.session_id, parsed)) return;
    if (!SEARCHABLE_MESSAGE_TYPES.has(row.message_type)) return;
    if (!this.isMessageSearchIndexEligible(row)) return;
    if (!body) return;
    if (row.message_type === 'user' && !this.isSearchableUserMessageStatus(row.id)) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO message_search_content (
					kind, source_id, message_id, session_id, task_id, space_id, task_number,
					message_type, title, body, timestamp
				) VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        (parsed as { uuid?: string }).uuid ?? row.id,
        row.session_id,
        row.task_id,
        row.space_id,
        row.task_number,
        row.message_type,
        row.session_title ?? row.session_id,
        body,
        parseSearchTimestamp(row.timestamp)
      );
  }

  private isMessageSearchIndexEligible(row: {
    session_id: string;
    session_status: string | null;
    session_type: string | null;
    session_last_active_at: string | null;
    session_context: string | null;
    task_status: string | null;
    task_completed_at: number | null;
    task_updated_at: number | null;
  }): boolean {
    if (ROOM_SESSION_PREFIXES.some((prefix) => row.session_id.startsWith(prefix))) {
      return false;
    }

    if (row.session_status === 'archived') return false;
    if (row.session_status === 'ended' && isOlderThanMessageSearchTtl(row.session_last_active_at)) {
      return false;
    }

    if (row.session_type && ROOM_SESSION_TYPES.has(row.session_type)) return false;
    if (row.session_context) {
      try {
        const context = JSON.parse(row.session_context) as { roomId?: unknown };
        if (typeof context.roomId === 'string') return false;
      } catch {
        // Malformed historical context should not make an otherwise-normal session unsearchable.
      }
    }

    const isSpaceSession =
      row.session_id.startsWith('space:') ||
      row.session_type === 'space_chat' ||
      row.session_type === 'space_task_agent';
    const isNormalSession =
      !row.session_id.includes(':') && (!row.session_type || row.session_type === 'worker');
    if (!isSpaceSession && !isNormalSession) return false;

    if (row.task_status === 'archived') return false;
    if (
      row.task_status &&
      TERMINAL_SPACE_TASK_STATUSES.has(row.task_status) &&
      isOlderThanMessageSearchTtl(row.task_completed_at ?? row.task_updated_at)
    ) {
      return false;
    }

    return true;
  }

  private deleteMessageSearchRow(rowId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND source_id = ?`)
      .run(rowId);
  }

  private getSupersededMessageUuids(message: SDKMessage): string[] {
    const maybeSuperseding = message as SDKMessage & {
      supersedes?: unknown;
      retracted_message_uuids?: unknown;
    };
    return [
      ...(Array.isArray(maybeSuperseding.supersedes) ? maybeSuperseding.supersedes : []),
      ...(Array.isArray(maybeSuperseding.retracted_message_uuids)
        ? maybeSuperseding.retracted_message_uuids
        : []),
    ].filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
  }

  private deleteSupersededMessageSearchRows(sessionId: string, message: SDKMessage): void {
    const supersededUuids = this.getSupersededMessageUuids(message);
    if (supersededUuids.length === 0) return;
    if (!this.hasMessageSearchIndex()) return;

    const placeholders = supersededUuids.map(() => '?').join(',');
    this.db
      .prepare(
        `DELETE FROM message_search_content
         WHERE kind = 'message'
           AND session_id = ?
           AND message_id IN (${placeholders})`
      )
      .run(sessionId, ...supersededUuids);
  }

  private scheduleMessageSearchIndex(messageId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    if (!this.tableExists('message_search_pending')) {
      this.upsertMessageSearchRow(messageId);
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_search_pending (message_id, created_at)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM sdk_messages WHERE id = ?)`
      )
      .run(messageId, Date.now(), messageId);
  }

  flushMessageSearchIndex(limit = 500): number {
    if (!this.hasMessageSearchIndex()) return 0;
    if (!this.tableExists('message_search_pending')) return 0;
    const pending = this.db
      .prepare(`SELECT message_id FROM message_search_pending ORDER BY created_at LIMIT ?`)
      .all(limit) as Array<{ message_id: string }>;
    if (pending.length === 0) return 0;
    const deletePendingStmt = this.db.prepare(
      `DELETE FROM message_search_pending WHERE message_id = ?`
    );
    let processed = 0;
    for (const { message_id } of pending) {
      try {
        this.db.transaction(() => {
          this.upsertMessageSearchRow(message_id);
          deletePendingStmt.run(message_id);
        })();
      } catch (err) {
        this.logger.warn('message search index flush failed, will retry next flush:', err);
      }
      processed++;
    }
    return processed;
  }

  private isMessageSuperseded(rowId: string, sessionId: string, sdkMessage: SDKMessage): boolean {
    const sdkUuid = (sdkMessage as { uuid?: unknown }).uuid;
    if (typeof sdkUuid !== 'string' || sdkUuid.length === 0) return false;

    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sdk_message_replacements replacement
           WHERE replacement.session_id = ?
             AND replacement.source_message_id != ?
             AND replacement.target_uuid = ?
           LIMIT 1`
        )
        .get(sessionId, rowId, sdkUuid)
    );
  }

  private isSearchableUserMessageStatus(rowId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COALESCE(send_status, 'consumed') AS send_status FROM sdk_messages WHERE id = ?`
      )
      .get(rowId) as { send_status: SendStatus } | undefined;
    return row?.send_status === 'consumed' || row?.send_status === 'failed';
  }

  private resolveTaskIdForSession(sessionId: string): string | null {
    try {
      if (
        !this.tableExists('sessions') ||
        !this.tableHasColumn('sessions', 'session_context') ||
        !this.tableHasColumn('sessions', 'type')
      ) {
        return null;
      }
      const row = this.db
        .prepare(
          `SELECT
						CASE
							WHEN session_context IS NULL THEN NULL
							WHEN NOT json_valid(session_context) THEN NULL
							ELSE json_extract(session_context, '$.taskId')
						END AS task_id,
						type
					 FROM sessions WHERE id = ?`
        )
        .get(sessionId) as { task_id: string | null; type: string | null } | undefined;
      if (!row) return null;
      const allowedTypes = ['space_task_agent', 'worker'];
      if (!row.type || !allowedTypes.includes(row.type)) return null;
      return row.task_id ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) {
        this.logger.warn(
          `sessions table missing when resolving task_id for session ${sessionId}; ` +
            'message will not appear in task timelines'
        );
        return null;
      }
      throw err;
    }
  }

  private resolveConversationTurnIndex(
    taskId: string | null,
    sessionId: string,
    isAnchor: boolean
  ): number | null {
    if (!taskId) return null;
    if (isAnchor) {
      const row = this.db
        .prepare('SELECT MAX(conversation_turn_index) AS m FROM sdk_messages WHERE task_id = ?')
        .get(taskId) as { m: number | null } | undefined;
      return (row?.m ?? 0) + 1;
    }
    const row = this.db
      .prepare(
        'SELECT MAX(conversation_turn_index) AS m FROM sdk_messages WHERE task_id = ? AND session_id = ?'
      )
      .get(taskId, sessionId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  saveSDKMessage(sessionId: string, message: SDKMessage, origin?: MessageOrigin): boolean {
    try {
      const id = generateUUID();
      const messageType = message.type;
      const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
      const timestamp = new Date().toISOString();
      const taskId = this.resolveTaskIdForSession(sessionId);
      const isRenderable = computeIsRenderable(message);
      const isTerminal = computeIsTerminal(message);
      const isConversationAnchor = isRenderable === 1 && messageType === 'user';
      const parentToolUseId = extractParentToolUseId(message);
      const countsTowardsBadge = isVisibleBadgeRow({
        parentToolUseId,
        messageType,
        messageSubtype,
        sendStatus: null,
      });

      const stmt = this.db.prepare(
        `INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, origin,
					is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
					sdk_uuid, replacement_metadata_normalized
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      );

      this.db.transaction(() => {
        const conversationTurnIndex = this.resolveConversationTurnIndex(
          taskId,
          sessionId,
          isConversationAnchor
        );
        const values = [
          id,
          sessionId,
          messageType,
          messageSubtype,
          JSON.stringify(message),
          timestamp,
          origin ?? null,
          isRenderable,
          isTerminal,
          parentToolUseId,
          taskId,
        ];
        stmt.run(...values, conversationTurnIndex, extractSdkUuid(message));
        if (isTerminal && this.tableHasColumn('sdk_messages', 'consumed_seq')) {
          const resultSeq = this.nextConsumedSeq();
          if (resultSeq !== null) {
            this.db
              .prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE id = ?')
              .run(resultSeq, id);
          }
        }
        this.saveReplacementEdges(id, sessionId, taskId, message);
        this.scheduleMessageSearchIndex(id);
        if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
      })();
      if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
      this.deleteSupersededMessageSearchRows(sessionId, message);
      return true;
    } catch (error) {
      this.logger.error('[Database] Failed to save SDK message:', error);
      this.logger.error('[Database] Message type:', message.type, 'Session:', sessionId);
      return false;
    }
  }

  getSDKMessages(
    sessionId: string,
    limit?: number,
    before?: number,
    since?: number,
    beforeRowid?: number,
    sinceRowid?: number
  ): {
    messages: Array<
      ChatMessage & {
        timestamp: number;
        origin?: MessageOrigin;
        deliveryStatus?: MessageDeliveryStatus;
      }
    >;
    hasMore: boolean;
  } {
    return this._getSDKMessagesImpl(
      sessionId,
      limit ?? 100,
      before,
      since,
      beforeRowid,
      sinceRowid
    );
  }

  getRenderableTextMessages(
    sessionId: string,
    limit = 20
  ): Array<{ id: string; type: string; text: string; timestamp: number }> {
    const messages: Array<{ id: string; type: string; text: string; timestamp: number }> = [];
    const stmt = this.db.prepare(
      `SELECT id, message_type, sdk_message, timestamp FROM sdk_messages
			 WHERE session_id = ?
			   AND parent_tool_use_id IS NULL
			   AND is_renderable = 1
			   AND message_type IN ('user', 'assistant')
			   AND NOT EXISTS (
			     SELECT 1
			     FROM sdk_message_replacements replacement
			     WHERE replacement.session_id = sdk_messages.session_id
			       AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
			   )
			   AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
			 ORDER BY timestamp DESC, rowid DESC
			 LIMIT ? OFFSET ?`
    );
    const maxScan = Math.max(limit, RENDERABLE_TEXT_MESSAGE_MAX_SCAN);
    let scanned = 0;

    while (messages.length < limit && scanned < maxScan) {
      const batchSize = Math.min(RENDERABLE_TEXT_MESSAGE_BATCH_SIZE, maxScan - scanned);
      const rows = stmt.all(sessionId, batchSize, scanned) as Array<{
        id: string;
        message_type: string;
        sdk_message: string;
        timestamp: string;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        let message: SDKMessage;
        try {
          message = JSON.parse(row.sdk_message) as SDKMessage;
        } catch {
          continue;
        }
        const text = this.extractVisibleText(message as unknown as Record<string, unknown>);
        if (text.length === 0) continue;
        messages.push({
          id: row.id,
          type: row.message_type,
          text,
          timestamp: new Date(row.timestamp).getTime(),
        });
        if (messages.length >= limit) break;
      }
      scanned += rows.length;
      if (rows.length < batchSize) break;
    }

    return messages.reverse();
  }

  private _getSDKMessagesImpl(
    sessionId: string,
    limit: number,
    before?: number,
    since?: number,
    beforeRowid?: number,
    sinceRowid?: number
  ): {
    messages: Array<
      ChatMessage & {
        timestamp: number;
        origin?: MessageOrigin;
        deliveryStatus?: MessageDeliveryStatus;
      }
    >;
    hasMore: boolean;
  } {
    let query = `SELECT id, sdk_message, timestamp, send_status, origin, rowid FROM sdk_messages
      WHERE session_id = ?
        AND parent_tool_use_id IS NULL
        AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
        AND (
          message_type != 'system'
          OR COALESCE(message_subtype, '') != 'informational'
          OR NOT json_valid(sdk_message)
          OR COALESCE(
            CASE
              WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.level')
            END,
            ''
          ) != 'info'
        )
        AND (
          message_type != 'system'
          OR COALESCE(message_subtype, '') != 'worker_shutting_down'
          OR NOT EXISTS (
            SELECT 1
            FROM sdk_messages newer
            WHERE newer.session_id = sdk_messages.session_id
              AND newer.parent_tool_use_id IS NULL
              AND (
                newer.timestamp > sdk_messages.timestamp
                OR (newer.timestamp = sdk_messages.timestamp AND newer.id > sdk_messages.id)
              )
              AND (newer.message_type != 'user' OR COALESCE(newer.send_status, 'consumed') IN ('consumed', 'failed'))
          )
        )`;
    const params: SQLiteValue[] = [sessionId];

    if (before !== undefined && before > 0) {
      const beforeIso = new Date(before).toISOString();
      if (beforeRowid !== undefined && beforeRowid > 0) {
        query += ` AND (timestamp < ? OR (timestamp = ? AND rowid < ?))`;
        params.push(beforeIso, beforeIso, beforeRowid);
      } else {
        query += ` AND timestamp <= ?`;
        params.push(beforeIso);
      }
    }

    if (since !== undefined && since > 0) {
      const sinceIso = new Date(since).toISOString();
      if (sinceRowid !== undefined && sinceRowid > 0) {
        query += ` AND (timestamp > ? OR (timestamp = ? AND rowid > ?))`;
        params.push(sinceIso, sinceIso, sinceRowid);
      } else {
        query += ` AND timestamp >= ?`;
        params.push(sinceIso);
      }
    }

    query += ` ORDER BY timestamp DESC, rowid DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    const messages: Array<SDKMessage & { timestamp: number }> = [];
    for (const r of rows) {
      let sdkMessage: SDKMessage;
      try {
        sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
      } catch {
        sdkMessage = { type: 'unknown', rawContent: r.sdk_message } as unknown as SDKMessage;
      }
      const timestamp = new Date(r.timestamp as string).getTime();
      const extra: Record<string, unknown> = {
        id: r.id,
        timestamp,
        rowid: typeof r.rowid === 'number' ? r.rowid : Number(r.rowid ?? 0),
        origin: r.origin != null ? (r.origin as MessageOrigin) : undefined,
      };
      if (sdkMessage.type === 'user') {
        const deliveryStatus = sendStatusToDeliveryStatus(
          r.send_status as string | null | undefined
        );
        if (deliveryStatus) extra.deliveryStatus = deliveryStatus;
      }
      messages.push({ ...sdkMessage, ...extra } as SDKMessage & { timestamp: number });
      if (messages.length >= limit) break;
    }

    const topLevelMessages = messages.reverse();

    const hasMore = topLevelMessages.length === limit;

    const toolUseIds = new Set<string>();
    topLevelMessages.forEach((msg) => {
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        msg.message.content.forEach((block: unknown) => {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === 'tool_use' && blockObj.id) {
            toolUseIds.add(blockObj.id as string);
          }
        });
      }
    });

    let subagentMessages: Array<SDKMessage & { timestamp: number }> = [];
    if (toolUseIds.size > 0) {
      const placeholders = Array.from(toolUseIds)
        .map(() => '?')
        .join(',');
      const subagentQuery = `SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IN (${placeholders})
         AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        ORDER BY timestamp ASC, rowid ASC`;
      const subagentParams: SQLiteValue[] = [sessionId, ...Array.from(toolUseIds)];

      const subagentStmt = this.db.prepare(subagentQuery);
      const subagentRows = subagentStmt.all(...subagentParams) as Record<string, unknown>[];

      subagentMessages = subagentRows.flatMap((r) => {
        let sdkMessage: SDKMessage;
        try {
          sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
        } catch {
          sdkMessage = { type: 'unknown', rawContent: r.sdk_message } as unknown as SDKMessage;
        }
        const timestamp = new Date(r.timestamp as string).getTime();
        return [
          {
            ...sdkMessage,
            id: r.id,
            timestamp,
            origin: undefined,
          } as unknown as SDKMessage & {
            timestamp: number;
          },
        ];
      });
    }

    return {
      messages: [...topLevelMessages, ...subagentMessages] as Array<
        SDKMessage & {
          timestamp: number;
          origin?: MessageOrigin;
          deliveryStatus?: MessageDeliveryStatus;
        }
      >,
      hasMore,
    };
  }

  getBackgroundTaskMessages(sessionId: string): Array<ChatMessage & { timestamp: number }> {
    const rows = this.db
      .prepare(
        `WITH recent_metadata AS (
           SELECT
             id,
             sdk_message,
             timestamp,
             origin,
             rowid,
             COALESCE(
               CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
               task_id
             ) AS task_id
           FROM sdk_messages
           WHERE session_id = ?
             AND parent_tool_use_id IS NULL
             AND COALESCE(message_subtype, '') IN (${BACKGROUND_TASK_METADATA_SQL_LIST})
           ORDER BY timestamp DESC, rowid DESC
           LIMIT ?
         ),
         recent_task_ids AS (
           SELECT DISTINCT task_id
           FROM recent_metadata
           WHERE task_id IS NOT NULL AND task_id != ''
         ),
         task_starts AS (
           SELECT
             id,
             sdk_message,
             timestamp,
             origin,
             rowid,
             COALESCE(
               CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
               task_id
             ) AS task_id
           FROM sdk_messages
           WHERE session_id = ?
             AND parent_tool_use_id IS NULL
             AND COALESCE(message_subtype, '') = 'task_started'
             AND COALESCE(
               CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
               task_id
             ) IN (SELECT task_id FROM recent_task_ids)
             AND id NOT IN (SELECT id FROM recent_metadata)
         ),
         latest_progress AS (
           SELECT
             id,
             sdk_message,
             timestamp,
             origin,
             rowid,
             task_id
           FROM (
             SELECT
               id,
               sdk_message,
               timestamp,
               origin,
               rowid,
               COALESCE(
                 CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.task_id') END,
                 task_id
               ) AS task_id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(
                   CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.tool_use_id') END,
                   ''
                 )
                 ORDER BY timestamp DESC, rowid DESC
               ) AS rn
             FROM sdk_messages
             WHERE session_id = ?
               AND parent_tool_use_id IS NULL
               AND COALESCE(message_subtype, '') = 'task_progress'
               AND COALESCE(
                 CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.tool_use_id') END,
                 ''
               ) != ''
           )
           WHERE rn = 1
         )
         SELECT id, sdk_message, timestamp, origin
         FROM (
           SELECT * FROM recent_metadata
           UNION ALL
           SELECT * FROM task_starts
           UNION ALL
           SELECT * FROM latest_progress
         )
         ORDER BY timestamp DESC, rowid DESC`
      )
      .all(sessionId, BACKGROUND_TASK_METADATA_BATCH_SIZE, sessionId, sessionId) as Array<{
      id: string;
      sdk_message: string;
      timestamp: string;
      origin: MessageOrigin | null;
    }>;

    return rows
      .map((row) => {
        let sdkMessage: SDKMessage;
        try {
          sdkMessage = JSON.parse(row.sdk_message) as SDKMessage;
        } catch {
          sdkMessage = { type: 'unknown', rawContent: row.sdk_message } as unknown as SDKMessage;
        }
        return {
          ...sdkMessage,
          id: row.id,
          timestamp: new Date(row.timestamp).getTime(),
          origin: row.origin ?? undefined,
        } as unknown as ChatMessage & { timestamp: number };
      })
      .reverse();
  }

  getSDKMessagesByType(
    sessionId: string,
    messageType: string,
    messageSubtype?: string,
    limit = 100
  ): SDKMessage[] {
    let query = `SELECT sdk_message FROM sdk_messages WHERE session_id = ? AND message_type = ?`;
    const params: SQLiteValue[] = [sessionId, messageType];

    if (messageSubtype) {
      query += ` AND message_subtype = ?`;
      params.push(messageSubtype);
    }

    query += ` ORDER BY timestamp ASC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage);
  }

  getLastSDKMessage(sessionId: string): (SDKMessage & { dbId: string; timestamp: number }) | null {
    const stmt = this.db.prepare(
      `SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
		       AND parent_tool_use_id IS NULL
		       AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_LAST_MESSAGE_SQL_LIST})
		       AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT 1`
    );
    const row = stmt.get(sessionId) as {
      id: string;
      sdk_message: string;
      timestamp: string;
    } | null;
    return row ? this.inflatePersistedMessage(row) : null;
  }

  getSDKMessageCount(sessionId: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IS NULL
         AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') = 'consumed')`
    );
    const result = stmt.get(sessionId) as { count: number };
    return result.count;
  }

  private visibleMessageCountReady: boolean | null = null;

  private supportsVisibleMessageCount(): boolean {
    if (this.visibleMessageCountReady === null) {
      this.visibleMessageCountReady =
        this.tableExists('sessions') && this.tableHasColumn('sessions', 'visible_message_count');
    }
    return this.visibleMessageCountReady;
  }

  private bumpVisibleMessageCount(sessionId: string, delta: number): void {
    if (delta === 0 || !this.supportsVisibleMessageCount()) return;
    this.db
      .prepare(`UPDATE sessions SET visible_message_count = visible_message_count + ? WHERE id = ?`)
      .run(delta, sessionId);
  }

  recomputeVisibleMessageCount(sessionId: string): boolean {
    if (!this.supportsVisibleMessageCount()) return false;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sdk_messages
          WHERE session_id = ?
            AND parent_tool_use_id IS NULL
            AND (message_type != 'user'
                 OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
            AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})`
      )
      .get(sessionId) as { n: number } | undefined;
    const count = row?.n ?? 0;
    const result = this.db
      .prepare(
        `UPDATE sessions SET visible_message_count = ? WHERE id = ? AND visible_message_count != ?`
      )
      .run(count, sessionId, count);
    return result.changes > 0;
  }

  private notifySessionsChanged(sessionId: string): void {
    this.reactiveDb?.notifyChange('sessions', { sessionId });
  }

  saveUserMessage(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): string {
    const core = this.db.transaction(() =>
      this.saveUserMessageCore(sessionId, message, sendStatus, origin)
    )();
    this.runPostSaveSideEffects(sessionId, core.id, core.countsTowardsBadge);
    return core.id;
  }

  saveUserMessageCore(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): { id: string; countsTowardsBadge: boolean } {
    const id = generateUUID();
    const messageType = message.type;
    const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
    const timestamp = new Date().toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);
    const isRenderable = computeIsRenderable(message);
    const isTerminal = computeIsTerminal(message);
    const isConversationAnchor =
      isRenderable === 1 &&
      messageType === 'user' &&
      (sendStatus === 'consumed' || sendStatus === 'failed');
    const parentToolUseId = extractParentToolUseId(message);
    const countsTowardsBadge = isVisibleBadgeRow({
      parentToolUseId,
      messageType,
      messageSubtype,
      sendStatus,
    });

    const stmt = this.db.prepare(
      `INSERT INTO sdk_messages (
				id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin,
				is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
				sdk_uuid, replacement_metadata_normalized
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );

    const conversationTurnIndex = this.resolveConversationTurnIndex(
      taskId,
      sessionId,
      isConversationAnchor
    );
    const values = [
      id,
      sessionId,
      messageType,
      messageSubtype,
      JSON.stringify(message),
      timestamp,
      sendStatus,
      origin ?? null,
      isRenderable,
      isTerminal,
      parentToolUseId,
      taskId,
    ];
    stmt.run(...values, conversationTurnIndex, extractSdkUuid(message));
    this.saveReplacementEdges(id, sessionId, taskId, message);
    this.scheduleMessageSearchIndex(id);
    if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
    return { id, countsTowardsBadge };
  }

  runPostSaveSideEffects(sessionId: string, id: string, countsTowardsBadge: boolean): void {
    this.reactiveDb?.notifyChange('sdk_messages', { sessionId });
    if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
  }

  getMessagesByStatus(
    sessionId: string,
    status: SendStatus
  ): Array<SDKMessage & { dbId: string; timestamp: number }> {
    const stmt = this.db.prepare(
      `SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND send_status = ?
       ORDER BY timestamp ASC, rowid ASC`
    );
    const rows = stmt.all(sessionId, status) as Array<{
      id: string;
      sdk_message: string;
      timestamp: string;
    }>;

    return rows.map((row) => this.inflatePersistedMessage(row));
  }

  getUserMessagesByStatus(
    sessionId: string,
    status: SendStatus,
    limit: number
  ): {
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
    total: number;
  } {
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}`
      )
      .get(sessionId, status) as { count: number };
    const projected = this.db
      .prepare(
        `SELECT rowid AS row_id FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}
         ORDER BY timestamp ASC, rowid ASC
         LIMIT ?`
      )
      .all(sessionId, status, limit) as Array<{ row_id: number }>;
    const messagesByRowId = new Map<number, SDKUserMessage & { dbId: string; timestamp: number }>();

    for (let offset = 0; offset < projected.length; offset += STATUS_MESSAGE_HYDRATION_BATCH_SIZE) {
      const batch = projected.slice(offset, offset + STATUS_MESSAGE_HYDRATION_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT rowid AS row_id, id, sdk_message, timestamp FROM sdk_messages
           WHERE rowid IN (${placeholders})`
        )
        .all(...batch.map((row) => row.row_id)) as Array<{
        row_id: number;
        id: string;
        sdk_message: string;
        timestamp: string;
      }>;
      for (const row of rows) {
        messagesByRowId.set(
          row.row_id,
          this.inflatePersistedMessage(row) as SDKUserMessage & {
            dbId: string;
            timestamp: number;
          }
        );
      }
    }

    return {
      messages: projected.flatMap((row) => {
        const message = messagesByRowId.get(row.row_id);
        return message ? [message] : [];
      }),
      total: countRow.count,
    };
  }

  getMessageByStatusAndUuid(
    sessionId: string,
    status: SendStatus,
    uuid: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    const stmt = this.db.prepare(
      `SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
	         AND send_status = ?
	         AND sdk_uuid = ?
	       LIMIT 1`
    );
    const row = stmt.get(sessionId, status, uuid) as {
      id: string;
      sdk_message: string;
      timestamp: string;
    } | null;
    return row ? this.inflatePersistedMessage(row) : null;
  }

  private inflatePersistedMessage(row: {
    id: string;
    sdk_message: string;
    timestamp: string;
  }): SDKMessage & { dbId: string; timestamp: number } {
    let message: SDKMessage;
    try {
      message = JSON.parse(row.sdk_message) as SDKMessage;
    } catch {
      message = { type: 'unknown', rawContent: row.sdk_message } as unknown as SDKMessage;
    }
    return {
      ...message,
      dbId: row.id,
      timestamp: new Date(row.timestamp).getTime(),
    } as SDKMessage & { dbId: string; timestamp: number };
  }

  updateMessageStatus(
    messageIds: string[],
    newStatus: SendStatus,
    options?: { sharedTurn?: boolean; consumedSeq?: number }
  ): void {
    if (messageIds.length === 0) return;

    const placeholders = messageIds.map(() => '?').join(',');
    const pending =
      newStatus === 'consumed' || newStatus === 'failed'
        ? (this.db
            .prepare(
              `SELECT id, task_id, is_renderable FROM sdk_messages
                WHERE id IN (${placeholders})
                  AND message_type = 'user'
                  AND send_status IN ('deferred', 'enqueued', 'submitted')
                ORDER BY rowid ASC`
            )
            .all(...messageIds) as Array<{
            id: string;
            task_id: string | null;
            is_renderable: number;
          }>)
        : [];
    const affectedSessions = this.supportsVisibleMessageCount()
      ? (this.db
          .prepare(
            `SELECT DISTINCT session_id AS sid FROM sdk_messages WHERE id IN (${placeholders})`
          )
          .all(...messageIds) as Array<{ sid: string }>)
      : [];
    const stmt = this.db.prepare(
      `UPDATE sdk_messages SET send_status = ? WHERE id IN (${placeholders})`
    );
    const changedSessions: string[] = [];
    this.db.transaction(() => {
      stmt.run(newStatus, ...messageIds);

      if (pending.length > 0) {
        const now = new Date().toISOString();
        const maxStmt = this.db.prepare(
          'SELECT MAX(conversation_turn_index) AS m FROM sdk_messages WHERE task_id = ?'
        );
        const sharedBases = options?.sharedTurn ? new Map<string, number>() : null;
        if (sharedBases) {
          for (const row of pending) {
            if (row.task_id && row.is_renderable === 1 && !sharedBases.has(row.task_id)) {
              sharedBases.set(
                row.task_id,
                (maxStmt.get(row.task_id) as { m: number | null } | undefined)?.m ?? 0
              );
            }
          }
        }
        const updStmt = this.db.prepare(
          'UPDATE sdk_messages SET conversation_turn_index = ?, timestamp = ? WHERE id = ?'
        );
        const timeStmt = this.db.prepare('UPDATE sdk_messages SET timestamp = ? WHERE id = ?');
        const consumedSeqStmt = this.db.prepare(
          'UPDATE sdk_messages SET consumed_seq = ?, timestamp = ? WHERE id = ?'
        );
        for (const row of pending) {
          if (row.task_id && row.is_renderable === 1) {
            const turn = sharedBases
              ? (sharedBases.get(row.task_id) ?? 0) + 1
              : ((maxStmt.get(row.task_id) as { m: number | null } | undefined)?.m ?? 0) + 1;
            updStmt.run(turn, now, row.id);
          } else {
            timeStmt.run(now, row.id);
          }
          if (newStatus === 'consumed') {
            consumedSeqStmt.run(options?.consumedSeq ?? this.nextConsumedSeq(), now, row.id);
          }
        }
      }

      for (const { sid } of affectedSessions) {
        if (this.recomputeVisibleMessageCount(sid)) changedSessions.push(sid);
      }
    })();
    for (const sid of changedSessions) this.notifySessionsChanged(sid);
    for (const messageId of messageIds) this.scheduleMessageSearchIndex(messageId);
  }

  updateMessageTimestamp(messageId: string, timestampMs?: number): void {
    const stmt = this.db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE id = ?`);
    const ts = timestampMs !== undefined ? new Date(timestampMs) : new Date();
    stmt.run(ts.toISOString(), messageId);
    this.scheduleMessageSearchIndex(messageId);
  }

  deletePendingUserMessage(
    sessionId: string,
    messageId: string,
    expectedStatus?: 'deferred' | 'enqueued'
  ): { dbId: string; uuid: string; status: 'deferred' | 'enqueued' } | null {
    const row = this.db
      .prepare(
        `SELECT id, sdk_message, send_status
				   FROM sdk_messages
				  WHERE session_id = ?
				    AND id = ?
				    AND message_type = 'user'
				    AND send_status IN ('deferred', 'enqueued')
            AND (? IS NULL OR send_status = ?)
				  LIMIT 1`
      )
      .get(sessionId, messageId, expectedStatus ?? null, expectedStatus ?? null) as
      | { id: string; sdk_message: string; send_status: 'deferred' | 'enqueued' }
      | undefined;

    if (!row) {
      return null;
    }

    const message = JSON.parse(row.sdk_message) as { uuid?: string };
    const deleteStmt = this.db.prepare(
      `DELETE FROM sdk_messages
				  WHERE session_id = ?
				    AND id = ?
				    AND message_type = 'user'
				    AND send_status IN ('deferred', 'enqueued')
            AND (? IS NULL OR send_status = ?)`
    );
    let deleted = false;
    this.db.transaction(() => {
      deleted =
        deleteStmt.run(sessionId, messageId, expectedStatus ?? null, expectedStatus ?? null)
          .changes > 0;
      if (deleted) this.recomputeVisibleMessageCount(sessionId);
    })();

    if (!deleted) {
      return null;
    }

    this.deleteMessageSearchRow(row.id);
    return {
      dbId: row.id,
      uuid: message.uuid ?? '',
      status: row.send_status,
    };
  }

  deferEnqueuedUserMessage(
    sessionId: string,
    messageId: string
  ): { dbId: string; uuid: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, sdk_message FROM sdk_messages
          WHERE session_id = ? AND id = ? AND message_type = 'user'
            AND send_status = 'enqueued' LIMIT 1`
      )
      .get(sessionId, messageId) as { id: string; sdk_message: string } | undefined;
    if (!row) return null;
    const changed = this.db
      .prepare(
        `UPDATE sdk_messages SET send_status = 'deferred'
          WHERE session_id = ? AND id = ? AND message_type = 'user'
            AND send_status = 'enqueued'`
      )
      .run(sessionId, messageId).changes;
    if (changed === 0) return null;
    const message = JSON.parse(row.sdk_message) as { uuid?: string };
    return { dbId: row.id, uuid: message.uuid ?? '' };
  }

  getMessageCountByStatus(sessionId: string, status: SendStatus): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND send_status = ?`
    );
    const result = stmt.get(sessionId, status) as { count: number };
    return result.count;
  }

  deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
    const isoTimestamp = new Date(afterTimestamp).toISOString();
    const rows = this.db
      .prepare(`SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp > ?`)
      .all(sessionId, isoTimestamp) as Array<{ id: string; sdk_uuid: string | null }>;
    const stmt = this.db.prepare(`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp > ?`);
    let deleted = 0;
    let badgeChanged = false;
    this.db.transaction(() => {
      deleted = stmt.run(sessionId, isoTimestamp).changes;
      badgeChanged = this.recomputeVisibleMessageCount(sessionId);
      for (const { sdk_uuid } of rows) {
        if (sdk_uuid) this.clearDeliveryTurnEnd(sessionId, sdk_uuid);
      }
    })();
    if (badgeChanged) this.notifySessionsChanged(sessionId);
    for (const row of rows) this.deleteMessageSearchRow(row.id);
    return deleted;
  }

  deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
    const isoTimestamp = new Date(atTimestamp).toISOString();
    const rows = this.db
      .prepare(`SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`)
      .all(sessionId, isoTimestamp) as Array<{ id: string; sdk_uuid: string | null }>;
    const stmt = this.db.prepare(
      `DELETE FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`
    );
    let deleted = 0;
    let badgeChanged = false;
    this.db.transaction(() => {
      deleted = stmt.run(sessionId, isoTimestamp).changes;
      badgeChanged = this.recomputeVisibleMessageCount(sessionId);
      for (const { sdk_uuid } of rows) {
        if (sdk_uuid) this.clearDeliveryTurnEnd(sessionId, sdk_uuid);
      }
    })();
    if (badgeChanged) this.notifySessionsChanged(sessionId);
    for (const row of rows) this.deleteMessageSearchRow(row.id);
    return deleted;
  }

  getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
    const stmt = this.db.prepare(
      `SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user'
       ORDER BY timestamp ASC`
    );
    const rows = stmt.all(sessionId) as Array<{ sdk_message: string; timestamp: string }>;

    return rows.map((row) => {
      const message = JSON.parse(row.sdk_message) as SDKMessage;
      const timestamp = new Date(row.timestamp).getTime();

      let content = '';
      const userMessage = message as {
        message?: { content?: string | Array<{ type: string; text?: string }> };
        uuid?: string;
      };
      if (userMessage.message?.content) {
        if (typeof userMessage.message.content === 'string') {
          content = userMessage.message.content;
        } else if (Array.isArray(userMessage.message.content)) {
          const textBlock = userMessage.message.content.find(
            (block): block is { type: 'text'; text: string } => block.type === 'text'
          );
          content = textBlock?.text || '';
        }
      }

      return {
        uuid: userMessage.uuid || '',
        timestamp,
        content,
      };
    });
  }

  getUserMessageByUuid(
    sessionId: string,
    uuid: string
  ): { uuid: string; timestamp: number; content: string } | undefined {
    const rows = this.db
      .prepare(
        `SELECT sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'user'
           AND sdk_uuid = ?`
      )
      .all(sessionId, uuid) as Array<{ sdk_message: string; timestamp: string }>;
    if (rows.length === 0) return undefined;

    let earliest = rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].timestamp < earliest.timestamp) earliest = rows[i];
    }
    return this.parseUserMessageRow(earliest, uuid);
  }

  getUserMessageContentByUuid(sessionId: string, uuid: string): string | MessageContent[] | null {
    const row = this.db
      .prepare(
        `SELECT sdk_message FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { sdk_message: string } | undefined;
    if (!row) return null;
    try {
      const message = JSON.parse(row.sdk_message) as {
        message?: { content?: string | MessageContent[] };
      };
      return message.message?.content ?? null;
    } catch {
      return null;
    }
  }

  getDeliveryContent(
    sessionId: string,
    uuid: string
  ): { content: string | MessageContent[]; sendStatus: SendStatus } | null {
    const row = this.db
      .prepare(
        `SELECT sdk_message, COALESCE(send_status, 'consumed') AS send_status
           FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
          ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { sdk_message: string; send_status: SendStatus } | undefined;
    if (!row) return null;
    try {
      const message = JSON.parse(row.sdk_message) as {
        message?: { content?: string | MessageContent[] };
      };
      const content = message.message?.content ?? null;
      if (content === null) return null;
      return { content, sendStatus: row.send_status };
    } catch {
      return null;
    }
  }

  hasTerminalResultAfter(sessionId: string, uuid: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM sdk_messages r
          WHERE r.session_id = ?
            AND r.message_type = 'result'
            AND r.is_terminal = 1
            AND r.message_subtype = 'success'
            AND r.parent_tool_use_id IS NULL
            AND r.consumed_seq IS NOT NULL
            AND r.consumed_seq >= (
              SELECT m.consumed_seq FROM sdk_messages m
               WHERE m.session_id = ? AND m.sdk_uuid = ? LIMIT 1
            )
          LIMIT 1`
      )
      .get(sessionId, sessionId, uuid) as { 1: number } | undefined | null;
    return row != null;
  }

  getErrorTerminalResultSubtypeAfter(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.message_subtype AS subtype
           FROM sdk_messages r
          WHERE r.session_id = ?
            AND r.message_type = 'result'
            AND r.is_terminal = 1
            AND r.message_subtype IS NOT NULL
            AND r.message_subtype != 'success'
            AND r.parent_tool_use_id IS NULL
            AND r.consumed_seq IS NOT NULL
            AND r.consumed_seq >= (
              SELECT m.consumed_seq FROM sdk_messages m
               WHERE m.session_id = ? AND m.sdk_uuid = ? LIMIT 1
            )
          ORDER BY r.consumed_seq DESC
          LIMIT 1`
      )
      .get(sessionId, sessionId, uuid) as { subtype: string | null } | undefined | null;
    return row?.subtype ?? null;
  }

  private nextConsumedSeq(): number | null {
    if (!this.tableExists('delivery_consumed_seq')) return null;
    return (
      (
        this.db
          .prepare(
            `UPDATE delivery_consumed_seq SET next_seq = next_seq + 1 WHERE singleton = 1
           RETURNING next_seq`
          )
          .get() as { next_seq: number } | undefined
      )?.next_seq ?? null
    );
  }

  recordDeliveryTurnEnd(sessionId: string, messageUuid: string, endedAt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO delivery_turn_end (session_id, message_uuid, ended_at)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, messageUuid, endedAt);
  }

  hasDeliveryTurnEnd(sessionId: string, messageUuid: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM delivery_turn_end WHERE session_id = ? AND message_uuid = ? LIMIT 1`)
      .get(sessionId, messageUuid) as { 1: number } | undefined | null;
    return row != null;
  }

  clearDeliveryTurnEnd(sessionId: string, messageUuid: string): void {
    if (!this.tableExists('delivery_turn_end')) return;
    this.db
      .prepare(`DELETE FROM delivery_turn_end WHERE session_id = ? AND message_uuid = ?`)
      .run(sessionId, messageUuid);
  }

  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status IN ('enqueued', 'deferred', 'submitted')
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'failed');
    return row.id;
  }

  markDeliveryFailedByUuidInclusive(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status IN ('enqueued', 'submitted', 'consumed')
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'failed');
    return row.id;
  }

  markDeliveryConsumedByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status IN ('enqueued', 'submitted')
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'consumed');
    return row.id;
  }

  markDeliveryConsumedAtTurnEnd(
    sessionId: string,
    uuid: string,
    resultUuid: string
  ): string | null {
    return this.markDeliveriesConsumedAtTurnEnd(sessionId, [uuid], resultUuid).ids[0] ?? null;
  }

  markDeliveriesConsumedAtTurnEnd(
    sessionId: string,
    uuids: string[],
    resultUuid: string
  ): { ids: string[]; uuids: string[] } {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `SELECT consumed_seq FROM sdk_messages
             WHERE session_id = ? AND message_type = 'result' AND sdk_uuid = ?
               AND message_subtype = 'success' AND is_terminal = 1
               AND parent_tool_use_id IS NULL AND consumed_seq IS NOT NULL
             LIMIT 1`
        )
        .get(sessionId, resultUuid) as { consumed_seq: number } | undefined;
      if (!result) return { ids: [], uuids: [] };
      const ids: string[] = [];
      const consumedUuids: string[] = [];
      for (const [index, uuid] of [...new Set(uuids)].entries()) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status IN ('enqueued', 'submitted')
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid) as { id: string } | undefined;
        if (index === 0 && !row) return { ids: [], uuids: [] };
        if (row) {
          ids.push(row.id);
          consumedUuids.push(uuid);
        }
      }
      this.updateMessageStatus(ids, 'consumed', {
        sharedTurn: true,
        consumedSeq: result.consumed_seq,
      });
      return { ids, uuids: consumedUuids };
    })();
  }

  markDeliveryConsumedByUuids(sessionId: string, uuids: string[]): string[] {
    return this.db.transaction(() => {
      const ids: string[] = [];
      for (const uuid of new Set(uuids)) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status IN ('enqueued', 'submitted')
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid) as { id: string } | undefined;
        if (row) ids.push(row.id);
      }
      this.updateMessageStatus(ids, 'consumed', { sharedTurn: true });
      return ids;
    })();
  }

  markDeliverySubmittedByUuids(sessionId: string, uuids: string[]): string[] {
    return this.db.transaction(() => {
      const ids: string[] = [];
      for (const uuid of new Set(uuids)) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status = 'enqueued'
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid) as { id: string } | undefined;
        if (!row) continue;
        this.updateMessageStatus([row.id], 'submitted');
        ids.push(row.id);
      }
      return ids;
    })();
  }

  reopenDeliveryByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status = 'failed'
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'enqueued');
    return row.id;
  }

  markDeliveryRetryableByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status = 'consumed'
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'enqueued');
    return row.id;
  }

  markDeliveryDeferredByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status = 'enqueued'
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], 'deferred');
    return row.id;
  }

  private parseUserMessageRow(
    row: { sdk_message: string; timestamp: string },
    uuid: string
  ): { uuid: string; timestamp: number; content: string } {
    const message = JSON.parse(row.sdk_message) as SDKMessage;
    const timestamp = new Date(row.timestamp).getTime();

    let content = '';
    const userMessage = message as {
      message?: { content?: string | Array<{ type: string; text?: string }> };
      uuid?: string;
    };
    if (userMessage.message?.content) {
      if (typeof userMessage.message.content === 'string') {
        content = userMessage.message.content;
      } else if (Array.isArray(userMessage.message.content)) {
        const textBlock = userMessage.message.content.find(
          (block): block is { type: 'text'; text: string } => block.type === 'text'
        );
        content = textBlock?.text || '';
      }
    }

    return { uuid, timestamp, content };
  }

  getAssistantMessagesSince(
    sessionId: string,
    afterMessageId: string | null
  ): Array<{ id: string; text: string; toolCallNames: string[] }> {
    let query: string;
    let params: Array<string>;

    if (afterMessageId) {
      query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ?
				  AND message_type = 'assistant'
				  AND timestamp > (
				      SELECT timestamp FROM sdk_messages WHERE id = ?
				  )
				ORDER BY timestamp ASC
			`;
      params = [sessionId, afterMessageId];
    } else {
      query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ? AND message_type = 'assistant'
				ORDER BY timestamp ASC
			`;
      params = [sessionId];
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{ id: string; sdk_message: string }>;

    return rows.map((row) => {
      const msg = JSON.parse(row.sdk_message) as Record<string, unknown>;
      const text = this.extractAssistantText(msg);
      const toolCallNames = this.extractToolCallNames(msg);
      return { id: row.id, text, toolCallNames };
    });
  }

  private extractAssistantText(msg: Record<string, unknown>): string {
    return this.extractVisibleText(msg);
  }

  private extractVisibleText(msg: Record<string, unknown>): string {
    const parts: string[] = [];
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    } else if (typeof content === 'string') {
      parts.push(content);
    }
    if (msg.type === 'result' && typeof msg.result === 'string') {
      parts.push(msg.result);
    }
    return parts.join('\n\n').trim();
  }

  private extractToolCallNames(msg: Record<string, unknown>): string[] {
    const names: string[] = [];
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          names.push(block.name);
        }
      }
    }
    return names;
  }

  countMessagesAfter(sessionId: string, afterTimestamp: number): number {
    const isoTimestamp = new Date(afterTimestamp).toISOString();
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND timestamp > ?`
    );
    const result = stmt.get(sessionId, isoTimestamp) as { count: number };
    return result.count;
  }

  saveHyperNeoActionMessage(sessionId: string, message: HyperNeoActionMessage): string {
    const id = generateUUID();
    const timestamp = new Date(message.timestamp).toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);
    const conversationTurnIndex = this.resolveConversationTurnIndex(taskId, sessionId, false);
    const countsTowardsBadge = isVisibleBadgeRow({
      parentToolUseId: null,
      messageType: 'hyperneo_action',
      messageSubtype: message.action,
      sendStatus: null,
    });

    const values = [
      id,
      sessionId,
      'hyperneo_action',
      message.action,
      JSON.stringify(message),
      timestamp,
      taskId,
    ];

    const insertStmt = this.db.prepare(
      `INSERT INTO sdk_messages (
           id, session_id, message_type, message_subtype, sdk_message, timestamp, task_id,
           conversation_turn_index, sdk_uuid, replacement_metadata_normalized
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );

    this.db.transaction(() => {
      insertStmt.run(...values, conversationTurnIndex, message.uuid);
      if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
    })();
    if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
    this.scheduleMessageSearchIndex(id);
    return id;
  }

  hasUnresolvedHyperNeoAction(sessionId: string, action: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM sdk_messages
           WHERE session_id = ?
             AND message_type = 'hyperneo_action'
             AND message_subtype = ?
             AND json_extract(sdk_message, '$.resolved') = 0
           LIMIT 1`
      )
      .get(sessionId, action);
    return row !== null && row !== undefined;
  }

  updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): void {
    const stmt = this.db.prepare(
      `UPDATE sdk_messages SET sdk_message = ? WHERE id = ? AND message_type = 'hyperneo_action'`
    );
    stmt.run(JSON.stringify(updated), rowId);
    this.scheduleMessageSearchIndex(rowId);
  }

  updateHyperNeoActionMessageByUuid(
    sessionId: string,
    messageUuid: string,
    updated: HyperNeoActionMessage
  ): void {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
       WHERE session_id = ?
         AND message_type = 'hyperneo_action'
         AND sdk_uuid = ?`
      )
      .get(sessionId, messageUuid) as { id: string } | undefined;
    const stmt = this.db.prepare(
      `UPDATE sdk_messages SET sdk_message = ?
       WHERE session_id = ?
         AND message_type = 'hyperneo_action'
         AND sdk_uuid = ?`
    );
    stmt.run(JSON.stringify(updated), sessionId, messageUuid);
    if (row) this.scheduleMessageSearchIndex(row.id);
  }

  searchMessages(params: MessageSearchParams): MessageSearchResponse {
    if (!this.hasMessageSearchIndex()) {
      return { results: [], limit: params.limit ?? 25, offset: params.offset ?? 0 };
    }

    const ftsQuery = buildFtsQuery(params.query);
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 50);
    const offset = Math.max(params.offset ?? 0, 0);
    if (!ftsQuery) return { results: [], limit, offset };

    const broadQuery = isBroadMessageSearchQuery(params.query);
    const hasSessions = this.tableExists('sessions');
    const hasSpaceTasks = this.tableExists('space_tasks');
    const sessionJoin = hasSessions ? 'LEFT JOIN sessions s ON s.id = msc.session_id' : '';
    const taskJoin = hasSpaceTasks ? 'LEFT JOIN space_tasks st ON st.id = msc.task_id' : '';
    const sessionPolicy = hasSessions
      ? `AND COALESCE(s.status, '') != 'archived'
				AND NOT (
					COALESCE(s.status, '') = 'ended'
					AND strftime('%s', s.last_active_at) < strftime('%s', 'now', '-30 days')
				)`
      : '';
    const taskPolicy = hasSpaceTasks
      ? `AND COALESCE(st.status, '') != 'archived'
				AND NOT (
					COALESCE(st.status, '') IN ('done', 'cancelled', 'completed')
					AND COALESCE(st.completed_at, st.updated_at, 0) < unixepoch('now', '-30 days') * 1000
				)`
      : '';
    let candidateSql = `
			SELECT
				msc.rowid,
				${broadQuery ? '0' : 'bm25(message_search_fts)'} AS rank,
				msc.timestamp,
				msc.source_id
			FROM message_search_fts
			JOIN message_search_content msc ON msc.rowid = message_search_fts.rowid
			${sessionJoin}
			${taskJoin}
			WHERE message_search_fts MATCH ?
			  AND (
				msc.kind != 'message'
				OR (
					1 = 1
					${sessionPolicy}
					${taskPolicy}
				)
			  )`;
    const values: SQLiteValue[] = [ftsQuery];

    if (params.sessionId) {
      candidateSql += ` AND msc.session_id = ?`;
      values.push(params.sessionId);
    }
    if (params.messageType) {
      candidateSql += ` AND msc.message_type = ?`;
      values.push(params.messageType);
    }
    if (params.from !== undefined) {
      candidateSql += ` AND msc.timestamp >= ?`;
      values.push(params.from);
    }
    if (params.to !== undefined) {
      candidateSql += ` AND msc.timestamp <= ?`;
      values.push(params.to);
    }

    candidateSql += broadQuery
      ? ` ORDER BY msc.timestamp DESC, msc.source_id ASC LIMIT ? OFFSET ?`
      : ` ORDER BY rank ASC, msc.timestamp DESC, msc.source_id ASC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const candidates = this.db.prepare(candidateSql).all(...values) as Array<{
      rowid: number;
      rank: number;
    }>;
    if (candidates.length === 0) return { results: [], limit, offset };

    const rankByRowId = new Map(candidates.map((row) => [row.rowid, row.rank]));
    const orderByRowId = new Map(candidates.map((row, index) => [row.rowid, index]));
    const placeholders = candidates.map(() => '?').join(', ');
    const rawRows = this.db
      .prepare(
        `
				SELECT
					msc.rowid, msc.kind, msc.source_id, msc.message_id, msc.session_id, msc.task_id,
					msc.space_id, msc.task_number, msc.message_type, msc.title,
					snippet(message_search_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
					msc.timestamp
				FROM message_search_fts
				JOIN message_search_content msc ON msc.rowid = message_search_fts.rowid
				WHERE message_search_fts.rowid IN (${placeholders})
				  AND message_search_fts MATCH ?`
      )
      .all(...candidates.map((row) => row.rowid), ftsQuery) as Array<{
      rowid: number;
      kind: 'message' | 'task';
      source_id: string;
      message_id: string | null;
      session_id: string | null;
      task_id: string | null;
      space_id: string | null;
      task_number: number | null;
      message_type: string | null;
      title: string | null;
      snippet: string | null;
      timestamp: string | null;
    }>;
    const seenRowId = new Set<number>();
    const rows = rawRows.filter((row) => {
      if (seenRowId.has(row.rowid)) return false;
      seenRowId.add(row.rowid);
      return true;
    });

    const results: MessageSearchResult[] = rows
      .sort((a, b) => (orderByRowId.get(a.rowid) ?? 0) - (orderByRowId.get(b.rowid) ?? 0))
      .map((row) => {
        const timestamp = parseSearchTimestamp(row.timestamp);
        return {
          kind: row.kind,
          sourceId: row.source_id,
          messageId: row.message_id ?? row.source_id,
          sessionId: row.session_id ?? undefined,
          taskId: row.task_id ?? undefined,
          spaceId: row.space_id ?? undefined,
          taskNumber: row.task_number ?? undefined,
          messageType: row.message_type ?? undefined,
          title: row.title ?? (row.kind === 'task' ? 'Task' : 'Session'),
          snippet: row.snippet ?? '',
          timestamp,
          loadTarget: row.session_id
            ? { sessionId: row.session_id, before: timestamp + 1 }
            : undefined,
          rank: rankByRowId.get(row.rowid) ?? 0,
        };
      });

    return { results, limit, offset };
  }
}

function parseSearchTimestamp(value: string | null): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
