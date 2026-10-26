import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { SessionRepository } from './session-repository.ts';
import type { RunDbOp } from '../db-gateway/db-op.ts';
import { sdkMessageWrites } from './sdk-message-writes.ts';
import type { SdkMessageWriteMethod } from './sdk-message-writes.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { toSqlStringList } from '../sql-string-list.ts';
import type {
  ChatMessage,
  HyperNeoActionMessage,
  MessageContent,
  MessageDeliveryStatus,
  MessageInputKind,
  MessageOrigin,
  ReferenceMetadata,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../../lib/logger.ts';
import {
  type MailboxMessage,
  type MailboxMessageContent,
  toMailboxMessage,
} from '../../lib/mailbox/entry.ts';
import { withBusyRetry } from '../busy-retry.ts';
import { writeSdkMessageBody } from './sdk-message-body-write.ts';
import { hydrateSdkMessageBodies } from './sdk-message-body-read.ts';
import {
  buildFtsQuery,
  extractVisibleSearchText,
  isBroadMessageSearchQuery,
  type MessageSearchParams,
  type MessageSearchResponse,
  type MessageSearchResult,
  messageSearchPolicy,
} from '../message-search.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { createSQLiteAsciiPrefixRange } from '../sqlite-prefix-range.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import { deriveSdkMessageColumns, SDK_MESSAGE_COLUMN_TYPES } from '../sdk-message-columns.ts';
import {
  searchWorkChats as queryWorkChats,
  type WorkChatKind,
  type WorkChatMatch,
} from '../work-chat-search.ts';
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
  type SDKMessageProjection,
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

type UserStatusMessage = SDKUserMessage & { dbId: string; timestamp: number };

const USER_STATUS_MESSAGE_SQL = `message_type = 'user'
  AND user_status_eligible = 1`;

const LAST_MESSAGE_PROGRESS_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated']);
const BACKGROUND_TASK_METADATA_SUBTYPES = ['task_started', 'task_updated', 'task_notification'];
const BACKGROUND_TASK_METADATA_BATCH_SIZE = 300;

const EXCLUDED_FROM_PAGINATION_SQL_LIST = toSqlStringList([
  ...HIDDEN_SYSTEM_SUBTYPES,
  'thinking_tokens',
]);

const BACKGROUND_TASK_METADATA_SQL_LIST = toSqlStringList([...BACKGROUND_TASK_METADATA_SUBTYPES]);

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
            AND COALESCE(r.internal_compaction_turn, 0) = 0
            AND NOT (
              COALESCE(r.is_error, 0) = 1
              AND COALESCE(r.recovery_intercepted, 0) = 1
              AND COALESCE(r.recovery_billing_terminal, 0) = 0
            )
          LIMIT 1`;

const GET_TURN_ERROR_RESULT_SUBTYPE_SQL = `WITH brief AS (
            SELECT m.consumed_seq AS seq FROM sdk_messages m
             WHERE m.session_id = ?1 AND m.sdk_uuid = ?2 AND m.consumed_seq IS NOT NULL
             ORDER BY m.consumed_seq DESC LIMIT 1
          ), next_input AS (
            SELECT MIN(u.consumed_seq) AS seq FROM sdk_messages u, brief
             WHERE u.session_id = ?1
               AND u.message_type = 'user'
               AND u.sdk_uuid != ?2
               AND u.consumed_seq > brief.seq
          )
          SELECT CASE
            WHEN r.message_subtype != 'success' THEN r.message_subtype
            WHEN COALESCE(r.is_error, 0) = 1 THEN 'error'
            ELSE NULL END AS subtype
           FROM sdk_messages r, brief, next_input
          WHERE r.session_id = ?1
            AND r.message_type = 'result'
            AND r.is_terminal = 1
            AND r.message_subtype IS NOT NULL
            AND r.parent_tool_use_id IS NULL
            AND r.consumed_seq > brief.seq
            AND (next_input.seq IS NULL OR r.consumed_seq < next_input.seq)
            AND COALESCE(r.internal_compaction_turn, 0) = 0
            AND NOT (
              COALESCE(r.recovery_intercepted, 0) = 1
              AND COALESCE(r.recovery_billing_terminal, 0) = 0
            )
          ORDER BY r.consumed_seq DESC
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
            AND COALESCE(r.recovery_intercepted, 0) = 1
            AND COALESCE(r.recovery_billing_terminal, 0) = 0
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
  return hydrateSdkMessageBodies(`SELECT sm.id, sm.session_id, sm.task_id, sm.message_type, sm.rowid AS body_seq, sm.timestamp,
					${sessionTitleSelect}, ${sessionPolicySelect}, ${spaceTaskSelect}
			 FROM sdk_messages sm
			 ${sessionJoin}
			 ${spaceTaskJoin}
			 WHERE sm.id = ?`);
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

interface NormalizeDeliveryMessageDeps {
  selectDeliveryMessageRow(
    sessionId: string,
    uuid: string
  ): { id: string; sdk_message: string; origin: string | null } | null | undefined;
  applyNormalizedDeliveryMessage(rowId: string, sdkMessage: string, synthetic: boolean): number;
}

interface NormalizeDeliveryMessageCtx {
  sessionId: string;
  uuid: string;
  deps: NormalizeDeliveryMessageDeps;
  changed: boolean;
  row?: { id: string; sdk_message: string; origin: string | null };
  stored?: Record<string, unknown>;
  normalized?: Record<string, unknown>;
  synthetic?: boolean;
}

function loadDeliveryMessageRow(ctx: NormalizeDeliveryMessageCtx): NormalizeDeliveryMessageCtx {
  return { ...ctx, row: ctx.deps.selectDeliveryMessageRow(ctx.sessionId, ctx.uuid) ?? undefined };
}

function parseDeliveryMessageRow(ctx: NormalizeDeliveryMessageCtx): NormalizeDeliveryMessageCtx {
  let stored: unknown;
  try {
    stored = JSON.parse(ctx.row?.sdk_message ?? '');
  } catch {
    return ctx;
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return ctx;
  return { ...ctx, stored: stored as Record<string, unknown> };
}

function projectDeliveryMessageRow(ctx: NormalizeDeliveryMessageCtx): NormalizeDeliveryMessageCtx {
  if (ctx.stored === undefined) return ctx;
  const stored = ctx.stored;
  if (stored.type !== 'user') return ctx;
  const storedMessage = stored.message as { role?: unknown; content?: unknown } | undefined;
  if (storedMessage?.role !== 'user') return ctx;
  if (stored.isReplay === true) return ctx;
  const synthetic =
    stored.isSynthetic === true ||
    (stored.isSynthetic === undefined && ctx.row?.origin === 'system');
  const storedInputKind = stored.inputKind;
  const inputKind: MessageInputKind =
    typeof storedInputKind === 'string' && ['task', 'human', 'system'].includes(storedInputKind)
      ? (storedInputKind as MessageInputKind)
      : synthetic
        ? 'task'
        : 'human';
  const projected = toMailboxMessage({
    type: 'user',
    message: { content: storedMessage.content as MailboxMessageContent },
    parent_tool_use_id: (stored.parent_tool_use_id ?? null) as MailboxMessage['parent_tool_use_id'],
    ...(stored.priority !== undefined
      ? { priority: stored.priority as MailboxMessage['priority'] }
      : {}),
    ...(stored.referenceMetadata !== undefined
      ? { referenceMetadata: stored.referenceMetadata as ReferenceMetadata }
      : {}),
  });
  if ('reason' in projected) return ctx;
  return {
    ...ctx,
    synthetic,
    normalized: {
      ...projected.message,
      inputKind,
      uuid: ctx.uuid,
      session_id: ctx.sessionId,
      ...(synthetic ? { isSynthetic: true } : {}),
    },
  };
}

function applyDeliveryMessageRow(ctx: NormalizeDeliveryMessageCtx): NormalizeDeliveryMessageCtx {
  if (ctx.row === undefined || ctx.normalized === undefined) return ctx;
  const changes = ctx.deps.applyNormalizedDeliveryMessage(
    ctx.row.id,
    JSON.stringify(ctx.normalized),
    ctx.synthetic === true
  );
  return { ...ctx, changed: changes > 0 };
}

function deliveryMessageRowAbsent(ctx: NormalizeDeliveryMessageCtx): boolean {
  return ctx.row === undefined;
}

function deliveryMessageStoredAbsent(ctx: NormalizeDeliveryMessageCtx): boolean {
  return ctx.stored === undefined;
}

function deliveryMessageNormalizedAbsent(ctx: NormalizeDeliveryMessageCtx): boolean {
  return ctx.normalized === undefined;
}

const runNormalizeDeliveryMessageForMailbox = (
  superpipe<{
    deliveryMessageRowAbsent: (ctx: NormalizeDeliveryMessageCtx) => boolean;
    deliveryMessageStoredAbsent: (ctx: NormalizeDeliveryMessageCtx) => boolean;
    deliveryMessageNormalizedAbsent: (ctx: NormalizeDeliveryMessageCtx) => boolean;
  }>({
    deliveryMessageRowAbsent,
    deliveryMessageStoredAbsent,
    deliveryMessageNormalizedAbsent,
  })('normalize-delivery-message-for-mailbox') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadDeliveryMessageRow, 'ctx', 'ctx')
  .pipe('!deliveryMessageRowAbsent', 'ctx')
  .pipe(parseDeliveryMessageRow, 'ctx', 'ctx')
  .pipe('!deliveryMessageStoredAbsent', 'ctx')
  .pipe(projectDeliveryMessageRow, 'ctx', 'ctx')
  .pipe('!deliveryMessageNormalizedAbsent', 'ctx')
  .pipe(applyDeliveryMessageRow, 'ctx', 'ctx')
  .end('ctx') as (ctx: NormalizeDeliveryMessageCtx) => NormalizeDeliveryMessageCtx;

export type SdkMessageChanges = Pick<
  ReactiveDatabase,
  'notifyChange' | 'willEmitTableChange' | 'resolveTaskIdForSession'
>;

export class SDKMessageRepository {
  private logger = new Logger('Database');

  private tableExistsCache = new Map<string, boolean>();
  private tableColumnsCache = new Map<string, Set<string> | null>();

  constructor(
    private db: BunDatabase,
    private reactiveDb?: SdkMessageChanges
  ) {}

  sessionExists(sessionId: string): boolean {
    return new SessionRepository(this.db).getSession(sessionId) !== null;
  }

  readonly runWrite: RunDbOp = (op, args) => gatewayFor(this.db).run(op, args);
  write<K extends SdkMessageWriteMethod>(
    method: K,
    ...args: Parameters<SDKMessageRepository[K]>
  ): Promise<ReturnType<SDKMessageRepository[K]>> {
    return this.runWrite(sdkMessageWrites, { method, args }) as Promise<
      ReturnType<SDKMessageRepository[K]>
    >;
  }

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

  private derivedColumns(
    message: unknown,
    taskId: string | null = null,
    keys: (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[] = Object.keys(
      SDK_MESSAGE_COLUMN_TYPES
    ) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[]
  ) {
    const derived = deriveSdkMessageColumns(message, taskId);
    const names = this.tableHasColumn('sdk_messages', 'input_kind') ? keys : [];
    return {
      insert: names.length ? `, ${names.join(', ')}` : '',
      placeholders: ', ?'.repeat(names.length),
      update: names.length
        ? `, ${names.map((name) => `${name} = ${name === 'bg_task_id' ? 'COALESCE(?, task_id)' : '?'}`).join(', ')}`
        : '',
      values: names.map((name) => derived[name]),
    };
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

  flushMessageSearchIndex(limit = 500, skip = 0): { attempted: number; failed: number } {
    if (!this.hasMessageSearchIndex()) return { attempted: 0, failed: 0 };
    if (!this.tableExists('message_search_pending')) return { attempted: 0, failed: 0 };
    const pending = this.db
      .prepare(`SELECT message_id FROM message_search_pending ORDER BY created_at LIMIT ? OFFSET ?`)
      .all(limit, skip) as Array<{ message_id: string }>;
    const deletePendingStmt = this.db.prepare(
      `DELETE FROM message_search_pending WHERE message_id = ?`
    );
    let failed = 0;
    for (const { message_id } of pending) {
      try {
        withBusyRetry(() => {
          this.db.transaction(() => {
            this.upsertMessageSearchRow(message_id, Date.now());
            deletePendingStmt.run(message_id);
          })();
        });
      } catch (err) {
        failed++;
        this.logger.warn('message search index flush failed, will retry next flush:', err);
      }
    }
    return { attempted: pending.length, failed };
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
      const allowedTypes = ['worker'];
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
    const storedMessage = stampInternalCompactionTurn
      ? { ...message, internal_compaction_turn: 1 }
      : message;
    const messageType = message.type;
    const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
    const timestamp = new Date().toISOString();
    const taskId = this.resolveTaskIdForSession(sessionId);

    const derived = this.derivedColumns(storedMessage, taskId);

    const stmt = this.db.prepare(
      `INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, origin,
					is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
					sdk_uuid, replacement_metadata_normalized${derived.insert}
				) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1${derived.placeholders})`
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
        timestamp,
        origin ?? null,
        admission.isRenderable,
        admission.isTerminal,
        admission.parentToolUseId,
        taskId,
      ];
      writeSdkMessageBody(
        this.db,
        () => stmt.run(...values, conversationTurnIndex, admission.sdkUuid, ...derived.values),
        'id = ?',
        [dbId],
        '?',
        [JSON.stringify(storedMessage)]
      );
      if (admission.isTerminal && this.tableHasColumn('sdk_messages', 'consumed_seq')) {
        const resultSeq = this.nextConsumedSeq();
        if (resultSeq !== null) {
          this.db
            .prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE id = ?')
            .run(resultSeq, dbId);
        }
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
    sinceRowid?: number,
    project?: SDKMessageProjection
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
      sinceRowid,
      project
    );
  }

  getRenderableTextMessages(sessionId: string, limit = 20): Array<RenderableTextMessage> {
    const messages: Array<RenderableTextMessage> = [];
    const stmt = this.db.prepare(
      hydrateSdkMessageBodies(
        `SELECT id, message_type, rowid AS body_seq, timestamp FROM sdk_messages
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
			 LIMIT ? OFFSET ?`,
        'body_selection.timestamp DESC, body_selection.body_seq DESC'
      )
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
    sinceRowid?: number,
    project?: SDKMessageProjection
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
    let query = `SELECT id, rowid AS body_seq, timestamp, send_status, origin, rowid AS rowid FROM sdk_messages
      WHERE session_id = ?
        AND parent_tool_use_id IS NULL
        AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
        AND (
          message_type != 'system'
          OR COALESCE(message_subtype, '') != 'informational'
          OR COALESCE(info_level, 0) != 1
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
                OR (newer.timestamp = sdk_messages.timestamp AND newer.rowid > sdk_messages.rowid)
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

    const stmt = this.db.prepare(
      project
        ? query
        : hydrateSdkMessageBodies(
            query,
            'body_selection.timestamp DESC, body_selection.body_seq DESC'
          )
    );
    const rows = (
      project
        ? this.hydratePageRows(
            stmt.iterate(...params) as Iterable<
              Omit<PaginationMessageRow, 'sdk_message'> & { body_seq: number }
            >
          )
        : stmt.all(...params)
    ) as Iterable<PaginationMessageRow>;

    const fetchSubagentRows = (toolUseIds: string[]) => {
      const placeholders = toolUseIds.map(() => '?').join(',');
      const metadataQuery = `SELECT id, rowid AS body_seq, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IN (${placeholders})
         AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        ORDER BY +timestamp ASC, rowid ASC`;
      const subagentQuery = project
        ? metadataQuery
        : hydrateSdkMessageBodies(
            metadataQuery,
            'body_selection.timestamp ASC, body_selection.body_seq ASC'
          );
      const subagentParams: SQLiteValue[] = [sessionId, ...toolUseIds];

      const subagentStmt = this.db.prepare(subagentQuery);
      return (
        project
          ? this.hydratePageRows(
              subagentStmt.iterate(...subagentParams) as Iterable<
                Omit<SubagentMessageRow, 'sdk_message'> & { body_seq: number }
              >
            )
          : subagentStmt.all(...subagentParams)
      ) as Iterable<SubagentMessageRow>;
    };
    return composeMessagePage(rows, limit, fetchSubagentRows, project);
  }

  private *hydratePageRows<T extends { body_seq: number }>(rows: Iterable<T>) {
    const body = this.db.prepare(
      hydrateSdkMessageBodies('SELECT rowid AS body_seq FROM sdk_messages WHERE rowid = ?')
    );
    for (const row of rows) {
      const stored = body.get(row.body_seq) as { sdk_message: string };
      yield { ...row, sdk_message: stored.sdk_message };
    }
  }

  getMessageByUuid(sessionId: string, messageUuid: string): SDKMessage | null {
    const row = this.db
      .prepare(
        hydrateSdkMessageBodies(
          'SELECT rowid AS body_seq FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ? LIMIT 1'
        )
      )
      .get(sessionId, messageUuid) as { sdk_message: string } | null;
    return row ? (JSON.parse(row.sdk_message) as SDKMessage) : null;
  }

  getBackgroundTaskMessages(sessionId: string): Array<ChatMessage & { timestamp: number }> {
    const rows = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `WITH recent_metadata AS (
           SELECT
             id,
             rowid AS body_seq,
             timestamp,
             origin,
             rowid,
             COALESCE(bg_task_id, task_id) AS task_id
           FROM sdk_messages
           WHERE session_id = ?
             AND parent_tool_use_id IS NULL
             AND message_subtype_norm IN (${BACKGROUND_TASK_METADATA_SQL_LIST})
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
             rowid AS body_seq,
             timestamp,
             origin,
             rowid,
             COALESCE(bg_task_id, task_id) AS task_id
           FROM sdk_messages
           WHERE session_id = ?
             AND parent_tool_use_id IS NULL
             AND message_subtype_norm = 'task_started'
             AND COALESCE(bg_task_id, task_id) IN (SELECT task_id FROM recent_task_ids)
             AND id NOT IN (SELECT id FROM recent_metadata)
         ),
         latest_progress AS (
           SELECT
             id,
             rowid AS body_seq,
             timestamp,
             origin,
             rowid,
             task_id
           FROM (
             SELECT
               id,
               rowid AS body_seq,
               timestamp,
               origin,
               rowid,
               COALESCE(bg_task_id, task_id) AS task_id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(
                   bg_tool_use_id,
                   ''
                 )
                 ORDER BY timestamp DESC, rowid DESC
               ) AS rn
             FROM sdk_messages
             WHERE session_id = ?
               AND parent_tool_use_id IS NULL
               AND message_subtype_norm = 'task_progress'
               AND COALESCE(
                 bg_tool_use_id,
                 ''
               ) != ''
           )
           WHERE rn = 1
         )
         SELECT id, rowid AS body_seq, timestamp, origin
         FROM (
           SELECT * FROM recent_metadata
           UNION ALL
           SELECT * FROM task_starts
           UNION ALL
           SELECT * FROM latest_progress
         )
         ORDER BY timestamp DESC, rowid DESC`,
          'body_selection.timestamp DESC, body_selection.body_seq DESC'
        )
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
    let query = `SELECT rowid AS body_seq, timestamp FROM sdk_messages WHERE session_id = ? AND message_type = ?`;
    const params: SQLiteValue[] = [sessionId, messageType];

    if (messageSubtype) {
      query += ` AND message_subtype = ?`;
      params.push(messageSubtype);
    }

    query += ` ORDER BY timestamp ASC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(hydrateSdkMessageBodies(query, 'body_selection.timestamp ASC'));
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage);
  }

  getLatestSDKMessagesByType(
    sessionId: string,
    messageType: string,
    messageSubtype: string,
    limit: number
  ): SDKMessage[] {
    const rows = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp FROM sdk_messages
          INDEXED BY idx_sdk_messages_session_subtype_parent
          WHERE session_id = ? AND message_type = ? AND message_subtype_norm = ?
          ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
          'body_selection.timestamp DESC, body_selection.body_seq DESC'
        )
      )
      .all(sessionId, messageType, messageSubtype, limit) as Record<string, unknown>[];
    return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage).reverse();
  }

  getLastSDKMessage(sessionId: string): (SDKMessage & { dbId: string; timestamp: number }) | null {
    const stmt = this.db.prepare(
      hydrateSdkMessageBodies(
        `SELECT id, rowid AS body_seq, timestamp FROM sdk_messages
	       WHERE session_id = ?
		       AND parent_tool_use_id IS NULL
		       AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_LAST_MESSAGE_SQL_LIST})
		       AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT 1`,
        'body_selection.timestamp DESC, body_selection.body_seq DESC'
      )
    );
    const row = stmt.get(sessionId) as {
      id: string;
      sdk_message: string;
      timestamp: string;
    } | null;
    return row ? inflatePersistedMessage(row) : null;
  }

  latestCompactionSeq(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM sdk_messages
          WHERE session_id = ? AND message_subtype_norm = 'compact_boundary'`
      )
      .get(sessionId) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
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
    const derived = this.derivedColumns(message, taskId);

    const stmt = this.db.prepare(
      `INSERT INTO sdk_messages (
				id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin,
				is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
				sdk_uuid, replacement_metadata_normalized${derived.insert}
			) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1${derived.placeholders})`
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
      timestamp,
      sendStatus,
      origin ?? null,
      admission.isRenderable,
      admission.isTerminal,
      admission.parentToolUseId,
      taskId,
    ];
    writeSdkMessageBody(
      this.db,
      () => stmt.run(...values, conversationTurnIndex, admission.sdkUuid, ...derived.values),
      'id = ?',
      [id],
      '?',
      [JSON.stringify(message)]
    );
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
    direction: 'asc' | 'desc' = 'asc',
    project?: (message: UserStatusMessage) => UserStatusMessage
  ): {
    messages: Array<UserStatusMessage>;
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
    const messagesByRowId = new Map<number, UserStatusMessage>();

    for (const { rowIds, placeholders } of buildRowIdHydrationBatches(projected)) {
      const stmt = this.db.prepare(
        hydrateSdkMessageBodies(`SELECT rowid AS row_id, id, rowid AS body_seq, timestamp FROM sdk_messages
           WHERE rowid IN (${placeholders})`)
      );
      const rows = (project ? stmt.iterate(...rowIds) : stmt.all(...rowIds)) as Iterable<{
        row_id: number;
        id: string;
        sdk_message: string;
        timestamp: string;
      }>;
      for (const row of rows) {
        const message = inflatePersistedMessage(row) as UserStatusMessage;
        messagesByRowId.set(row.row_id, project ? project(message) : message);
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
    const { lowerBound, upperBound } = createSQLiteAsciiPrefixRange(prefix);
    const messages: Array<
      SDKUserMessage & { dbId: string; timestamp: number; sendStatus: string }
    > = [];
    let cursor: { timestamp: string; rowId: number } | null = null;
    for (;;) {
      const cursorClause = cursor ? 'AND (timestamp < ? OR (timestamp = ? AND rowid < ?))' : '';
      const params = cursor
        ? [
            sessionId,
            lowerBound,
            upperBound,
            cursor.timestamp,
            cursor.timestamp,
            cursor.rowId,
            pageSize,
          ]
        : [sessionId, lowerBound, upperBound, pageSize];
      const rows = this.db
        .prepare(
          hydrateSdkMessageBodies(
            `SELECT rowid AS row_id, id, rowid AS body_seq, timestamp, COALESCE(send_status, 'consumed') AS send_status FROM sdk_messages
	       WHERE session_id = ?
	         AND message_type = 'user'
	         AND sdk_uuid >= ?
	         AND sdk_uuid < ?
	         ${cursorClause}
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT ?`,
            'body_selection.timestamp DESC, body_selection.body_seq DESC'
          )
        )
        .all(...params) as Array<{
        row_id: number;
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
      const lastRow = rows[rows.length - 1];
      cursor = { timestamp: lastRow.timestamp, rowId: lastRow.row_id };
    }
  }

  getMessageByStatusAndUuid(
    sessionId: string,
    status: SendStatus,
    uuid: string
  ): (SDKMessage & { dbId: string; timestamp: number }) | null {
    const stmt = this.db.prepare(
      hydrateSdkMessageBodies(
        `SELECT id, rowid AS body_seq, timestamp FROM sdk_messages
	       WHERE session_id = ?
	         AND send_status = ?
	         AND sdk_uuid = ?
	       ORDER BY timestamp ASC, rowid ASC
	       LIMIT 1`,
        'body_selection.timestamp ASC, body_selection.body_seq ASC'
      )
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
        hydrateSdkMessageBodies(`SELECT id, rowid AS body_seq, timestamp FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND id = ?
         LIMIT 1`)
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

  listQueuedInputs(
    sessionId: string,
    kind: 'system' | 'human' | 'task' = 'system'
  ): { uuid: string; seq: number }[] {
    return this.db
      .prepare(
        `SELECT sdk_uuid AS uuid, seq FROM sdk_messages
           INDEXED BY idx_sdk_messages_send_status_timestamp
         WHERE session_id = ? AND send_status = 'enqueued' AND message_type = 'user'
           AND sdk_uuid IS NOT NULL AND input_kind = ?
         ORDER BY seq ASC`
      )
      .all(sessionId, kind) as { uuid: string; seq: number }[];
  }

  lastConsumedInputSeq(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT seq FROM sdk_messages
         WHERE session_id = ? AND send_status = 'consumed' AND message_type = 'user'
           AND input_kind IS NOT NULL
         ORDER BY timestamp DESC, seq DESC LIMIT 1`
      )
      .get(sessionId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  private statusBadgeDeltas(
    messageIds: string[],
    status: SendStatus
  ): { sid: string; delta: number }[] {
    if (!this.supportsVisibleMessageCount()) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT session_id AS sid,
        SUM(CASE WHEN message_type = 'user' THEN
          ? - CASE WHEN COALESCE(send_status, 'consumed') IN ('consumed', 'failed') THEN 1 ELSE 0 END
          ELSE 0 END) AS delta
      FROM sdk_messages WHERE id IN (${placeholders})
        AND parent_tool_use_id IS NULL
        AND COALESCE(message_subtype, '') NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
      GROUP BY session_id`)
      .all(status === 'consumed' || status === 'failed' ? 1 : 0, ...messageIds) as {
      sid: string;
      delta: number;
    }[];
  }

  updateMessageStatus(
    messageIds: string[],
    newStatus: SendStatus,
    options?: { sharedTurn?: boolean; consumedSeq?: number }
  ): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    const statusTransaction = this.db.transaction(() => {
      const pending =
        newStatus === 'consumed' || newStatus === 'failed'
          ? (this.db
              .prepare(`SELECT id, task_id, is_renderable FROM sdk_messages
            WHERE id IN (${placeholders}) AND message_type = 'user'
              AND send_status IN (${PENDING_ROW_FROM_STATUSES.map(() => '?').join(', ')})
            ORDER BY rowid ASC`)
              .all(...messageIds, ...PENDING_ROW_FROM_STATUSES) as Array<{
              id: string;
              task_id: string | null;
              is_renderable: number;
            }>)
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
      const deltas = this.statusBadgeDeltas(messageIds, newStatus);
      applyMessageStatusPlan(this.db, plan, messageIds, () => this.nextConsumedSeq());
      const changed: string[] = [];
      for (const { sid, delta } of deltas) {
        if (delta === 0) continue;
        this.bumpVisibleMessageCount(sid, delta);
        changed.push(sid);
      }
      return changed;
    });
    const changedSessions = withBusyRetry(() => statusTransaction());
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
      const deltas = this.statusBadgeDeltas([messageId], targetStatus);
      changed =
        this.db
          .prepare(`UPDATE sdk_messages SET send_status = ? WHERE id = ? AND send_status = ?`)
          .run(targetStatus, messageId, expectedStatus).changes > 0;
      if (!changed) return;
      for (const { sid, delta } of deltas) {
        if (delta === 0) continue;
        this.bumpVisibleMessageCount(sid, delta);
        notifySid = sid;
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
        hydrateSdkMessageBodies(`SELECT id, rowid AS body_seq, send_status
				   FROM sdk_messages
				  WHERE session_id = ?
				    AND id = ?
				    AND message_type = 'user'
				    AND send_status IN ('deferred', 'enqueued')
            AND (? IS NULL OR send_status = ?)
				  LIMIT 1`)
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
        hydrateSdkMessageBodies(`SELECT id, rowid AS body_seq, send_status FROM sdk_messages
          WHERE session_id = ? AND id = ? AND message_type = 'user'
          LIMIT 1`)
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

  private deleteMessagesFromTimestamp(
    sessionId: string,
    timestamp: number,
    comparison: TimestampComparison
  ): number {
    const isoTimestamp = new Date(timestamp).toISOString();
    const select = this.db.prepare(
      `SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp ${comparison} ?`
    );
    const stmt = this.db.prepare(
      `DELETE FROM sdk_messages WHERE session_id = ? AND timestamp ${comparison} ?`
    );
    let rows: Array<{ id: string; sdk_uuid: string | null }> = [];
    let badgeChanged = false;
    this.db.transaction(() => {
      rows = select.all(sessionId, isoTimestamp) as typeof rows;
      stmt.run(sessionId, isoTimestamp);
      badgeChanged = this.applyBadgeUpdate(sessionId, planBadgeRecompute());
      for (const { sdk_uuid } of rows) {
        if (sdk_uuid) this.clearDeliveryTurnEnd(sessionId, sdk_uuid);
      }
    })();
    if (badgeChanged) this.notifySessionsChanged(sessionId);
    for (const row of rows) this.deleteMessageSearchRow(row.id);
    return rows.length;
  }

  deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
    return this.deleteMessagesFromTimestamp(sessionId, afterTimestamp, '>');
  }

  deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
    return this.deleteMessagesFromTimestamp(sessionId, atTimestamp, '>=');
  }

  getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
    const stmt = this.db.prepare(
      hydrateSdkMessageBodies(
        `SELECT rowid AS body_seq, timestamp FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user'
       ORDER BY timestamp ASC`,
        'body_selection.timestamp ASC'
      )
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
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'user'
           AND sdk_uuid = ?
         ORDER BY timestamp ASC, rowid ASC
         LIMIT 1`,
          'body_selection.timestamp ASC, body_selection.body_seq ASC'
        )
      )
      .get(sessionId, uuid) as { sdk_message: string; timestamp: string } | undefined;
    if (!row) return undefined;
    return this.parseUserMessageRow(row, uuid);
  }

  getStoredPromptsByUuid(sessionId: string, uuid: string): SDKMessage[] {
    const rows = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
          ORDER BY timestamp ASC, rowid ASC`,
          'body_selection.timestamp ASC, body_selection.body_seq ASC'
        )
      )
      .all(sessionId, uuid) as Array<{ sdk_message: string }>;
    const messages: SDKMessage[] = [];
    for (const row of rows) {
      try {
        messages.push(JSON.parse(row.sdk_message) as SDKMessage);
      } catch {}
    }
    return messages;
  }

  getHumanPrompt(sessionId: string, uuid: string): { at: number; text: string } | null {
    const rows = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
          ORDER BY timestamp ASC, rowid ASC`,
          'body_selection.timestamp ASC, body_selection.body_seq ASC'
        )
      )
      .all(sessionId, uuid) as Array<{ sdk_message: string; timestamp: string | number }>;
    for (const row of rows) {
      let message: { inputKind?: unknown; message?: { content?: unknown } };
      try {
        message = JSON.parse(row.sdk_message);
      } catch {
        continue;
      }
      if (message.inputKind !== 'human') continue;
      const at = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
      if (!Number.isFinite(at)) return null;
      const content = message.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .flatMap((block: { type?: unknown; text?: unknown }) =>
                  block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
                )
                .join('\n')
            : '';
      return { at, text };
    }
    return null;
  }

  lastHumanPromptAt(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT timestamp FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user'
            AND input_kind = 'human'
          ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      )
      .get(sessionId) as { timestamp: string } | undefined;
    const at = row ? Date.parse(row.timestamp) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  }

  getUserMessageContentByUuid(sessionId: string, uuid: string): string | MessageContent[] | null {
    const row = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
           ORDER BY timestamp ASC LIMIT 1`,
          'body_selection.timestamp ASC'
        )
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

  readRestartRecoveryEvidence(
    sessionId: string
  ): { promptUuid: string; workedAfter: boolean } | null {
    const prompt = this.db
      .prepare(
        `SELECT sdk_uuid AS uuid, timestamp FROM sdk_messages
          WHERE session_id = ? AND send_status = 'consumed' AND message_type = 'user'
            AND sdk_uuid IS NOT NULL AND parent_tool_use_id IS NULL
            AND COALESCE(has_tool_result, 0) = 0
          ORDER BY timestamp DESC, id DESC LIMIT 1`
      )
      .get(sessionId) as { uuid: string; timestamp: string } | undefined;
    if (!prompt) return null;
    const worked = this.db
      .prepare(
        `SELECT 1 FROM sdk_messages
          WHERE session_id = ? AND message_type = 'assistant' AND timestamp > ? LIMIT 1`
      )
      .get(sessionId, prompt.timestamp);
    return { promptUuid: prompt.uuid, workedAfter: !!worked };
  }

  getDeliveryContent(
    sessionId: string,
    uuid: string
  ): {
    content: string | MessageContent[];
    sendStatus: SendStatus;
    inputKind?: string;
    neoBatch?: true;
    neoWorkerBatch?: true;
  } | null {
    const row = this.db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT rowid AS body_seq, timestamp, COALESCE(send_status, 'consumed') AS send_status
           FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
          ORDER BY timestamp ASC LIMIT 1`,
          'body_selection.timestamp ASC'
        )
      )
      .get(sessionId, uuid) as { sdk_message: string; send_status: SendStatus } | undefined;
    if (!row) return null;
    try {
      const message = JSON.parse(row.sdk_message) as {
        message?: { content?: string | MessageContent[] };
        inputKind?: string;
        neoBatchContent?: string | MessageContent[];
        neoWorkerBatch?: boolean;
      };
      const content = message.neoBatchContent ?? message.message?.content ?? null;
      if (content === null) return null;
      return {
        content,
        sendStatus: row.send_status,
        ...(message.inputKind ? { inputKind: message.inputKind } : {}),
        ...(message.neoWorkerBatch ? { neoWorkerBatch: true as const } : {}),
        ...(message.neoBatchContent !== undefined || message.neoWorkerBatch
          ? { neoBatch: true as const }
          : {}),
      };
    } catch {
      return null;
    }
  }

  normalizeDeliveryMessageForMailbox(sessionId: string, uuid: string): boolean {
    return runNormalizeDeliveryMessageForMailbox({
      sessionId,
      uuid,
      changed: false,
      deps: {
        selectDeliveryMessageRow: (selectSessionId, selectUuid) =>
          this.db
            .prepare(
              hydrateSdkMessageBodies(
                `SELECT id, rowid AS body_seq, timestamp, origin FROM sdk_messages
                WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
                ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
                'body_selection.timestamp ASC, body_selection.body_seq ASC'
              )
            )
            .get(selectSessionId, selectUuid) as
            | { id: string; sdk_message: string; origin: string | null }
            | null
            | undefined,
        applyNormalizedDeliveryMessage: (rowId, sdkMessage, synthetic) => {
          const derived = this.derivedColumns(JSON.parse(sdkMessage));
          return writeSdkMessageBody(
            this.db,
            () =>
              this.db
                .prepare(
                  `UPDATE sdk_messages
                  SET origin = CASE WHEN ? = 1 THEN COALESCE(origin, 'system') ELSE origin END${derived.update}
                    WHERE id = ?`
                )
                .run(synthetic ? 1 : 0, ...derived.values, rowId),
            'id = ?',
            [rowId],
            '?',
            [sdkMessage]
          ).changes;
        },
      },
    }).changed;
  }

  hasTerminalResultAfter(sessionId: string, uuid: string): boolean {
    const row = this.db.prepare(HAS_TERMINAL_RESULT_AFTER_SQL).get(sessionId, sessionId, uuid) as
      | { 1: number }
      | undefined
      | null;
    return row != null;
  }

  markResultRecoveryIntercepted(sessionId: string, sdkUuid: string, billingTerminal = false): void {
    const derived = this.derivedColumns(
      { recovery_intercepted: 1, recovery_billing_terminal: Number(billingTerminal) },
      null,
      ['recovery_intercepted', 'recovery_billing_terminal']
    );
    writeSdkMessageBody(
      this.db,
      () =>
        this.db
          .prepare(
            `UPDATE sdk_messages
            SET ${derived.update.slice(2)}
          WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'result'`
          )
          .run(...derived.values, sessionId, sdkUuid),
      "session_id = ? AND sdk_uuid = ? AND message_type = 'result'",
      [sessionId, sdkUuid],
      "json_set(previous.sdk_message, '$.recovery_intercepted', 1, '$.recovery_billing_terminal', ?)",
      [Number(billingTerminal)]
    );
  }

  markResultInternalCompactionTurn(sessionId: string, sdkUuid: string): void {
    const derived = this.derivedColumns({ internal_compaction_turn: 1 }, null, [
      'internal_compaction_turn',
    ]);
    withBusyRetry(() =>
      writeSdkMessageBody(
        this.db,
        () =>
          this.db
            .prepare(
              `UPDATE sdk_messages
              SET ${derived.update.slice(2)}
            WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'result'`
            )
            .run(...derived.values, sessionId, sdkUuid),
        "session_id = ? AND sdk_uuid = ? AND message_type = 'result'",
        [sessionId, sdkUuid],
        "json_set(previous.sdk_message, '$.internal_compaction_turn', 1)",
        []
      )
    );
  }

  hasRecoveryInterceptedResultAfter(sessionId: string, uuid: string): boolean {
    const row = this.db
      .prepare(HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL)
      .get(sessionId, sessionId, uuid) as { 1: number } | undefined | null;
    return row != null;
  }

  getErrorTerminalResultSubtypeAfter(sessionId: string, uuid: string): string | null {
    return this.getTurnErrorResultSubtype(sessionId, uuid);
  }

  getTurnErrorResultSubtype(sessionId: string, uuid: string): string | null {
    const row = this.db.prepare(GET_TURN_ERROR_RESULT_SUBTYPE_SQL).get(sessionId, uuid) as
      | { subtype: string | null }
      | undefined
      | null;
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

  getUserSendStatus(sessionId: string, uuid: string): SendStatus | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(send_status, 'consumed') AS status FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { status: SendStatus } | undefined;
    return row?.status ?? null;
  }

  findMessageIdByUuid(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
           WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
           ORDER BY timestamp ASC LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    return row?.id ?? null;
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
               AND COALESCE(internal_compaction_turn, 0) = 0
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

  hasConsumptionEvidence(sessionId: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'user'
           AND (sdk_uuid = ? OR id = ?)
           AND consumed_seq IS NOT NULL
         LIMIT 1`
      )
      .get(sessionId, messageId, messageId);
    return row !== null && row !== undefined;
  }

  hasConsumedTaskInputForSession(sessionId: string, taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM sdk_messages
         WHERE session_id = ?
           AND task_id = ?
           AND message_type = 'user'
           AND consumed_seq IS NOT NULL
           AND task_input_eligible = 1
         LIMIT 1`
      )
      .get(sessionId, taskId);
    return row !== null && row !== undefined;
  }

  getSettledDeliveryMessageId(sessionId: string, uuid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
          WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
            AND (consumed_seq IS NOT NULL OR COALESCE(send_status, 'consumed') = 'consumed')
          ORDER BY consumed_seq IS NULL, consumed_seq DESC, timestamp ASC, rowid ASC
          LIMIT 1`
      )
      .get(sessionId, uuid) as { id: string } | undefined;
    return row?.id ?? null;
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
				SELECT rowid AS body_seq, id, timestamp FROM sdk_messages
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
				SELECT rowid AS body_seq, id, timestamp FROM sdk_messages
				WHERE session_id = ? AND message_type = 'assistant'
				ORDER BY timestamp ASC
			`;
      params = [sessionId];
    }

    const stmt = this.db.prepare(hydrateSdkMessageBodies(query, 'body_selection.timestamp ASC'));
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
    const derived = this.derivedColumns(message, taskId);
    const conversationTurnIndex = this.resolveConversationTurnIndex(
      taskId,
      sessionId,
      admission.isConversationAnchor
    );

    const values = [id, sessionId, 'hyperneo_action', message.action, timestamp, taskId];

    const insertStmt = this.db.prepare(
      `INSERT INTO sdk_messages (
           id, session_id, message_type, message_subtype, sdk_message, timestamp, task_id,
           conversation_turn_index, sdk_uuid, replacement_metadata_normalized${derived.insert}
         ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 1${derived.placeholders})`
    );

    this.db.transaction(() => {
      writeSdkMessageBody(
        this.db,
        () =>
          insertStmt.run(...values, conversationTurnIndex, admission.sdkUuid, ...derived.values),
        'id = ?',
        [id],
        '?',
        [JSON.stringify(message)]
      );
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
             AND resolved = 0
           LIMIT 1`
      )
      .get(sessionId, action);
    return row !== null && row !== undefined;
  }

  updateHyperNeoActionMessage(rowId: string, updated: HyperNeoActionMessage): void {
    const derived = this.derivedColumns(updated);
    const stmt = this.db.prepare(
      `UPDATE sdk_messages SET ${derived.update.slice(2)} WHERE id = ? AND message_type = 'hyperneo_action'
       RETURNING session_id`
    );
    const row = writeSdkMessageBody(
      this.db,
      () => stmt.get(...derived.values, rowId),
      "id = ? AND message_type = 'hyperneo_action'",
      [rowId],
      '?',
      [JSON.stringify(updated)]
    ) as { session_id: string } | undefined;
    this.scheduleMessageSearchIndex(rowId);
    if (row) this.reactiveDb?.notifyChange('sdk_messages', { sessionId: row.session_id });
  }

  updateHyperNeoActionMessageByUuid(
    sessionId: string,
    messageUuid: string,
    updated: HyperNeoActionMessage
  ): void {
    const derived = this.derivedColumns(updated);
    const row = this.db
      .prepare(
        `SELECT id FROM sdk_messages
       WHERE session_id = ?
         AND message_type = 'hyperneo_action'
         AND sdk_uuid = ?`
      )
      .get(sessionId, messageUuid) as { id: string } | undefined;
    const stmt = this.db.prepare(
      `UPDATE sdk_messages SET ${derived.update.slice(2)}
       WHERE session_id = ?
         AND message_type = 'hyperneo_action'
         AND sdk_uuid = ?`
    );
    const result = writeSdkMessageBody(
      this.db,
      () => stmt.run(...derived.values, sessionId, messageUuid),
      "session_id = ? AND sdk_uuid = ? AND message_type = 'hyperneo_action'",
      [sessionId, messageUuid],
      '?',
      [JSON.stringify(updated)]
    );
    if (row) this.scheduleMessageSearchIndex(row.id);
    if (result.changes > 0) this.reactiveDb?.notifyChange('sdk_messages', { sessionId });
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
    const policy = messageSearchPolicy({
      sessions: this.tableExists('sessions'),
      spaceTasks: this.tableExists('space_tasks'),
    });
    let candidateSql = `
			SELECT
				msc.id,
				${broadQuery ? '0' : 'bm25(message_search_fts)'} AS rank,
				msc.timestamp,
				msc.source_id
			FROM message_search_fts
			JOIN message_search_content msc ON msc.id = message_search_fts.rowid
			${policy.joins}
			WHERE message_search_fts MATCH ?
			  AND (
				msc.kind = 'task'
				OR (
					msc.kind = 'message'
					${policy.where}
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

  hasTurnVectors(model: string): boolean {
    if (!this.tableExists('message_search_vectors')) return false;
    return !!this.db
      .prepare(`SELECT 1 FROM message_search_vectors WHERE model = ? LIMIT 1`)
      .get(model);
  }

  searchWorkChats(
    query: string,
    limit: number,
    semantic?: { vector: Float32Array; model: string },
    kinds?: readonly WorkChatKind[]
  ): WorkChatMatch[] {
    if (!this.hasMessageSearchIndex()) return [];
    const tables = {
      sessions: this.tableExists('sessions'),
      spaceTasks: this.tableExists('space_tasks'),
    };
    const vectors = semantic && this.tableExists('message_search_vectors') ? semantic : undefined;
    return queryWorkChats(this.db, tables, query, limit, vectors, kinds);
  }
}

function parseSearchTimestamp(value: string | null): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export const messageSearchIndexWrites = defineRepositoryOp(
  'search.indexWrites',
  'write',
  SDKMessageRepository,
  ['flushMessageSearchIndex']
);
