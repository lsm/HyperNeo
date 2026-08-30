import type {
  ChatMessage,
  HyperNeoActionMessage,
  MessageContent,
  MessageDeliveryStatus,
  MessageOrigin,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../../lib/logger.ts';
import { withBusyRetry } from '../busy-retry.ts';
import {
  buildFtsQuery,
  extractVisibleSearchText,
  isBroadMessageSearchQuery,
  type MessageSearchParams,
  type MessageSearchResponse,
  type MessageSearchResult,
} from '../message-search.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import {
  type DeliveryTransitionAction,
  deliveryTransitionRule,
  routeDeliveryTransition,
} from './delivery-status-routing.ts';
import type { MessageSearchEligibilityRow } from './message-search-admission.ts';
import { decideMessageSearchAdmission } from './message-search-admission.ts';
import {
  decideMessageAdmission,
  extractReplacementEdges,
  type MessageAdmissionRecord,
  type MessageAdmissionVariant,
  normalizeMessageAdmissionInput,
  type SDKMessageReplacementEdge,
  type SendStatus,
} from './sdk-message-admission.ts';
import {
  type BadgeUpdateInstruction,
  planAdmissionBadgeUpdate,
  planBadgeRecompute,
} from './sdk-message-badge.ts';
import {
  type BackgroundTaskMessageRow,
  buildRowIdHydrationBatches,
  composeMessagePage,
  extractFirstTextBlockContent,
  extractToolCallNames,
  extractVisibleText,
  inflatePersistedMessage,
  orderHydratedMessages,
  type PaginationMessageRow,
  projectBackgroundTaskMessageRow,
  projectRenderableTextRow,
  RENDERABLE_TEXT_MESSAGE_BATCH_SIZE,
  type RenderableTextMessage,
  type RenderableTextMessageRow,
  resolveRenderableTextScanBudget,
  type SubagentMessageRow,
} from './sdk-message-projections.ts';
import {
  applyMessageStatusPlan,
  PENDING_ROW_FROM_STATUSES,
  planMessageStatusApplication,
} from './sdk-message-status-plan.ts';

export type { SDKMessageReplacementEdge, SendStatus } from './sdk-message-admission.ts';
export {
  computeIsRenderable,
  computeIsTerminal,
  extractParentToolUseId,
  extractReplacementEdges,
  extractSdkUuid,
} from './sdk-message-admission.ts';

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

export const HAS_TERMINAL_RESULT_AFTER_SQL = `SELECT 1
           FROM sdk_messages r
          WHERE r.session_id = ?
            AND r.message_type = 'result'
            AND r.is_terminal = 1
            AND r.message_subtype = 'success'
            AND r.parent_tool_use_id IS NULL
            AND r.consumed_seq IS NOT NULL
            AND r.consumed_seq >= (
              SELECT m.consumed_seq FROM sdk_messages m
               WHERE m.session_id = ? AND m.sdk_uuid = ?
               ORDER BY m.consumed_seq IS NULL, m.consumed_seq DESC LIMIT 1
            )
            AND COALESCE(json_extract(r.sdk_message, '$.internal_compaction_turn'), 0) = 0
            AND NOT (
              COALESCE(json_extract(r.sdk_message, '$.is_error'), 0) = 1
              AND COALESCE(json_extract(r.sdk_message, '$.recovery_intercepted'), 0) = 1
              AND COALESCE(json_extract(r.sdk_message, '$.recovery_billing_terminal'), 0) = 0
            )
          LIMIT 1`;

export const HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL = `SELECT 1
           FROM sdk_messages r
          WHERE r.session_id = ?
            AND r.message_type = 'result'
            AND r.is_terminal = 1
            AND r.parent_tool_use_id IS NULL
            AND r.consumed_seq IS NOT NULL
            AND r.consumed_seq >= (
              SELECT m.consumed_seq FROM sdk_messages m
               WHERE m.session_id = ? AND m.sdk_uuid = ?
               ORDER BY m.consumed_seq IS NULL, m.consumed_seq DESC LIMIT 1
            )
            AND COALESCE(json_extract(r.sdk_message, '$.recovery_intercepted'), 0) = 1
            AND COALESCE(json_extract(r.sdk_message, '$.recovery_billing_terminal'), 0) = 0
          LIMIT 1`;

export const GET_ERROR_TERMINAL_RESULT_SUBTYPE_AFTER_SQL = `SELECT r.message_subtype AS subtype
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
               WHERE m.session_id = ? AND m.sdk_uuid = ?
               ORDER BY m.consumed_seq IS NULL, m.consumed_seq DESC LIMIT 1
            )
          ORDER BY r.consumed_seq DESC
          LIMIT 1`;

export const MESSAGE_SUPERSEDED_PROBE_SQL = `SELECT 1
           FROM sdk_message_replacements replacement
           WHERE replacement.session_id = ?
             AND replacement.source_message_id != ?
             AND replacement.target_uuid = ?
           LIMIT 1`;

export const SEARCHABLE_USER_STATUS_PROBE_SQL = `SELECT COALESCE(send_status, 'consumed') AS send_status FROM sdk_messages WHERE id = ?`;

export interface MessageSearchAdmissionSchemaFeatures {
  hasSessions: boolean;
  hasSpaceTasks: boolean;
  hasSessionTitle: boolean;
  hasSessionStatus: boolean;
  hasSessionType: boolean;
  hasSessionLastActiveAt: boolean;
  hasSessionRoomId: boolean;
  hasTaskStatus: boolean;
  hasTaskCompletedAt: boolean;
  hasTaskUpdatedAt: boolean;
}

