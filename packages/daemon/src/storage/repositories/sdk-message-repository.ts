/**
 * SDK Message Repository
 *
 * Responsibilities:
 * - Save and retrieve SDK messages
 * - Pagination support (before/since cursors)
 * - Message query mode tracking (deferred/enqueued/consumed status)
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID, sendStatusToDeliveryStatus } from '@hyperneo/shared';
import type {
  MessageContent,
  MessageDeliveryStatus,
  MessageOrigin,
  HyperNeoActionMessage,
  ChatMessage,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
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

const LAST_MESSAGE_PROGRESS_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated']);
const BACKGROUND_TASK_METADATA_SUBTYPES = ['task_started', 'task_updated', 'task_notification'];
const BACKGROUND_TASK_METADATA_BATCH_SIZE = 300;

function toSqlStringList(subtypes: Iterable<string>): string {
  return [...subtypes].map((subtype) => `'${subtype.replace(/'/g, "''")}'`).join(', ');
}

/** Render-hidden rows excluded before applying chat pagination limits. */
const EXCLUDED_FROM_PAGINATION_SQL_LIST = toSqlStringList([
  ...HIDDEN_SYSTEM_SUBTYPES,
  'thinking_tokens',
]);

const BACKGROUND_TASK_METADATA_SQL_LIST = toSqlStringList(BACKGROUND_TASK_METADATA_SUBTYPES);

/** Last-message idle checks only drop rows that carry no progress signal. */
const EXCLUDED_FROM_LAST_MESSAGE_SQL_LIST = toSqlStringList([
  ...[...HIDDEN_SYSTEM_SUBTYPES].filter((subtype) => !LAST_MESSAGE_PROGRESS_SUBTYPES.has(subtype)),
  'thinking_tokens',
  'model_refusal_fallback',
]);

/**
 * Subtypes excluded from the space-sessions visible-message badge — the same
 * set the former `spaceSessions.bySpace` correlated COUNT(*) subquery dropped.
 * Used by {@link isVisibleBadgeRow} so the maintained
 * `sessions.visible_message_count` counter can never drift from the predicate
 * it replaces.
 */
const BADGE_HIDDEN_SUBTYPES = new Set<string>([...HIDDEN_SYSTEM_SUBTYPES, 'thinking_tokens']);

/**
 * Does a row with these persisted column values count toward the space-sessions
 * visible-message badge? Mirrors the predicate the `spaceSessions.bySpace`
 * correlated subquery evaluated inline: top-level only (no `parent_tool_use_id`),
 * non-deferred user rows (`consumed`/`failed`), and non-hidden subtypes.
 *
 * Pure function of the columns as stored, so {@link SDKMessageRepository} can
 * decide at INSERT time whether to increment the maintained counter without
 * re-querying the row.
 */