export function detectMessageSearchAdmissionFeatures(
  db: BunDatabase
): MessageSearchAdmissionSchemaFeatures {
  const tableExists = (name: string): boolean => {
    try {
      return !!db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(name);
    } catch {
      return false;
    }
  };
  const tableHasColumn = (table: string, column: string): boolean => {
    try {
      const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name?: string }>;
      return rows.some((row) => row.name === column);
    } catch {
      return false;
    }
  };
  const hasSessions = tableExists('sessions');
  const hasSpaceTasks = tableExists('space_tasks');
  return {
    hasSessions,
    hasSpaceTasks,
    hasSessionTitle: hasSessions && tableHasColumn('sessions', 'title'),
    hasSessionStatus: hasSessions && tableHasColumn('sessions', 'status'),
    hasSessionType: hasSessions && tableHasColumn('sessions', 'type'),
    hasSessionLastActiveAt: hasSessions && tableHasColumn('sessions', 'last_active_at'),
    hasSessionRoomId: hasSessions && tableHasColumn('sessions', 'room_id'),
    hasTaskStatus: hasSpaceTasks && tableHasColumn('space_tasks', 'status'),
    hasTaskCompletedAt: hasSpaceTasks && tableHasColumn('space_tasks', 'completed_at'),
    hasTaskUpdatedAt: hasSpaceTasks && tableHasColumn('space_tasks', 'updated_at'),
  };
}

export function buildMessageSearchAdmissionLookupSql(
  features: MessageSearchAdmissionSchemaFeatures
): string {
  const sessionTitleSelect = features.hasSessionTitle
    ? 's.title AS session_title'
    : 'sm.session_id AS session_title';
  const sessionPolicySelect = `${features.hasSessionStatus ? 's.status' : 'NULL'} AS session_status,
				   ${features.hasSessionType ? 's.type' : 'NULL'} AS session_type,
				   ${features.hasSessionLastActiveAt ? 's.last_active_at' : 'NULL'} AS session_last_active_at,
				   ${features.hasSessionRoomId ? 's.room_id' : 'NULL'} AS session_room_id`;
  const spaceTaskSelect = features.hasSpaceTasks
    ? `st.space_id, st.task_number,
				   ${features.hasTaskStatus ? 'st.status' : 'NULL'} AS task_status,
				   ${features.hasTaskCompletedAt ? 'st.completed_at' : 'NULL'} AS task_completed_at,
				   ${features.hasTaskUpdatedAt ? 'st.updated_at' : 'NULL'} AS task_updated_at`
    : `NULL AS space_id, NULL AS task_number,
				   NULL AS task_status,
				   NULL AS task_completed_at,
				   NULL AS task_updated_at`;
  const sessionJoin = features.hasSessions ? 'LEFT JOIN sessions s ON s.id = sm.session_id' : '';
  const spaceTaskJoin = features.hasSpaceTasks
    ? 'LEFT JOIN space_tasks st ON st.id = sm.task_id'
    : '';
  return `SELECT sm.id, sm.session_id, sm.task_id, sm.message_type, sm.sdk_message, sm.timestamp,
					${sessionTitleSelect}, ${sessionPolicySelect}, ${spaceTaskSelect}
			 FROM sdk_messages sm
			 ${sessionJoin}
			 ${spaceTaskJoin}
			 WHERE sm.id = ?`;
}

type TimestampComparison = '>' | '>=';

interface SaveSdkMessageInput {
  sessionId: string;
  message: SDKMessage;
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus | null;
  origin?: MessageOrigin;
  stampInternalCompactionTurn?: boolean;
}

interface SaveSdkMessageSnapshot extends SaveSdkMessageInput {
  dbId: string;
}

interface SaveSdkMessageAdmitted extends SaveSdkMessageSnapshot {
  admission: MessageAdmissionRecord;
  badgeUpdate: BadgeUpdateInstruction;
}

interface SaveSdkMessageDeps {
  saveSDKMessageWithAdmission(ctx: SaveSdkMessageAdmitted): { dbId: string };
  notifySessionsChanged(sessionId: string): void;
  deleteSupersededMessageSearchRows(sessionId: string, message: SDKMessage): void;
  logger: Logger;
}

type SaveSdkMessageCtx = SaveSdkMessageInput & { deps: SaveSdkMessageDeps };
type SaveSdkMessageSnapshotCtx = SaveSdkMessageSnapshot & SaveSdkMessageCtx;
type SaveSdkMessageAdmittedCtx = SaveSdkMessageAdmitted & SaveSdkMessageCtx;

function snapshotSdkMessage(ctx: SaveSdkMessageCtx): SaveSdkMessageSnapshotCtx {
  return { ...ctx, dbId: generateUUID() };
}

function admitSdkMessage(ctx: SaveSdkMessageSnapshotCtx): SaveSdkMessageAdmittedCtx {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: ctx.variant,
    sendStatus: ctx.sendStatus,
    origin: ctx.origin,
  });
  return {
    ...ctx,
    admission,
    badgeUpdate: planAdmissionBadgeUpdate(admission),
  };
}

function saveSdkMessageAtomic(ctx: SaveSdkMessageAdmittedCtx): SaveSdkMessageAdmittedCtx {
  const { dbId } = ctx.deps.saveSDKMessageWithAdmission(ctx);
  return { ...ctx, dbId };
}

function publishSdkMessage(ctx: SaveSdkMessageAdmittedCtx): SaveSdkMessageAdmittedCtx {
  try {
    if (ctx.badgeUpdate.kind === 'delta') {
      ctx.deps.notifySessionsChanged(ctx.sessionId);
    }
    ctx.deps.deleteSupersededMessageSearchRows(ctx.sessionId, ctx.message);
  } catch (error) {
    ctx.deps.logger.error('[Database] Post-commit side effects failed for SDK message:', error);
    ctx.deps.logger.error('[Database] Message type:', ctx.message.type, 'Session:', ctx.sessionId);
  }
  return ctx;
}

const runSaveSdkMessage = (superpipe({})('save-sdk-message') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotSdkMessage, 'ctx', 'ctx')
  .pipe(admitSdkMessage, 'ctx', 'ctx')
  .pipe(saveSdkMessageAtomic, 'ctx', 'ctx')
  .pipe(publishSdkMessage, 'ctx', 'ctx')
  .end('ctx') as (ctx: SaveSdkMessageCtx) => SaveSdkMessageAdmittedCtx;

interface SaveUserMessageInput {
  sessionId: string;
  message: SDKMessage;
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus;
  origin?: MessageOrigin;
}

interface SaveUserMessageSnapshot extends SaveUserMessageInput {
  id: string;
}

interface SaveUserMessageAdmitted extends SaveUserMessageSnapshot {
  admission: MessageAdmissionRecord;
}

interface SaveUserMessageSaved extends SaveUserMessageAdmitted {
  countsTowardsBadge: boolean;
}

interface SaveUserMessageDeps {
  saveUserMessageWithAdmission(ctx: SaveUserMessageAdmitted): {
    id: string;
    countsTowardsBadge: boolean;
  };
  runPostSaveSideEffects(sessionId: string, id: string, countsTowardsBadge: boolean): void;
}

type SaveUserMessageCtx = SaveUserMessageInput & { deps: SaveUserMessageDeps };
type SaveUserMessageSnapshotCtx = SaveUserMessageSnapshot & SaveUserMessageCtx;
type SaveUserMessageAdmittedCtx = SaveUserMessageAdmitted & SaveUserMessageCtx;
type SaveUserMessageSavedCtx = SaveUserMessageSaved & SaveUserMessageCtx;

function snapshotUserMessage(ctx: SaveUserMessageCtx): SaveUserMessageSnapshotCtx {
  return { ...ctx, id: generateUUID() };
}

function admitUserMessage(ctx: SaveUserMessageSnapshotCtx): SaveUserMessageAdmittedCtx {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: ctx.variant,
    sendStatus: ctx.sendStatus,
    origin: ctx.origin,
  });
  return { ...ctx, admission };
}

function saveUserMessageAtomic(ctx: SaveUserMessageAdmittedCtx): SaveUserMessageSavedCtx {
  const { id, countsTowardsBadge } = ctx.deps.saveUserMessageWithAdmission(ctx);
  return { ...ctx, id, countsTowardsBadge };
}

function publishUserMessage(ctx: SaveUserMessageSavedCtx): SaveUserMessageSavedCtx {
  ctx.deps.runPostSaveSideEffects(ctx.sessionId, ctx.id, ctx.countsTowardsBadge);
  return ctx;
}

const runSaveUserMessage = (superpipe({})('save-user-message') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotUserMessage, 'ctx', 'ctx')
  .pipe(admitUserMessage, 'ctx', 'ctx')
  .pipe(saveUserMessageAtomic, 'ctx', 'ctx')
  .pipe(publishUserMessage, 'ctx', 'ctx')
  .end('ctx') as (ctx: SaveUserMessageCtx) => SaveUserMessageSavedCtx;

interface SaveHyperNeoActionMessageInput {
  sessionId: string;
  message: HyperNeoActionMessage;
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus | null;
}

interface SaveHyperNeoActionMessageSnapshot extends SaveHyperNeoActionMessageInput {
  id: string;
}

interface SaveHyperNeoActionMessageAdmitted extends SaveHyperNeoActionMessageSnapshot {
  admission: MessageAdmissionRecord;
}

interface SaveHyperNeoActionMessageSaved extends SaveHyperNeoActionMessageAdmitted {
  badgeUpdate: BadgeUpdateInstruction;
}

interface SaveHyperNeoActionMessageDeps {
  saveHyperNeoActionMessageWithAdmission(ctx: SaveHyperNeoActionMessageAdmitted): {
    id: string;
    badgeUpdate: BadgeUpdateInstruction;
  };
  notifySessionsChanged(sessionId: string): void;
  scheduleMessageSearchIndex(id: string): void;
}

type SaveHyperNeoActionMessageCtx = SaveHyperNeoActionMessageInput & {
  deps: SaveHyperNeoActionMessageDeps;
};
type SaveHyperNeoActionMessageSnapshotCtx = SaveHyperNeoActionMessageSnapshot &
  SaveHyperNeoActionMessageCtx;
type SaveHyperNeoActionMessageAdmittedCtx = SaveHyperNeoActionMessageAdmitted &
  SaveHyperNeoActionMessageCtx;
type SaveHyperNeoActionMessageSavedCtx = SaveHyperNeoActionMessageSaved &
  SaveHyperNeoActionMessageCtx;

function snapshotHyperNeoActionMessage(
  ctx: SaveHyperNeoActionMessageCtx
): SaveHyperNeoActionMessageSnapshotCtx {
  return { ...ctx, id: generateUUID() };
}

function admitHyperNeoActionMessage(
  ctx: SaveHyperNeoActionMessageSnapshotCtx
): SaveHyperNeoActionMessageAdmittedCtx {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: ctx.variant,
    sendStatus: ctx.sendStatus,
  });
  return { ...ctx, admission };
}

function saveHyperNeoActionMessageAtomic(
  ctx: SaveHyperNeoActionMessageAdmittedCtx
): SaveHyperNeoActionMessageSavedCtx {
  const { id, badgeUpdate } = ctx.deps.saveHyperNeoActionMessageWithAdmission(ctx);
  return { ...ctx, id, badgeUpdate };
}

function publishHyperNeoActionMessage(
  ctx: SaveHyperNeoActionMessageSavedCtx
): SaveHyperNeoActionMessageSavedCtx {
  if (ctx.badgeUpdate.kind === 'delta') ctx.deps.notifySessionsChanged(ctx.sessionId);
  ctx.deps.scheduleMessageSearchIndex(ctx.id);
  return ctx;
}