function isVisibleBadgeRow(opts: {
  parentToolUseId: string | null;
  messageType: string;
  messageSubtype: string | null;
  sendStatus: SendStatus | null;
}): boolean {
  if (opts.parentToolUseId !== null) return false;
  if (BADGE_HIDDEN_SUBTYPES.has(opts.messageSubtype ?? '')) return false;
  if (opts.messageType === 'user') {
    // NULL send_status (SDK/action rows) coalesces to 'consumed' — visible.
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

/**
 * Compute the materialised value for `sdk_messages.is_renderable` from a parsed
 * SDK message.
 *
 * Mirrors the predicate the live-query handlers used to evaluate inline:
 *   - `user` rows whose content array carries any `tool_result` block render as
 *     null in the compact UI → 0
 *   - `assistant` rows with no `tool_use`, no non-empty `text`, and no
 *     non-empty `thinking` blocks have nothing to display → 0
 *   - everything else → 1
 *
 * Keeping the logic in one helper means {@link saveSDKMessage} and
 * {@link saveUserMessage} stamp the column the same way.
 */
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

/** Compute `sdk_messages.is_terminal` — `1` for SDK result messages. */
export function computeIsTerminal(message: SDKMessage): 0 | 1 {
  return message.type === 'result' ? 1 : 0;
}

/** Extract `sdk_messages.parent_tool_use_id` from the SDK message, if any. */
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

  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  private hasMessageSearchIndex(): boolean {
    return this.tableExists('message_search_content');
  }

  private tableExists(tableName: string): boolean {
    try {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
      return !!row;
    } catch {
      return false;
    }
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name?: string;
      }>;
      return rows.some((row) => row.name === columnName);
    } catch {
      return false;
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
    if (!this.hasMessageSearchIndex()) return;
    const supersededUuids = this.getSupersededMessageUuids(message);
    if (supersededUuids.length === 0) return;

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

  /**
   * Derive `sdk_messages.task_id` from the writing session's
   * `session_context.taskId`. Both Task Agent and node-agent sessions stamp
   * this at creation, so for any Space-bound session we can recover the
   * task id directly from the `sessions` row without an extra map.
   *
   * Returns null when the session is missing, has no `session_context`, the
   * context JSON is malformed, or the context simply has no `taskId` (e.g.
   * a non-Space worker session). The column is nullable on purpose.
   *
   * Uses `json_valid` so a single malformed historical row can't throw at
   * INSERT time. Tolerates the `sessions` table being absent (e.g. unit
   * test harnesses that build a subset of the schema) by returning null.
   */
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
      // Only stamp task_id for sessions that are part of the Space task
      // system. Other session types (lobby, room-scoped, etc.) may
      // carry a taskId in context from transient operations but their
      // messages must not leak into task timelines.
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

  /**
   * Compute the `conversation_turn_index` for a new row on `taskId` (#2338).
   *
   * Turn NUMBERS are global + per-task + monotonic (so the recent-M-turn cap is
   * one clean window across every session), but turn MEMBERSHIP is per-session:
   *   - an **anchor** opens a new global turn (task-wide MAX + 1);
   *   - a non-anchor row inherits its OWN session's latest turn (MAX over
   *     `task_id`+`session_id`), so that when two task sessions interleave, a
   *     session's assistant/result rows stay grouped under that session's anchor
   *     instead of inheriting another session's turn (which would orphan them
   *     in the `(sessionId, turnIndex)` partitioning).
   *
   * NULL when the row has no task. Both MAXes are index seeks
   * (`idx_sdk_messages_task_turn` / `idx_sdk_messages_task_session_turn`).
   *
   * Rewind deletes-the-future then appends, so MAX-over-survivors is
   * self-correcting for both the task-wide and per-session seeks.
   */
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

  /**
   * Save a full SDK message to the database
   *
   * FIX: Enhanced with proper error handling and logging
   * Returns true on success, false on failure
   */
  saveSDKMessage(sessionId: string, message: SDKMessage, origin?: MessageOrigin): boolean {
    try {
      const id = generateUUID();
      const messageType = message.type;
      const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
      const timestamp = new Date().toISOString();
      const taskId = this.resolveTaskIdForSession(sessionId);
      const isRenderable = computeIsRenderable(message);
      const isTerminal = computeIsTerminal(message);
      // No send_status gate here, unlike saveUserMessage: this path only ever
      // persists SDK-streamed rows (always already consumed). Human-typed prompts
      // — which can be enqueued/deferred before consumption — go through
      // saveUserMessage, whose anchor IS send_status-gated so a queued prompt
      // can't open a turn prematurely (#2338). If a future caller routes an
      // enqueued/deferred row through saveSDKMessage, add the gate here too.
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
        // Stamp a terminal result with a monotonic operation sequence from the
        // shared counter so the delivery re-claim boundary
        // (`hasTerminalResultAfter`) can order it against a consumed message's
        // watermark independent of SQLite rowid reuse. A separate UPDATE (not in
        // the INSERT) so partial test schemas without the column don't break;
        // guarded by column presence. See Codex (PR #2463, P2).
        if (isTerminal && this.tableHasColumn('sdk_messages', 'consumed_seq')) {
          const resultSeq = this.nextConsumedSeq();
          if (resultSeq !== null) {
            this.db
              .prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE id = ?')
              .run(resultSeq, id);
          }
        }
        this.saveReplacementEdges(id, sessionId, taskId, message);
        if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
      })();
      // Notify before the fallible search-index work so an FTS throw can't strand
      // the badge update — the counter is already committed with the tx above.
      if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
      this.deleteSupersededMessageSearchRows(sessionId, message);
      this.upsertMessageSearchRow(id);
      return true;
    } catch (error) {
      // Log error but don't throw - prevents stream from dying
      this.logger.error('[Database] Failed to save SDK message:', error);
      this.logger.error('[Database] Message type:', message.type, 'Session:', sessionId);
      return false;
    }
  }

  /**
   * Get SDK messages for a session
   *
   * Returns messages in chronological order (oldest to newest).
   *
   * Pagination modes:
   * 1. Initial load (no before): Returns the NEWEST `limit` top-level messages + their subagent messages
   * 2. Load older (with before): Returns messages BEFORE the given timestamp
   * 3. Load newer (with since): Returns messages AFTER the given timestamp
   *
   * Note: The limit applies only to top-level messages. Subagent messages (with parent_tool_use_id)
   * are automatically included for the returned top-level messages to support SubagentBlock rendering.
   *
   * @param sessionId - The session ID to get messages for
   * @param limit - Maximum number of top-level messages to return (default: 100)
   * @param before - Cursor: get messages older than this timestamp (milliseconds)
   * @param since - Get messages newer than this timestamp (milliseconds)
   * @returns Object with messages array and hasMore boolean
   */
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

  /**
   * Internal implementation for getSDKMessages
   * @private
   */
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
    // Step 1: Get top-level messages (excluding subagent messages)
    // Show user messages that were consumed to SDK, plus any that failed to deliver.
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

    // Cursor-based pagination: get messages before the oldest loaded row.
    // When the caller supplies the boundary rowid (insertion order), use a
    // strict (timestamp, rowid) composite predicate so the cursor advances
    // monotonically even when >limit rows share one timestamp. Without a
    // rowid, fall back to an inclusive timestamp boundary (the re-fetched
    // boundary row is deduped client-side by id).
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

    // Get messages after a timestamp (loading newer / real-time updates).
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

    // Order DESC to get newest messages first, then reverse for chronological display.
    // rowid tiebreak (insertion order) keeps same-millisecond hook phases deterministically
    // ordered instead of shuffled by random UUID id.
    query += ` ORDER BY timestamp DESC, rowid DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    // Parse SDK message and inject the timestamp, sendStatus, and origin from the database row.
    // Always explicitly set `origin` (even to undefined) so the SDK's own
    // `origin?: SDKMessageOrigin` object field — added in SDK 0.2.110 — is stripped from the
    // spread result. Without this, messages whose DB origin column is null would carry an
    // SDKMessageOrigin object instead of a HyperNeo MessageOrigin string, making the field's
    // type inconsistent across messages.
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
        // Insertion-order rowid — exposed so callers can build a monotonic
        // (timestamp, rowid) pagination cursor for same-ms bursts.
        rowid: typeof r.rowid === 'number' ? r.rowid : Number(r.rowid ?? 0),
        // DB origin wins; undefined explicitly clears any SDK-level origin object.
        origin: r.origin != null ? (r.origin as MessageOrigin) : undefined,
      };
      // Task #862: emit the same delivery lifecycle the LiveQuery feed exposes,
      // so the `messages` RPC / initial-load / pagination / export payloads match
      // the feed's wire shape. This path has no job_queue join, so the "retrying"
      // state is not detectable here (the feed covers it); user rows reaching this
      // path are virtually always settled (consumed/failed) anyway.
      if (sdkMessage.type === 'user') {
        const deliveryStatus = sendStatusToDeliveryStatus(
          r.send_status as string | null | undefined
        );
        if (deliveryStatus) extra.deliveryStatus = deliveryStatus;
      }
      messages.push({ ...sdkMessage, ...extra } as SDKMessage & { timestamp: number });
      if (messages.length >= limit) break;
    }

    // Reverse to get chronological order (oldest to newest) for display
    const topLevelMessages = messages.reverse();

    // Determine hasMore: if we got exactly `limit` top-level messages, there might be more
    const hasMore = topLevelMessages.length === limit;

    // Step 2: Get all subagent messages for the returned top-level messages
    // Extract tool use IDs from Task blocks in the top-level messages
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

    // Fetch subagent messages that have parent_tool_use_id matching any of the tool use IDs
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
        // Subagent messages have no DB origin column; explicitly set undefined to strip
        // any SDK-level origin object from the JSON blob (same reasoning as top-level).
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

    // Combine and return: top-level messages + their associated subagent messages
    // hasMore is based on top-level message count only (not including subagent messages)
    // Note: cast required because the new SDK added `origin?: SDKMessageOrigin` to SDKUserMessage,
    // which conflicts with our augmented `origin?: MessageOrigin` field (a different type used for
    // tracking message provenance in HyperNeo). The runtime values are always correct.
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

  /**
   * Get SDK messages by type
   */
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

  /**
   * Get the most recently persisted top-level SDK message for a session.
   *
   * Excludes:
   * - Subagent/tool-linked rows (those with a `parent_tool_use_id`).
   * - User messages still in `deferred`/`enqueued` send_status (not yet consumed
   *   by the SDK), so an unsent injectMessage doesn't shadow the real last message.
   *
   * Used by workflow runtime safety checks that need to know whether a node
   * agent went idle after a terminal SDK result / clear end-turn, or stopped
   * mid-turn (for example after a tool_use without a matching tool_result).
   */
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

  /**
   * Get the count of SDK messages for a session
   *
   * Only counts top-level messages (excludes nested subagent messages with parent_tool_use_id)
   * to ensure accurate pagination.
   */
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

  // ---------------------------------------------------------------------------
  // sessions.visible_message_count maintenance
  // ---------------------------------------------------------------------------
  //
  // `visible_message_count` is a maintained counter that lets
  // `spaceSessions.bySpace` read the badge count directly instead of running a
  // correlated COUNT(*) over sdk_messages for every session on every poll. The
  // predicate mirrors {@link isVisibleBadgeRow} (and the former subquery):
  // top-level rows, non-deferred user rows (consumed/failed), non-hidden
  // subtypes.
  //
  // INSERT paths increment by visibility (O(1)); structural mutations that can
  // flip or remove visible rows (send_status transitions, rewind deletes)
  // recompute the affected session(s) authoritatively from sdk_messages.

  private visibleMessageCountReady: boolean | null = null;

  /** True only on a schema that carries the column (post-migration / fresh). */
  private supportsVisibleMessageCount(): boolean {
    if (this.visibleMessageCountReady === null) {
      this.visibleMessageCountReady =
        this.tableExists('sessions') && this.tableHasColumn('sessions', 'visible_message_count');
    }
    return this.visibleMessageCountReady;
  }

  /** Adjust the counter by `delta` for one session (no-op if unsupported). */
  private bumpVisibleMessageCount(sessionId: string, delta: number): void {
    if (delta === 0 || !this.supportsVisibleMessageCount()) return;
    this.db
      .prepare(`UPDATE sessions SET visible_message_count = visible_message_count + ? WHERE id = ?`)
      .run(delta, sessionId);
  }

  /**
   * Recompute the counter for one session from its current sdk_messages rows.
   * Used after mutations that can change visibility in bulk (send_status
   * transitions, rewind deletes) where an incremental delta would be fragile.
   * Also the shared entry point for callers that bypass the repository and write
   * `sdk_messages` directly (e.g. `scripts/recover-messages.ts`) — so they reuse
   * this predicate instead of re-literalizing it. Returns true if the counter
   * actually changed (so callers can gate the
   * reactive notification).
   */
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
    // Only write (and report a change) when the value actually differs.
    const result = this.db
      .prepare(
        `UPDATE sessions SET visible_message_count = ? WHERE id = ? AND visible_message_count != ?`
      )
      .run(count, sessionId, count);
    return result.changes > 0;
  }

  /**
   * Notify the reactive layer that a session's visible-message counter changed.
   * `spaceSessions.bySpace` depends on `sessions` (not `sdk_messages` — the
   * correlated COUNT(*) is gone), so without this the live badge would never
   * re-evaluate when messages arrive. Called AFTER the mutation transaction
   * commits so re-evaluation sees committed state; the LiveQuery debounce
   * coalesces bursts during a streaming turn.
   *
   * The `sessionId` scope is mandatory: without it the `sessions` change would
   * be unscoped, and when batched inside a reactive transaction with a scoped
   * `sdk_messages` write it would force the whole flushed batch to undefined
   * scope (see `flushPendingTables`), poisoning scope filtering.
   */
  private notifySessionsChanged(sessionId: string): void {
    this.reactiveDb?.notifyChange('sessions', { sessionId });
  }

  // ============================================================================
  // Message Query Mode operations
  // ============================================================================
  // Message send status types for query mode feature:
  // - 'deferred': Message persisted but not yet consumed to SDK (Manual mode)
  // - 'enqueued': Message in queue waiting to be consumed (during processing)
  // - 'consumed': Message has been yielded to SDK

  /**
   * Save a user message with explicit send status
   *
   * Used by query modes to track message lifecycle:
   * - Immediate mode: saves with status 'enqueued', then flips to 'consumed'
   *   when the SDK input generator yields the message
   * - Auto-queue mode: saves with status 'enqueued' (pending SDK consumption)
   * - Manual mode: saves with status 'deferred' (until user triggers send)
   *
   * @returns The generated message ID
   */
  saveUserMessage(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): string {
    const core = this.db.transaction(() =>
      this.saveUserMessageCore(sessionId, message, sendStatus, origin)
    )();
    this.runPostSaveSideEffects(sessionId, core.id, message, core.countsTowardsBadge);
    return core.id;
  }

  /**
   * The transactional body of {@link saveUserMessage} — INSERT + conversation-
   * turn index + replacement edges + visible-badge bump — with NO transaction
   * wrapper of its own and NO post-commit side effects (live-query notify / FTS
   * index). It composes inside an OUTER transaction so the durable-delivery
   * outbox can save the user message AND enqueue its `job_queue` delivery row
   * atomically: a crash between the two writes can no longer strand a
   * saved-but-not-enqueued message. Callers MUST run the returned flags through
   * {@link runPostSaveSideEffects} once the surrounding transaction commits.
   * See task #861 item 2 (transactional outbox).
   *
   * Returns the new row id and whether the row counts toward the visible-badge
   * (so the caller can fire {@link runPostSaveSideEffects}).
   */
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
    // An anchor only once the user message is consumed (or failed). An
    // enqueued/deferred row typed while the agent is mid-turn must NOT open a
    // new conversation turn yet — otherwise the in-flight prompt's later
    // assistant rows + result inherit the queued message's turn and render
    // under it in byTask.compact (#2338). The turn is (re)assigned when the
    // status flips to consumed/failed in updateMessageStatus.
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
    if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
    return { id, countsTowardsBadge };
  }

  /**
   * Post-commit side effects of {@link saveUserMessage} /
   * {@link saveUserMessageCore}: notify the live-query layer of a visible-badge
   * change and refresh the FTS search index. Runs OUTSIDE the save transaction
   * — the FTS work is best-effort and a throw here must not strand the
   * badge/turn bookkeeping already committed. Mirrors the original
   * {@link saveUserMessage} tail. See task #861 item 2.
   */
  runPostSaveSideEffects(
    sessionId: string,
    id: string,
    message: SDKMessage,
    countsTowardsBadge: boolean
  ): void {
    // Task #862 (review P1): the outbox commits the user row via
    // `saveUserMessageCore` (raw db, bypassing the reactive proxy) and the badge
    // notify only fires when the row counts toward the badge — an `enqueued`
    // row does not. Always notify `sdk_messages` so the widened
    // `messages.bySession` feed is re-evaluated on the initial commit and the
    // queued/processing row is surfaced immediately (not after a later status
    // mutation happens to notify).
    this.reactiveDb?.notifyChange('sdk_messages', { sessionId });
    if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
    this.upsertMessageSearchRow(id);
  }

  /**
   * Get messages by send status for a session
   *
   * Used to retrieve:
   * - 'deferred' messages for manual trigger
   * - 'enqueued' messages for auto-send on turn_end
   *
   * Returns messages in chronological order (oldest first).
   */
  getMessagesByStatus(
    sessionId: string,
    status: SendStatus
  ): Array<SDKMessage & { dbId: string; timestamp: number }> {
    const stmt = this.db.prepare(
      `SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND send_status = ?
       ORDER BY timestamp ASC`
    );
    const rows = stmt.all(sessionId, status) as Array<{
      id: string;
      sdk_message: string;
      timestamp: string;
    }>;

    return rows.map((row) => this.inflatePersistedMessage(row));
  }

  /**
   * Look up a single persisted user message by UUID and status.
   *
   * This avoids repeatedly loading and parsing every queued/deferred/consumed
   * message during SDK replay acknowledgment, which is on the hot streaming path.
   */
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
      // Malformed persisted JSON (rare, but possible for legacy/corrupted rows).
      // Return an unknown sentinel so callers like `getLastSDKMessage` and the
      // Space runtime idle/liveness checks degrade gracefully instead of throwing.
      message = { type: 'unknown', rawContent: row.sdk_message } as unknown as SDKMessage;
    }
    return {
      ...message,
      dbId: row.id,
      // DB timestamp (epoch ms) overrides the SDK's ISO string timestamp for persisted messages
      timestamp: new Date(row.timestamp).getTime(),
    } as SDKMessage & { dbId: string; timestamp: number };
  }

  /**
   * Update send status for messages
   *
   * Used to transition messages through the lifecycle:
   * - 'deferred' -> 'enqueued' (when user triggers manual send)
   * - 'enqueued' -> 'consumed' (when message is yielded to SDK)
   */
  updateMessageStatus(
    messageIds: string[],
    newStatus: SendStatus,
    options?: { sharedTurn?: boolean }
  ): void {
    if (messageIds.length === 0) return;

    const placeholders = messageIds.map(() => '?').join(',');
    // #2338: BEFORE the flip, capture the user-anchor rows that are NOT yet
    // anchored (still deferred/enqueued/submitted). Only these need a fresh turn when
    // they become consumed/failed. Rows already consumed/failed are already
    // anchored and must keep their turn — re-bumping those would scatter them
    // to new turns and break grouping on multi-session tasks. Capturing
    // pre-update (filtered by prior send_status) is what excludes them.
    //
    // Renderable TASK rows get a fresh turn index AND a timestamp aligned to the
    // consume/fail moment. EVERY delivery-consumed user row (renderable or not,
    // task or non-task) gets the timestamp aligned — a message queued while
    // another turn ran and later promoted otherwise keeps its original queued
    // timestamp, which predates the previous turn's terminal result and would
    // corrupt the delivery re-claim boundary (`hasTerminalResultAfter`). Turn
    // index assignment stays limited to renderable task anchors. Persisting the
    // timestamp in THIS transaction (not a separate autocommit) makes the
    // consumed-flip + T_consumed atomic across a crash. See Codex (PR #2463).
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
    // A send_status transition can flip a user row's badge visibility
    // (deferred/enqueued/submitted -> consumed/failed), so capture the affected sessions
    // and recompute their counters after the update.
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
    // Wrap the status update + turn assignment + counter recompute in one
    // transaction so an FTS throw (upsertMessageSearchRow, below) can't leave
    // the counter stale. FTS stays outside the transaction (best-effort, as
    // today).
    const changedSessions: string[] = [];
    this.db.transaction(() => {
      stmt.run(newStatus, ...messageIds);

      // Each newly-anchored row gets a fresh turn (MAX+1) in queue order AND its
      // timestamp aligned to the consume/fail moment, so the compact feed's
      // createdAt order agrees with the new turn order — otherwise a prompt
      // typed mid-run but only consumed/failed later keeps its old timestamp
      // while carrying a future turn index and renders out of place. Every
      // promote path (SDK replay, turn-end fallback, enqueued-timeout failure)
      // flows through here, so centralizing avoids per-caller timestamp bugs; a
      // caller can still override with a more precise time via
      // updateMessageTimestamp afterward (the normal SDK-replay path does).
      if (pending.length > 0) {
        const now = new Date().toISOString();
        const maxStmt = this.db.prepare(
          'SELECT MAX(conversation_turn_index) AS m FROM sdk_messages WHERE task_id = ?'
        );
        // sharedTurn (a batched queue flush): every newly-anchored row of the
        // same task gets ONE turn index — the batch is a single provider
        // prompt, and N distinct MAX+1 assignments would both consume the
        // compact feed's recent-turn allowance and attach the response to the
        // last artificial turn. The base is captured once per task BEFORE any
        // row updates, so all rows share base+1.
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
        // consumed_seq is a CONSUMPTION WATERMARK drawn from the shared monotonic
        // counter (delivery_consumed_seq). Terminal results are stamped from the
        // SAME counter at insert (saveSDKMessage), so `hasTerminalResultAfter`
        // compares counter-to-counter — independent of SQLite rowid reuse (a
        // deleted max rowid can be reused by a later insert, which would break a
        // MAX(rowid)+1 boundary). One counter draw per consumed row. See Codex
        // (PR #2463, P2).
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
            // Non-renderable or non-task row: align the timestamp to the
            // consume/fail moment only — turn index stays untouched (limited to
            // renderable task anchors). Same transaction as the status flip, so
            // the delivery boundary survives a crash. See the `pending` capture.
            timeStmt.run(now, row.id);
          }
          // Only a CONSUMED flip carries the consumption boundary (failed rows
          // were never consumed — no consumed_seq). Monotonic counter draw,
          // independent of rowid reuse.
          if (newStatus === 'consumed') {
            consumedSeqStmt.run(this.nextConsumedSeq(), now, row.id);
          }
        }
      }

      for (const { sid } of affectedSessions) {
        if (this.recomputeVisibleMessageCount(sid)) changedSessions.push(sid);
      }
    })();
    // Notify per session (a status flip can touch multiple sessions) before the
    // fallible search-index work; the per-session scope keeps a reactive-tx
    // flush compatible with the scoped sdk_messages write in the same batch.
    for (const sid of changedSessions) this.notifySessionsChanged(sid);
    for (const messageId of messageIds) this.upsertMessageSearchRow(messageId);
  }

  /**
   * Update the timestamp of a message.
   *
   * When timestampMs is provided, sets the timestamp to that value (used to
   * record the moment the SDK generator yielded the message — T_consumed).
   * Otherwise falls back to the current time.
   */
  updateMessageTimestamp(messageId: string, timestampMs?: number): void {
    const stmt = this.db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE id = ?`);
    const ts = timestampMs !== undefined ? new Date(timestampMs) : new Date();
    stmt.run(ts.toISOString(), messageId);
    this.upsertMessageSearchRow(messageId);
  }

  /**
   * Delete one still-pending user message from a session queue.
   *
   * Only deferred/enqueued user messages are eligible. Consumed messages are
   * transcript history and must go through rewind instead.
   */
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
    // Wrap DELETE + counter recompute in one transaction (FTS cleanup below is
    // best-effort, outside the tx) so an FTS throw can't leave the counter stale.
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
    // No notifySessionsChanged(): the deleted row was deferred/enqueued
    // (invisible), so the badge count is unchanged.
    return {
      dbId: row.id,
      uuid: message.uuid ?? '',
      status: row.send_status,
    };
  }

  /**
   * Compare-and-set one enqueued user message to deferred. Returns its UUID only
   * when this mutation wins before SDK/provider delivery.
   */
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

  /**
   * Get count of messages by status for a session
   * Useful for UI display (e.g., "3 messages pending")
   */
  getMessageCountByStatus(sessionId: string, status: SendStatus): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND send_status = ?`
    );
    const result = stmt.get(sessionId, status) as { count: number };
    return result.count;
  }

  /**
   * Delete messages after a specific timestamp
   *
   * Used by the rewind feature to remove messages from the conversation
   * when rewinding to a previous checkpoint.
   *
   * @param sessionId - The session ID to delete messages from
   * @param afterTimestamp - Delete messages with timestamp greater than this value (milliseconds)
   * @returns The number of messages deleted
   */
  deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
    const isoTimestamp = new Date(afterTimestamp).toISOString();
    const rows = this.db
      .prepare(`SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp > ?`)
      .all(sessionId, isoTimestamp) as Array<{ id: string; sdk_uuid: string | null }>;
    const stmt = this.db.prepare(`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp > ?`);
    // Wrap DELETE + counter recompute + turn-end marker cleanup in one
    // transaction (FTS cleanup below is best-effort, outside the tx) so an FTS
    // throw can't leave the counter stale. Markers for rewound UUIDs must go so
    // a re-persisted UUID (e.g. a long-horizon inbox retry) isn't skipped as
    // "already ended" by a stale marker. See Codex (PR #2463, P2).
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

  /**
   * Delete messages at and after a specific timestamp (inclusive)
   *
   * Used by the rewind feature to remove the rewind point message itself
   * and all subsequent messages.
   *
   * @param sessionId - The session ID to delete messages from
   * @param atTimestamp - Delete messages with timestamp greater than or equal to this value (milliseconds)
   * @returns The number of messages deleted
   */
  deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
    const isoTimestamp = new Date(atTimestamp).toISOString();
    const rows = this.db
      .prepare(`SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`)
      .all(sessionId, isoTimestamp) as Array<{ id: string; sdk_uuid: string | null }>;
    const stmt = this.db.prepare(
      `DELETE FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`
    );
    // Wrap DELETE + counter recompute + turn-end marker cleanup in one
    // transaction (FTS cleanup below is best-effort, outside the tx) so an FTS
    // throw can't leave the counter stale. See deleteMessagesAfter / Codex (#2463).
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

  /**
   * Get user messages for a session (used as rewind points)
   *
   * Returns user messages with their UUIDs, timestamps, and content.
   * These serve as potential rewind checkpoints since each user message
   * has a UUID that the SDK uses for file checkpointing.
   *
   * @param sessionId - The session ID to get user messages for
   * @returns Array of user message data for rewind
   */
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

      // Extract text content from message
      // User messages have a specific structure with nested message.content
      let content = '';
      const userMessage = message as {
        message?: { content?: string | Array<{ type: string; text?: string }> };
        uuid?: string;
      };
      if (userMessage.message?.content) {
        if (typeof userMessage.message.content === 'string') {
          content = userMessage.message.content;
        } else if (Array.isArray(userMessage.message.content)) {
          // Find first text block
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

  /**
   * Get a single user message by UUID.
   *
   * Used by rewind to look up a specific checkpoint/message.
   *
   * Seeks `idx_sdk_messages_session_uuid (session_id, sdk_uuid)` directly.
   * `sdk_uuid` is populated for every row — set at INSERT time via
   * `extractSdkUuid` and backfilled for legacy rows by migration 163 — so
   * filtering on the column is equivalent to `json_extract(sdk_message,'$.uuid')`
   * without the per-row JSON parse. The old implementation probed each
   * `send_status` in turn because the superseded `idx_sdk_messages_uuid_status`
   * (session_id, send_status, json_extract uuid) only picked its 3-column seek
   * when `send_status` was constrained to a single value; that workaround is
   * gone now that the index has been dropped.
   *
   * There is no DB-level uniqueness constraint on `sdk_uuid`, so a uuid can in
   * principle be shared by several user rows in the same session. We collect
   * every match and return the chronologically earliest — rewind's
   * deletion-bound math depends on the timestamp being the earliest occurrence.
   *
   * @param sessionId - The session ID
   * @param uuid - The message UUID
   * @returns The message data or undefined
   */
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

    // Pick the chronologically earliest match — preserves the previous
    // full-session ORDER BY timestamp ASC + first-match behavior that rewind
    // timestamp math depends on (only relevant if a uuid is shared by several
    // user rows in the same session).
    let earliest = rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].timestamp < earliest.timestamp) earliest = rows[i];
    }
    return this.parseUserMessageRow(earliest, uuid);
  }

  /**
   * Load the raw `message.content` (string OR content-block array) for a user
   * message by UUID, preserving multimodal blocks (images, tool_results, extra
   * text). Used by the message-delivery v2 handler to feed the transport WITHOUT
   * the data-loss of the text-flattening {@link getUserMessageByUuid} (which is
   * display/rewind-oriented). Status-agnostic (a retried message may be
   * consumed/failed by the time the handler loads it). Returns null if no user
   * row matches or the blob is unparseable. Earliest match wins (consistent with
   * getUserMessageByUuid if a uuid is shared by several rows).
   */
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

  /**
   * Load a user message's content blocks AND `send_status` by UUID — used by the
   * message-delivery v2 handler to decide whether feeding is warranted BEFORE it
   * drives/feeds (status-aware delivery). This is what makes recovery safe:
   *
   * - `consumed` kickoff → a prior attempt already fed it (before a crash). The
   *   SDK's resume-from-history already holds it, so re-feeding would DUPLICATE
   *   the user's prompt. The handler skips the feed (and just ensures the query
   *   is running so history drives the turn).
   * - `deferred` → the user deferred it via "send next"; don't force-feed it into
   *   the running turn.
   * - `failed` → already terminal.
   * - `enqueued` → pending delivery; feed normally.
   *
   * See docs/features/message-delivery-v2.md §8 + Codex (#2592 consumed-kickoff,
   * #2597 defer). COALESCE(NULL→'consumed') so a NULL status (defensive) is
   * treated as already-delivered, never re-fed.
   */
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

  /**
   * True when the session's transcript has a SUCCESS terminal `result` message
   * after the message identified by `uuid` — i.e. the turn that consumed it ran
   * to a successful completion. Only `subtype = 'success'` matches: an error
   * result (`error_during_execution`, `error_max_turns`, …) is NOT success, so
   * it does not match here and the bridge falls through to the retry / dead-
   * letter path instead of completing the job over a failed turn (Codex #9). A
   * re-claimed `consumed` delivery turn that ended successfully has nothing to
   * resume: re-driving it would start a fresh streaming query that waits for
   * input forever, holding the active-turn slot and parking every subsequent
   * message as a steer. See message-delivery-v2.md + the handler's
   * turn_terminated skip.
   *
   * The boundary is the message's CONSUMPTION timestamp (T_consumed, aligned by
   * `markDeliveryConsumedByUuid`), not its original persistence time — a message
   * queued while another turn ran and later promoted would otherwise match the
   * previous turn's terminal result. Ordering breaks timestamp ties by `rowid`
   * (a result inserted in the same millisecond as consumption still sorts after
   * it), so an immediate error/interrupt that lands in the same ms as the
   * consumed-flip is not mistaken for a still-live turn. See Codex (PR #2463).
   */
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

  /**
   * The subtype of the MOST RECENT NON-success terminal `result` after the
   * message identified by `uuid` (e.g. `error_max_budget_usd`), or null when
   * none exists. Companion of {@link hasTerminalResultAfter}: the bridge uses
   * it to classify a turn that ended in an error result — the SDK persists such
   * results WITHOUT emitting `session.error`, so without this lookup a terminal
   * error result (budget/limit exhaustion) would be treated as a recoverable
   * no-result stall and retried, repeating spend. MOST RECENT because retries
   * do not restamp the user row's consumed_seq, so error results from every
   * attempt are in range — the latest attempt's outcome is the one to classify
   * (an initial `error_during_execution` followed by `error_max_budget_usd`
   * must dead-letter, not keep retrying). (Codex review.)
   */
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

  /**
   * Atomically draw the next value from the shared monotonic consumption
   * counter (delivery_consumed_seq). Used to stamp both consumed messages (at
   * the consumed-flip) and terminal results (at insert) so
   * `hasTerminalResultAfter` can order them counter-to-counter, independent of
   * SQLite rowid reuse. Call within the consuming transaction. See Codex
   * (PR #2463, P2).
   */
  private nextConsumedSeq(): number | null {
    // Bump-then-read in one statement; the singleton row always exists (created
    // by the schema / migration 189). Table-guarded so partial/legacy test
    // schemas without the counter don't throw — a NULL stamp means "unknown/
    // live", which hasTerminalResultAfter never matches (safe: the row just
    // won't be recognized as turn-ended via the result path).
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

  /**
   * Persist a durable delivery-turn completion marker for a consumed message
   * whose turn ended via a RESULT-LESS terminal path (query-level error,
   * interrupt) that persisted no SDK `result` row. `hasDeliveryTurnEnd` lets a
   * stale re-claim recognize the turn already ended instead of re-driving it
   * into an indefinitely-waiting query. Written by the delivery handler when a
   * driven turn completes while its job is still `processing` (gated so a
   * graceful-shutdown requeue — where resume is desired — does not mark it).
   * See Codex (PR #2463, P2 result-less terminal paths).
   */
  recordDeliveryTurnEnd(sessionId: string, messageUuid: string, endedAt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO delivery_turn_end (session_id, message_uuid, ended_at)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, messageUuid, endedAt);
  }

  /**
   * True when a durable delivery-turn completion marker exists for `messageUuid`
   * in this session — i.e. a result-less terminal path recorded that the turn
   * ended. Complements {@link hasTerminalResultAfter}; the delivery re-claim
   * treats either as "the consumed turn ended".
   */
  hasDeliveryTurnEnd(sessionId: string, messageUuid: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM delivery_turn_end WHERE session_id = ? AND message_uuid = ? LIMIT 1`)
      .get(sessionId, messageUuid) as { 1: number } | undefined | null;
    return row != null;
  }

  /**
   * Delete a durable delivery-turn completion marker for `messageUuid`. Called
   * on rewind (`deleteMessagesAfter` / `deleteMessagesAtAndAfter`): delivery
   * paths such as long-horizon inbox retries intentionally reuse stable message
   * UUIDs, so a stale marker for a rewound UUID must not survive to mark a
   * re-persisted message's new turn as already ended. No-op when the
   * delivery_turn_end table is absent (legacy/partial test schemas). See Codex
   * (PR #2463, P2).
   */
  clearDeliveryTurnEnd(sessionId: string, messageUuid: string): void {
    if (!this.tableExists('delivery_turn_end')) return;
    this.db
      .prepare(`DELETE FROM delivery_turn_end WHERE session_id = ? AND message_uuid = ?`)
      .run(sessionId, messageUuid);
  }

  /**
   * Terminalize a user message as `failed` by UUID — the message-delivery v2
   * dead-letter path. Called from the processor's `onDead` hook when a delivery
   * job exhausts its retry budget; without this, the persisted row stays
   * `enqueued`, which pagination hides, so the user's prompt vanishes without a
   * terminal error. Only flips rows still pending delivery (`enqueued`/
   * `deferred`) — a `consumed` row means the turn ran (don't fail it), a
   * `failed` row is idempotent. Returns the flipped db id (so the caller can
   * publish the status change), else null. See Codex (#2595).
   */
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
    // updateMessageStatus handles the turn-assignment + visible-counter
    // bookkeeping for the consumed/failed transition.
    this.updateMessageStatus([row.id], 'failed');
    return row.id;
  }

  /**
   * Like {@link markDeliveryFailedByUuid} but ALSO flips a `consumed` row. Used
   * ONLY by the message-delivery dead-letter settlement when a driven turn that
   * already reached `consumed` (the SDK accepted the prompt) then died on a
   * provider error and exhausted its retries (or hit a non-recoverable error),
   * and by the SDK runner's startup-retry give-up for the same class — a
   * consumed row whose delivery genuinely failed after exhausting its bounded
   * retries (there the steers were only ever yielded to silent subprocesses;
   * see the budget-exhausted branch in query-runner.ts).
   * The narrow method deliberately excludes `consumed` (other callers — archive
   * barriers, enqueue failures, interrupts — must not fail a message that WAS
   * delivered), so this sibling exists for the one path where a consumed row
   * genuinely failed. Returns the flipped db id, else null. See
   * `message-delivery-dead-letter.ts` + docs/features/message-delivery-v2.md.
   */
  markDeliveryFailedByUuidInclusive(sessionId: string, uuid: string): string | null {
    // `deferred` is deliberately EXCLUDED: a deferred row is an explicit user
    // hold (or a batch member excluded from the prompt before delivery), never
    // something this dead-letter delivered — flipping it to `failed` would
    // destroy the user's queue intent.
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

  /**
   * Flip a pending delivery row to `consumed` at the earliest SDK-consume
   * signal (the onSent/started-acknowledgment, before the turn runs) — the
   * at-least-once quality hardening (task #861 item 12). Delivery is
   * at-least-once: a crash in the window [SDK yield, persisted consumed-flip]
   * can still cause a duplicate re-feed, so this shrinks that window to
   * sub-millisecond by flipping synchronously the moment the SDK acknowledges
   * consumption. `reclaimStale` then almost always observes `consumed` and the
   * handler's status-aware reload skips the re-feed (drives with
   * `alreadyConsumed`).
   *
   * Only flips rows still pending delivery (`enqueued`/`submitted`) — a
   * `consumed` row already ran (idempotent no-op, returns null), and
   * `deferred`/`failed` are not consume candidates. Returns the flipped db id
   * (so the caller publishes `messages.statusChanged`), else null.
   * `updateMessageStatus` performs the turn-assignment + timestamp alignment +
   * visible-counter bookkeeping for the transition.
   *
   * The row timestamp is aligned to the consumption moment (T_consumed) for ALL
   * rows, not just task rows, INSIDE the same transaction as the status flip —
   * a message queued while another turn ran and later promoted otherwise keeps
   * its ORIGINAL persistence timestamp (which can predate the previous turn's
   * terminal result), and a crash between flip and a separate timestamp write
   * would leave the boundary wrong. Delivery re-claims
   * (`hasTerminalResultAfter`) use the row timestamp as the "what turn is this
   * message part of" boundary, so the atomic alignment is required for
   * correctness. The `updateMessageStatus` search-index upsert also reflects
   * T_consumed, so message search orders the row by consumption, not queue time.
   * See Codex (PR #2463, P1 + P2 search-index).
   */
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

  /**
   * Atomic multi-row variant of {@link markDeliveryConsumedByUuid} for batched
   * queue flushes: the kickoff and every admitted member flip to `consumed` in
   * ONE transaction. A crash between the kickoff's flip and the members' would
   * otherwise leave the members `enqueued` while the (consumed) reclaim skips
   * the re-feed — the reconciler would then deliver them individually,
   * repeating already-executed prompts. Returns the flipped db ids in the
   * caller's UUID order (skips rows not in a consumable state).
   */
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
        if (!row) continue;
        this.updateMessageStatus([row.id], 'consumed', { sharedTurn: true });
        ids.push(row.id);
      }
      return ids;
    })();
  }

  /**
   * Flip a batched flush's admitted members to `submitted` TOGETHER at
   * admission — their text is already inside the kickoff-keyed combined prompt
   * the bridge is about to hand the transport, so they must leave the
   * user-mutable `enqueued` state at that moment (revoke/defer operate only on
   * `enqueued`/`deferred` rows and cannot retract in-flight prompt text).
   * Only flips still-`enqueued` rows; returns the flipped db ids.
   */
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

  /**
   * Flip a previously-`failed` delivery row back to `enqueued` so a retry can
   * re-drive it — the counterpart of {@link markDeliveryFailedByUuid} for the
   * crash-retry path. A prior attempt whose durable enqueue threw terminalized
   * the row; the caller (e.g. long-horizon external-event delivery) is now
   * retrying with the same idempotency key, and the message-delivery handler
   * skips `failed` rows, so the row must be reopened before a new job is
   * enqueued. Only reopens `failed` rows — a `consumed` row already ran its
   * turn (must not be re-driven). Returns the flipped db id, else null.
   */
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
    // updateMessageStatus([id], 'enqueued') only flips the status (the
    // turn-assignment/counter logic fires solely on consumed/failed).
    this.updateMessageStatus([row.id], 'enqueued');
    return row.id;
  }

  /**
   * Flip a pending delivery row to `deferred` by UUID. Used when a retry reaches
   * the deferred branch (target busy / rate-limited / parent-limited) holding an
   * existing `enqueued` row (e.g. a `failed` row just reopened). Without this the
   * row stays `enqueued` and QueryModeHandler's deferred replay — which selects
   * only `send_status='deferred'` — never picks it up, so the handoff is lost on
   * an idle parent-limited session. Only flips `enqueued` rows — NOT `submitted`
   * (ACP): a submitted prompt already reached the subprocess, and deferring it
   * would leave SDKMessageHandler unable to match its acceptance, so the row
   * replays later and the handoff executes twice. (Codex P1.)
   */
  /**
   * Flip a `consumed` delivery row back to `enqueued` after its turn was
   * CONFIRMED to have produced no result (the delivery bridge's recoverable
   * no-result path). The automatic retry must re-feed the prompt: a resumed SDK
   * query only LOADS the conversation history — it does not continue an
   * incomplete trailing user turn — so a no-feed re-drive would sit silent
   * until the stall watchdog fires again and burn the retry budget without ever
   * making another provider attempt. The rate-limit recovery path re-enqueues
   * the saved message for exactly this reason. Contrast the crash-reclaim path,
   * which leaves `consumed` alone (the SDK may already be mid-execution there;
   * re-feeding could duplicate the prompt). Only flips `consumed` rows —
   * `submitted` (ACP, still pending acceptance) and terminal states are left
   * to their own paths. Returns the flipped db id, else null.
   */
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

    // Extract text content from message
    // User messages have a specific structure with nested message.content
    let content = '';
    const userMessage = message as {
      message?: { content?: string | Array<{ type: string; text?: string }> };
      uuid?: string;
    };
    if (userMessage.message?.content) {
      if (typeof userMessage.message.content === 'string') {
        content = userMessage.message.content;
      } else if (Array.isArray(userMessage.message.content)) {
        // Find first text block
        const textBlock = userMessage.message.content.find(
          (block): block is { type: 'text'; text: string } => block.type === 'text'
        );
        content = textBlock?.text || '';
      }
    }

    return { uuid, timestamp, content };
  }

  /**
   * Get assistant messages from a session since a specific message (by DB row ID).
   *
   * Used by Room Runtime to collect Craft output for forwarding to Lead.
   * - If afterMessageId is null: returns all assistant messages for the session.
   * - Otherwise: returns messages whose timestamp is after the row with afterMessageId.
   *
   * Returns structured objects ready for envelope formatting.
   */
  getAssistantMessagesSince(
    sessionId: string,
    afterMessageId: string | null
  ): Array<{ id: string; text: string; toolCallNames: string[] }> {
    let query: string;
    let params: Array<string>;

    if (afterMessageId) {
      // Get timestamp of the reference message, then fetch messages after it
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
    // Also capture result text from SDK result messages
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

  /**
   * Count messages after a specific timestamp
   *
   * Used by rewind to show how many messages will be deleted.
   *
   * @param sessionId - The session ID
   * @param afterTimestamp - Count messages with timestamp greater than this value (milliseconds)
   * @returns The number of messages after the timestamp
   */
  countMessagesAfter(sessionId: string, afterTimestamp: number): number {
    const isoTimestamp = new Date(afterTimestamp).toISOString();
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND timestamp > ?`
    );
    const result = stmt.get(sessionId, isoTimestamp) as { count: number };
    return result.count;
  }

  // ============================================================================
  // HyperNeo action messages (interactive prompts stored in the chat timeline)
  // ============================================================================

  /**
   * Save a HyperNeo-native action message to the sdk_messages table.
   *
   * The message is stored in the same `sdk_message` JSON column as SDK messages,
   * but with `message_type = 'hyperneo_action'` so it can be distinguished during
   * fetch.  No `send_status` is needed because action messages are never queued.
   *
   * @returns The generated row ID (used later to update the resolved state).
   */
  saveHyperNeoActionMessage(sessionId: string, message: HyperNeoActionMessage): string {
    const id = generateUUID();
    const timestamp = new Date(message.timestamp).toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);
    // hyperneo_action rows are never conversation anchors (message_type !=
    // 'user'), so they inherit the task's current turn.
    const conversationTurnIndex = this.resolveConversationTurnIndex(taskId, sessionId, false);
    // Action rows are top-level, non-user, and use `message.action` as the
    // subtype — visible unless that action happens to be a hidden subtype.
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

    // Wrap insert + counter bump in one transaction so a failure between them
    // can't leave the counter under-counted — matches saveSDKMessage /
    // saveUserMessage. upsertMessageSearchRow stays outside (FTS, best-effort).
    this.db.transaction(() => {
      insertStmt.run(...values, conversationTurnIndex, message.uuid);
      if (countsTowardsBadge) this.bumpVisibleMessageCount(sessionId, 1);
    })();
    if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
    this.upsertMessageSearchRow(id);
    return id;
  }

  /**
   * True iff an UNRESOLVED HyperNeo action message of the given action kind
   * exists for the session. Used to dedupe the sdk_resume_choice prompt: under
   * message-delivery v2, a blocked turn job is PARKED and re-claimed every few
   * seconds, and each reclaim re-runs ensureQueryStarted → emitSdkResumeChoice.
   * Without this guard that would pile up ~12 duplicate action cards/min. See
   * message-delivery-v2.md §8 + review P2.
   */
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
    // bun:sqlite `.get()` returns null (not undefined) for no rows, so a
    // `!== undefined` check inverts the polarity: no card ⇒ true. That made
    // emitSdkResumeChoiceMessage's dedupe believe an unresolved card existed
    // and skip emitting it entirely — sessions with a purged SDK transcript
    // parked on sdk_resume_choice forever with no card to answer. Match the
    // null-safe form used by isHandleTaken/isNameTaken.
    return row !== null && row !== undefined;
  }

  /**
   * Update a HyperNeo action message in-place (e.g. mark it resolved after the
   * user has made a choice).
   *
   * @param rowId   The ID returned by saveHyperNeoActionMessage.
   * @param updated The full updated message object (replaces the stored JSON).
   */
  updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): void {
    const stmt = this.db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`);
    stmt.run(JSON.stringify(updated), rowId);
    this.upsertMessageSearchRow(rowId);
  }

  /**
   * Update a HyperNeo action message by its uuid field (stored inside the JSON blob).
   *
   * This avoids having to carry the row ID through the RPC call.  The uuid is
   * unique per session (generated at emit time) so the lookup is unambiguous.
   */
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
    if (row) this.upsertMessageSearchRow(row.id);
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
    // Dedupe by rowid: SQLite ≥3.53's FTS5 can emit a matched rowid more than
    // once for `rowid IN (...) AND MATCH ?` (the candidate query above already
    // yields unique rowids; this guard keeps the snippet-enrichment rows unique
    // across SQLite versions so each result appears exactly once).
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