const runSaveHyperNeoActionMessage = (superpipe({})('save-hyperneo-action-message') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshotHyperNeoActionMessage, 'ctx', 'ctx')
  .pipe(admitHyperNeoActionMessage, 'ctx', 'ctx')
  .pipe(saveHyperNeoActionMessageAtomic, 'ctx', 'ctx')
  .pipe(publishHyperNeoActionMessage, 'ctx', 'ctx')
  .end('ctx') as (ctx: SaveHyperNeoActionMessageCtx) => SaveHyperNeoActionMessageSavedCtx;

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
      const rows = this.db.prepare(`PRAGMA table_xinfo(${tableName})`).all() as Array<{
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
    edges: SDKMessageReplacementEdge[]
  ): void {
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

  private admissionFeaturesCache: MessageSearchAdmissionSchemaFeatures | null = null;

  private admissionFeatures(): MessageSearchAdmissionSchemaFeatures {
    if (!this.admissionFeaturesCache) {
      this.admissionFeaturesCache = detectMessageSearchAdmissionFeatures(this.db);
    }
    return this.admissionFeaturesCache;
  }

  private upsertMessageSearchRow(rowId: string, now: number): void {
    if (!this.hasMessageSearchIndex()) return;
    const row = this.db
      .prepare(buildMessageSearchAdmissionLookupSql(this.admissionFeatures()))
      .get(rowId) as
      | (MessageSearchEligibilityRow & {
          id: string;
          task_id: string | null;
          message_type: string;
          sdk_message: string;
          timestamp: string;
          session_title: string | null;
          space_id: string | null;
          task_number: number | null;
        })
      | undefined;
    if (!row) return;

    let parsedMessage: SDKMessage | null = null;
    try {
      parsedMessage = JSON.parse(row.sdk_message) as SDKMessage;
    } catch {
      return;
    }
    const message = parsedMessage;
    const body = extractVisibleSearchText(message);
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND source_id = ?`)
      .run(row.id);
    const admission = decideMessageSearchAdmission({
      messageType: row.message_type,
      body,
      now,
      eligibility: row,
      isSuperseded: () => this.isMessageSuperseded(row.id, row.session_id, message),
      isSearchableUserStatus: () => this.isSearchableUserMessageStatus(row.id),
    });
    if (admission.action !== 'index') return;
    this.db
      .prepare(
        `INSERT INTO message_search_content (
					kind, source_id, message_id, session_id, task_id, space_id, task_number,
					message_type, title, body, timestamp
				) VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        (message as { uuid?: string }).uuid ?? row.id,
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

  private deleteMessageSearchRow(rowId: string): void {
    if (!this.hasMessageSearchIndex()) return;
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND source_id = ?`)
      .run(rowId);
  }

  private getSupersededMessageUuids(message: SDKMessage): string[] {
    return extractReplacementEdges(message).map((edge) => edge.targetUuid);
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
      this.upsertMessageSearchRow(messageId, Date.now());
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
        withBusyRetry(() => {
          this.db.transaction(() => {
            this.upsertMessageSearchRow(message_id, Date.now());
            deletePendingStmt.run(message_id);
          })();
        });
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

    return Boolean(this.db.prepare(MESSAGE_SUPERSEDED_PROBE_SQL).get(sessionId, rowId, sdkUuid));
  }

  private isSearchableUserMessageStatus(rowId: string): boolean {
    const row = this.db.prepare(SEARCHABLE_USER_STATUS_PROBE_SQL).get(rowId) as
      | { send_status: SendStatus }
      | undefined;
    return row?.send_status === 'consumed' || row?.send_status === 'failed';
  }

  private resolveTaskIdForSession(sessionId: string): string | null {
    if (this.reactiveDb) return this.reactiveDb.resolveTaskIdForSession(sessionId);
    return this.resolveTaskIdFromSessionsRow(sessionId);
  }

  private resolveTaskIdFromSessionsRow(sessionId: string): string | null {
    try {
      if (
        !this.tableExists('sessions') ||
        !this.tableHasColumn('sessions', 'task_id') ||
        !this.tableHasColumn('sessions', 'type')
      ) {
        return null;
      }
      const row = this.db
        .prepare(`SELECT task_id, type FROM sessions WHERE id = ?`)
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

  saveSDKMessage(
    sessionId: string,
    message: SDKMessage,
    origin?: MessageOrigin,
    options?: { stampInternalCompactionTurn?: boolean }
  ): boolean {
    try {
      const deps: SaveSdkMessageDeps = {
        saveSDKMessageWithAdmission: (ctx) => this.saveSDKMessageWithAdmission(ctx),
        notifySessionsChanged: (sessionId) => this.notifySessionsChanged(sessionId),
        deleteSupersededMessageSearchRows: (sessionId, message) =>
          this.deleteSupersededMessageSearchRows(sessionId, message),
        logger: this.logger,
      };
      runSaveSdkMessage({
        sessionId,
        message,
        variant: 'sdk',
        sendStatus: null,
        origin,
        stampInternalCompactionTurn: options?.stampInternalCompactionTurn === true,
        deps,
      });
      return true;
    } catch (error) {
      this.logger.error('[Database] Failed to save SDK message:', error);
      this.logger.error('[Database] Message type:', message.type, 'Session:', sessionId);
      return false;
    }
  }

  private saveSDKMessageWithAdmission(ctx: SaveSdkMessageAdmitted): { dbId: string } {
    const { sessionId, dbId, message, admission, badgeUpdate, origin } = ctx;
    const stampInternalCompactionTurn =
      ctx.stampInternalCompactionTurn === true && admission.isTerminal && message.type === 'result';
    const messageType = message.type;
    const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
    const timestamp = new Date().toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);

    const stmt = this.db.prepare(
      `INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, origin,
					is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
					sdk_uuid, replacement_metadata_normalized
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );

    const saveTransaction = this.db.transaction(() => {
      const conversationTurnIndex = this.resolveConversationTurnIndex(
        taskId,
        sessionId,
        admission.isConversationAnchor
      );
      const values = [
        dbId,
        sessionId,
        messageType,
        messageSubtype,
        JSON.stringify(message),
        timestamp,
        origin ?? null,
        admission.isRenderable,
        admission.isTerminal,
        admission.parentToolUseId,
        taskId,
      ];
      stmt.run(...values, conversationTurnIndex, admission.sdkUuid);
      if (admission.isTerminal && this.tableHasColumn('sdk_messages', 'consumed_seq')) {
        const resultSeq = this.nextConsumedSeq();
        if (resultSeq !== null) {
          this.db
            .prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE id = ?')
            .run(resultSeq, dbId);
        }
      }
      if (stampInternalCompactionTurn) {
        this.db
          .prepare(
            `UPDATE sdk_messages
                SET sdk_message = json_set(sdk_message, '$.internal_compaction_turn', 1)
              WHERE id = ?`
          )
          .run(dbId);
      }
      this.saveReplacementEdges(dbId, sessionId, taskId, admission.replacementEdges);
      this.scheduleMessageSearchIndex(dbId);
      this.applyBadgeUpdate(sessionId, badgeUpdate);
    });
    withBusyRetry(() => saveTransaction());
    return { dbId };
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

  getRenderableTextMessages(sessionId: string, limit = 20): Array<RenderableTextMessage> {
    const messages: Array<RenderableTextMessage> = [];
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
    const maxScan = resolveRenderableTextScanBudget(limit);
    let scanned = 0;

    while (messages.length < limit && scanned < maxScan) {
      const batchSize = Math.min(RENDERABLE_TEXT_MESSAGE_BATCH_SIZE, maxScan - scanned);
      const rows = stmt.all(sessionId, batchSize, scanned) as Array<RenderableTextMessageRow>;
      if (rows.length === 0) break;

      for (const row of rows) {
        const projected = projectRenderableTextRow(row);
        if (projected) messages.push(projected);
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
    let query = `SELECT id, sdk_message, timestamp, send_status, origin, rowid AS rowid FROM sdk_messages
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
    const rows = stmt.all(...params) as Array<PaginationMessageRow>;

    return composeMessagePage(rows, limit, (toolUseIds) => {
      const placeholders = toolUseIds.map(() => '?').join(',');
      const subagentQuery = `SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IN (${placeholders})
         AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        ORDER BY timestamp ASC, rowid ASC`;
      const subagentParams: SQLiteValue[] = [sessionId, ...toolUseIds];

      const subagentStmt = this.db.prepare(subagentQuery);
      return subagentStmt.all(...subagentParams) as Array<SubagentMessageRow>;
    });
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
      .all(
        sessionId,
        BACKGROUND_TASK_METADATA_BATCH_SIZE,
        sessionId,
        sessionId
      ) as Array<BackgroundTaskMessageRow>;

    return rows.map((row) => projectBackgroundTaskMessageRow(row)).reverse();
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
    return row ? inflatePersistedMessage(row) : null;
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

  private applyBadgeUpdate(sessionId: string, instruction: BadgeUpdateInstruction): boolean {
    if (instruction.kind === 'delta') {
      this.bumpVisibleMessageCount(sessionId, instruction.delta);
      return true;
    }
    if (instruction.kind === 'recompute') return this.recomputeVisibleMessageCount(sessionId);
    return false;
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
    const deps: SaveUserMessageDeps = {
      saveUserMessageWithAdmission: (ctx) => this.saveUserMessageWithAdmission(ctx),
      runPostSaveSideEffects: (sessionId, id, countsTowardsBadge) =>
        this.runPostSaveSideEffects(sessionId, id, countsTowardsBadge),
    };
    const ctx = runSaveUserMessage({
      sessionId,
      message,
      variant: 'user',
      sendStatus,
      origin,
      deps,
    });
    return ctx.id;
  }

  private saveUserMessageWithAdmission(ctx: SaveUserMessageAdmitted): {
    id: string;
    countsTowardsBadge: boolean;
  } {
    const saveTransaction = this.db.transaction(() =>
      this.saveUserMessageCoreWithAdmission(
        ctx.sessionId,
        ctx.id,
        ctx.message,
        ctx.sendStatus,
        ctx.origin,
        ctx.admission
      )
    );
    return withBusyRetry(() => saveTransaction());
  }

  saveUserMessageCore(
    sessionId: string,
    message: SDKMessage,
    sendStatus: SendStatus = 'consumed',
    origin?: MessageOrigin
  ): { id: string; countsTowardsBadge: boolean } {
    const id = generateUUID();
    const admission = decideMessageAdmission(normalizeMessageAdmissionInput(message), {
      variant: 'user',
      sendStatus,
      origin,
    });
    return this.saveUserMessageCoreWithAdmission(
      sessionId,
      id,
      message,
      sendStatus,
      origin,
      admission
    );
  }

  saveUserMessageCoreWithAdmission(
    sessionId: string,
    id: string,
    message: SDKMessage,
    sendStatus: SendStatus,
    origin: MessageOrigin | undefined,
    admission: MessageAdmissionRecord
  ): { id: string; countsTowardsBadge: boolean } {
    const messageType = message.type;
    const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
    const timestamp = new Date().toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);

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
      admission.isConversationAnchor
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
      admission.isRenderable,
      admission.isTerminal,
      admission.parentToolUseId,
      taskId,
    ];
    stmt.run(...values, conversationTurnIndex, admission.sdkUuid);
    this.saveReplacementEdges(id, sessionId, taskId, admission.replacementEdges);
    this.scheduleMessageSearchIndex(id);
    this.applyBadgeUpdate(sessionId, planAdmissionBadgeUpdate(admission));
    return { id, countsTowardsBadge: admission.countsTowardsBadge };
  }

  runPostSaveSideEffects(sessionId: string, id: string, countsTowardsBadge: boolean): void {
    if (!this.reactiveDb?.willEmitTableChange?.('sdk_messages')) {
      this.reactiveDb?.notifyChange('sdk_messages', { sessionId });
    }
    if (countsTowardsBadge) this.notifySessionsChanged(sessionId);
  }

  getUserMessagesByStatus(
    sessionId: string,
    status: SendStatus,
    limit?: number,
    direction: 'asc' | 'desc' = 'asc'
  ): {
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
    total: number;
  } {
    const countRow =
      limit !== undefined
        ? (this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM sdk_messages
               WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}`
            )
            .get(sessionId, status) as { count: number })
        : null;
    const order = direction === 'desc' ? 'DESC' : 'ASC';
    let projectionSql = `SELECT rowid AS row_id FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}
         ORDER BY timestamp ${order}, rowid ${order}`;
    if (limit !== undefined) projectionSql += `\n         LIMIT ?`;
    const projected =
      limit !== undefined
        ? (this.db.prepare(projectionSql).all(sessionId, status, limit) as Array<{
            row_id: number;
          }>)
        : (this.db.prepare(projectionSql).all(sessionId, status) as Array<{ row_id: number }>);
    const messagesByRowId = new Map<number, SDKUserMessage & { dbId: string; timestamp: number }>();

    for (const { rowIds, placeholders } of buildRowIdHydrationBatches(projected)) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS row_id, id, sdk_message, timestamp FROM sdk_messages
           WHERE rowid IN (${placeholders})`
        )
        .all(...rowIds) as Array<{
        row_id: number;
        id: string;
        sdk_message: string;
        timestamp: string;
      }>;
      for (const row of rows) {
        messagesByRowId.set(
          row.row_id,
          inflatePersistedMessage(row) as SDKUserMessage & {
            dbId: string;
            timestamp: number;
          }
        );
      }
    }

    const messages = orderHydratedMessages(projected, messagesByRowId);
    return { messages, total: countRow ? countRow.count : messages.length };
  }

  listUserMessagesByUuidPrefix(
    sessionId: string,
    prefix: string
  ): Array<SDKUserMessage & { dbId: string; timestamp: number; sendStatus: string }> {
    const pageSize = 100;
    const messages: Array<
      SDKUserMessage & { dbId: string; timestamp: number; sendStatus: string }
    > = [];
    let offset = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT id, sdk_message, timestamp, COALESCE(send_status, 'consumed') AS send_status FROM sdk_messages
	       WHERE session_id = ?
	         AND message_type = 'user'
	         AND sdk_uuid LIKE ? || '%'
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT ? OFFSET ?`
        )
        .all(sessionId, prefix, pageSize, offset) as Array<{
        id: string;
        sdk_message: string;
        timestamp: string;
        send_status: string;
      }>;
      messages.push(
        ...rows.map(
          (row) =>
            ({
              ...inflatePersistedMessage(row),
              sendStatus: row.send_status,
            }) as SDKUserMessage & { dbId: string; timestamp: number; sendStatus: string }
        )
      );
      if (rows.length < pageSize) return messages;
      offset += pageSize;
    }
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
	       ORDER BY timestamp ASC, rowid ASC
	       LIMIT 1`
    );
    const row = stmt.get(sessionId, status, uuid) as {
      id: string;
      sdk_message: string;
      timestamp: string;
    } | null;
    return row ? inflatePersistedMessage(row) : null;
  }

  getMessageByStatusAndDbId(
    sessionId: string,
    status: SendStatus,
    dbId: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    const row = this.db
      .prepare(
        `SELECT id, sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND id = ?
         LIMIT 1`
      )
      .get(sessionId, status, dbId) as {
      id: string;
      sdk_message: string;
      timestamp: string;
    } | null;
    return row ? inflatePersistedMessage(row) : null;
  }

  getUserMessageIdsByStatus(
    sessionId: string,
    status: SendStatus
  ): Array<{ dbId: string; uuid: string | undefined; timestamp: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, sdk_uuid, timestamp FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}
         ORDER BY timestamp ASC, rowid ASC`
      )
      .all(sessionId, status) as Array<{
      id: string;
      sdk_uuid: string | null;
      timestamp: string;
    }>;
    return rows.map((row) => ({
      dbId: row.id,
      uuid: row.sdk_uuid ?? undefined,
      timestamp: new Date(row.timestamp).getTime(),
    }));
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
                  AND send_status IN (${PENDING_ROW_FROM_STATUSES.map(() => '?').join(', ')})
                ORDER BY rowid ASC`
            )
            .all(...messageIds, ...PENDING_ROW_FROM_STATUSES) as Array<{
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
    const plan = planMessageStatusApplication(
      pending.map((row) => ({
        rowId: row.id,
        taskId: row.task_id,
        isRenderable: row.is_renderable === 1,
      })),
      newStatus,
      options
    );
    const changedSessions: string[] = [];
    const badgeUpdate = planBadgeRecompute();
    const statusTransaction = this.db.transaction(() => {
      applyMessageStatusPlan(this.db, plan, messageIds, () => this.nextConsumedSeq());

      for (const { sid } of affectedSessions) {
        if (this.applyBadgeUpdate(sid, badgeUpdate)) changedSessions.push(sid);
      }
    });
    withBusyRetry(() => statusTransaction());
    for (const sid of changedSessions) this.notifySessionsChanged(sid);
    for (const messageId of messageIds) this.scheduleMessageSearchIndex(messageId);
  }

  transitionMessageSendStatus(
    messageId: string,
    expectedStatus: SendStatus,
    targetStatus: SendStatus
  ): boolean {
    let changed = false;
    let notifySid: string | null = null;
    const transitionTransaction = this.db.transaction(() => {
      changed =
        this.db
          .prepare(`UPDATE sdk_messages SET send_status = ? WHERE id = ? AND send_status = ?`)
          .run(targetStatus, messageId, expectedStatus).changes > 0;
      if (!changed) return;
      const row = this.db
        .prepare(`SELECT session_id AS sid FROM sdk_messages WHERE id = ?`)
        .get(messageId) as { sid: string } | undefined;
      if (row && this.applyBadgeUpdate(row.sid, planBadgeRecompute())) {
        notifySid = row.sid;
      }
    });
    withBusyRetry(() => transitionTransaction());
    if (changed) this.scheduleMessageSearchIndex(messageId);
    if (notifySid !== null) this.notifySessionsChanged(notifySid);
    return changed;
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
      if (deleted) this.applyBadgeUpdate(sessionId, planBadgeRecompute());
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
        `SELECT id, sdk_message, send_status FROM sdk_messages
          WHERE session_id = ? AND id = ? AND message_type = 'user'
          LIMIT 1`
      )
      .get(sessionId, messageId) as
      | { id: string; sdk_message: string; send_status: string | null }
      | undefined;
    if (!row) return null;
    const routing = routeDeliveryTransition(row.send_status, 'defer');
    if (!routing.accepted) return null;
    const changed = this.db
      .prepare(
        `UPDATE sdk_messages SET send_status = ?
          WHERE session_id = ? AND id = ? AND message_type = 'user'
            AND send_status = ?`
      )
      .run(routing.targetStatus, sessionId, messageId, row.send_status).changes;
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

  private deleteMessagesFromTimestamp(
    sessionId: string,
    timestamp: number,
    comparison: TimestampComparison
  ): number {
    const isoTimestamp = new Date(timestamp).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp ${comparison} ?`
      )
      .all(sessionId, isoTimestamp) as Array<{ id: string; sdk_uuid: string | null }>;
    const stmt = this.db.prepare(
      `DELETE FROM sdk_messages WHERE session_id = ? AND timestamp ${comparison} ?`
    );
    let deleted = 0;
    let badgeChanged = false;
    this.db.transaction(() => {
      deleted = stmt.run(sessionId, isoTimestamp).changes;
      badgeChanged = this.applyBadgeUpdate(sessionId, planBadgeRecompute());
      for (const { sdk_uuid } of rows) {
        if (sdk_uuid) this.clearDeliveryTurnEnd(sessionId, sdk_uuid);
      }
    })();
    if (badgeChanged) this.notifySessionsChanged(sessionId);
    for (const row of rows) this.deleteMessageSearchRow(row.id);
    return deleted;
  }

  deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
    return this.deleteMessagesFromTimestamp(sessionId, afterTimestamp, '>');
  }

  deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
    return this.deleteMessagesFromTimestamp(sessionId, atTimestamp, '>=');
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

      return {
        uuid: (message as { uuid?: string }).uuid || '',
        timestamp,
        content: extractFirstTextBlockContent(message),
      };
    });
  }

  getUserMessageByUuid(
    sessionId: string,
    uuid: string
  ): { uuid: string; timestamp: number; content: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'user'
           AND sdk_uuid = ?
         ORDER BY timestamp ASC, rowid ASC
         LIMIT 1`
      )
      .get(sessionId, uuid) as { sdk_message: string; timestamp: string } | undefined;
    if (!row) return undefined;
    return this.parseUserMessageRow(row, uuid);
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
    const row = this.db.prepare(HAS_TERMINAL_RESULT_AFTER_SQL).get(sessionId, sessionId, uuid) as
      | { 1: number }
      | undefined
      | null;
    return row != null;
  }

  markResultRecoveryIntercepted(sessionId: string, sdkUuid: string, billingTerminal = false): void {
    this.db
      .prepare(
        `UPDATE sdk_messages
            SET sdk_message = json_set(
              sdk_message,
              '$.recovery_intercepted', 1,
              '$.recovery_billing_terminal', ?
            )
          WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'result'`
      )
      .run(billingTerminal ? 1 : 0, sessionId, sdkUuid);
  }

  markResultInternalCompactionTurn(sessionId: string, sdkUuid: string): void {
    withBusyRetry(() =>
      this.db
        .prepare(
          `UPDATE sdk_messages
              SET sdk_message = json_set(sdk_message, '$.internal_compaction_turn', 1)
            WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'result'`
        )
        .run(sessionId, sdkUuid)
    );
  }

  hasRecoveryInterceptedResultAfter(sessionId: string, uuid: string): boolean {
    const row = this.db
      .prepare(HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL)
      .get(sessionId, sessionId, uuid) as { 1: number } | undefined | null;
    return row != null;
  }

  getErrorTerminalResultSubtypeAfter(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(GET_ERROR_TERMINAL_RESULT_SUBTYPE_AFTER_SQL)
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

  private markDeliveryTransitionByUuid(
    sessionId: string,
    uuid: string,
    action: DeliveryTransitionAction
  ): string | null {
    const { acceptedFrom, target } = deliveryTransitionRule(action);
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
             AND send_status IN (${acceptedFrom.map(() => '?').join(', ')})
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid, ...acceptedFrom) as { id: string } | undefined;
    if (!row) return null;
    this.updateMessageStatus([row.id], target);
    return row.id;
  }

  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'fail');
  }

  markDeliveryFailedByUuidInclusive(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'fail_inclusive');
  }

  markDeliveryConsumedByUuid(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'consume');
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
               AND COALESCE(json_extract(sdk_message, '$.internal_compaction_turn'), 0) = 0
             LIMIT 1`
        )
        .get(sessionId, resultUuid) as { consumed_seq: number } | undefined;
      if (!result) return { ids: [], uuids: [] };
      const { acceptedFrom, target } = deliveryTransitionRule('consume');
      const ids: string[] = [];
      const consumedUuids: string[] = [];
      for (const [index, uuid] of [...new Set(uuids)].entries()) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status IN (${acceptedFrom.map(() => '?').join(', ')})
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid, ...acceptedFrom) as { id: string } | undefined;
        if (index === 0 && !row) return { ids: [], uuids: [] };
        if (row) {
          ids.push(row.id);
          consumedUuids.push(uuid);
        }
      }
      this.updateMessageStatus(ids, target, {
        sharedTurn: true,
        consumedSeq: result.consumed_seq,
      });
      return { ids, uuids: consumedUuids };
    })();
  }

  markDeliveryConsumedByUuids(sessionId: string, uuids: string[]): string[] {
    return this.db.transaction(() => {
      const { acceptedFrom, target } = deliveryTransitionRule('consume');
      const ids: string[] = [];
      for (const uuid of new Set(uuids)) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status IN (${acceptedFrom.map(() => '?').join(', ')})
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid, ...acceptedFrom) as { id: string } | undefined;
        if (row) ids.push(row.id);
      }
      this.updateMessageStatus(ids, target, { sharedTurn: true });
      return ids;
    })();
  }

  markDeliverySubmittedByUuids(sessionId: string, uuids: string[]): string[] {
    return this.db.transaction(() => {
      const { acceptedFrom, target } = deliveryTransitionRule('submit');
      const ids: string[] = [];
      for (const uuid of new Set(uuids)) {
        const row = this.db
          .prepare(
            `SELECT id FROM sdk_messages
               WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                 AND send_status IN (${acceptedFrom.map(() => '?').join(', ')})
               ORDER BY timestamp ASC LIMIT 1`
          )
          .get(sessionId, uuid, ...acceptedFrom) as { id: string } | undefined;
        if (!row) continue;
        this.updateMessageStatus([row.id], target);
        ids.push(row.id);
      }
      return ids;
    })();
  }

  getDeliveryMessageIdsByUuids(sessionId: string, uuids: string[]): string[] {
    if (uuids.length === 0) return [];
    const uniqueUuids = [...new Set(uuids)];
    const placeholders = uniqueUuids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid IN (${placeholders})`
      )
      .all(sessionId, ...uniqueUuids) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  reopenDeliveryByUuid(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'reopen');
  }

  markDeliveryRetryableByUuid(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'retry');
  }

  markDeliveryDeferredByUuid(sessionId: string, uuid: string): string | null {
    return this.markDeliveryTransitionByUuid(sessionId, uuid, 'defer');
  }

  private parseUserMessageRow(
    row: { sdk_message: string; timestamp: string },
    uuid: string
  ): { uuid: string; timestamp: number; content: string } {
    const message = JSON.parse(row.sdk_message) as SDKMessage;
    const timestamp = new Date(row.timestamp).getTime();

    return { uuid, timestamp, content: extractFirstTextBlockContent(message) };
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
      const text = extractVisibleText(msg);
      const toolCallNames = extractToolCallNames(msg);
      return { id: row.id, text, toolCallNames };
    });
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
    const deps: SaveHyperNeoActionMessageDeps = {
      saveHyperNeoActionMessageWithAdmission: (ctx) =>
        this.saveHyperNeoActionMessageWithAdmission(ctx),
      notifySessionsChanged: (sessionId) => this.notifySessionsChanged(sessionId),
      scheduleMessageSearchIndex: (id) => this.scheduleMessageSearchIndex(id),
    };
    const ctx = runSaveHyperNeoActionMessage({
      sessionId,
      message,
      variant: 'hyperneo_action',
      sendStatus: null,
      deps,
    });
    return ctx.id;
  }

  private saveHyperNeoActionMessageWithAdmission(ctx: SaveHyperNeoActionMessageAdmitted): {
    id: string;
    badgeUpdate: BadgeUpdateInstruction;
  } {
    const { sessionId, id, message, admission } = ctx;
    const badgeUpdate = planAdmissionBadgeUpdate(admission);
    const timestamp = new Date(message.timestamp).toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);
    const conversationTurnIndex = this.resolveConversationTurnIndex(
      taskId,
      sessionId,
      admission.isConversationAnchor
    );

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
      insertStmt.run(...values, conversationTurnIndex, admission.sdkUuid);
      this.applyBadgeUpdate(sessionId, badgeUpdate);
    })();
    return { id, badgeUpdate };
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
				msc.id,
				${broadQuery ? '0' : 'bm25(message_search_fts)'} AS rank,
				msc.timestamp,
				msc.source_id
			FROM message_search_fts
			JOIN message_search_content msc ON msc.id = message_search_fts.rowid
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
      id: number;
      rank: number;
    }>;
    if (candidates.length === 0) return { results: [], limit, offset };

    const rankById = new Map(candidates.map((row) => [row.id, row.rank]));
    const orderById = new Map(candidates.map((row, index) => [row.id, index]));
    const placeholders = candidates.map(() => '?').join(', ');
    const rawRows = this.db
      .prepare(
        `
				SELECT
					msc.id, msc.kind, msc.source_id, msc.message_id, msc.session_id, msc.task_id,
					msc.space_id, msc.task_number, msc.message_type, msc.title,
					snippet(message_search_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
					msc.timestamp
				FROM message_search_fts
				JOIN message_search_content msc ON msc.id = message_search_fts.rowid
				WHERE message_search_fts.rowid IN (${placeholders})
				  AND message_search_fts MATCH ?`
      )
      .all(...candidates.map((row) => row.id), ftsQuery) as Array<{
      id: number;
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
    const seenId = new Set<number>();
    const rows = rawRows.filter((row) => {
      if (seenId.has(row.id)) return false;
      seenId.add(row.id);
      return true;
    });

    const results: MessageSearchResult[] = rows
      .sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0))
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
          rank: rankById.get(row.id) ?? 0,
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
