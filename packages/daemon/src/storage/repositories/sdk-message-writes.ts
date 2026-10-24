import type { ChangeRecorder, RepositoryOp } from '../db-gateway/db-op.ts';
import { mergeScopes, type TableChangeScope } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { type SdkMessageChanges, SDKMessageRepository } from './sdk-message-repository.ts';

const SDK_MESSAGE_WRITE_METHODS = [
  'saveSDKMessage',
  'saveUserMessage',
  'saveHyperNeoActionMessage',
  'updateHyperNeoActionMessage',
  'updateHyperNeoActionMessageByUuid',
  'updateMessageStatus',
  'updateMessageTimestamp',
  'transitionMessageSendStatus',
  'deletePendingUserMessage',
  'deferEnqueuedUserMessage',
  'deleteMessagesAfter',
  'deleteMessagesAtAndAfter',
  'recomputeVisibleMessageCount',
  'normalizeDeliveryMessageForMailbox',
  'markResultRecoveryIntercepted',
  'markResultInternalCompactionTurn',
  'recordDeliveryTurnEnd',
  'clearDeliveryTurnEnd',
  'markDeliveryFailedByUuid',
  'markDeliveryFailedByUuidInclusive',
  'markDeliveryConsumedByUuid',
  'markDeliveryConsumedAtTurnEnd',
  'markDeliveriesConsumedAtTurnEnd',
  'markDeliveryConsumedByUuids',
  'markDeliverySubmittedByUuids',
  'reopenDeliveryByUuid',
  'markDeliveryRetryableByUuid',
  'markDeliveryDeferredByUuid',
] as const;

export type SdkMessageWriteMethod = (typeof SDK_MESSAGE_WRITE_METHODS)[number];

function taskIdForSession(db: Database, sessionId: string): string | null {
  try {
    const row = db.prepare('SELECT task_id, type FROM sessions WHERE id = ?').get(sessionId) as
      | { task_id: string | null; type: string | null }
      | undefined;
    return row?.type === 'worker' ? (row.task_id ?? null) : null;
  } catch {
    return null;
  }
}

function sessionScope(db: Database, sessionId: unknown): TableChangeScope {
  if (typeof sessionId !== 'string') return {};
  return { sessionId, taskId: taskIdForSession(db, sessionId) ?? undefined };
}

function messageSubtype(message: unknown): string | null | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const subtype = (message as { subtype?: unknown }).subtype;
  if (subtype === undefined || subtype === null) return null;
  return typeof subtype === 'string' ? subtype : undefined;
}

function messageRowsScope(db: Database, ids: unknown[]): TableChangeScope | undefined {
  const messageIds = ids.filter((id): id is string => typeof id === 'string');
  if (messageIds.length === 0) return {};
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT session_id, task_id FROM sdk_messages WHERE id IN (${messageIds.map(() => '?').join(',')})`
      )
      .all(...messageIds) as Array<{ session_id: string | null; task_id: string | null }>;
    const scopes = rows.map((row) => ({
      sessionId: row.session_id ?? undefined,
      taskId: row.task_id ?? undefined,
    }));
    return mergeScopes(scopes) ?? {};
  } catch {
    return {};
  }
}

const ANNOUNCED_SCOPES: Partial<
  Record<SdkMessageWriteMethod, (db: Database, args: unknown[]) => TableChangeScope | undefined>
> = {
  saveSDKMessage: (db, args) => ({
    ...sessionScope(db, args[0]),
    messageSubtype: messageSubtype(args[1]),
  }),
  saveUserMessage: (db, args) => sessionScope(db, args[0]),
  updateMessageStatus: (db, args) => messageRowsScope(db, Array.isArray(args[0]) ? args[0] : []),
  updateMessageTimestamp: (db, args) => messageRowsScope(db, [args[0]]),
  deletePendingUserMessage: (_db, args) => ({ sessionId: args[0] as string }),
  deleteMessagesAfter: (_db, args) => ({ sessionId: args[0] as string }),
  deleteMessagesAtAndAfter: (_db, args) => ({ sessionId: args[0] as string }),
};

function sdkMessageChanges(
  db: Database,
  changes: ChangeRecorder,
  announced: boolean
): SdkMessageChanges {
  return {
    notifyChange: (table, scope) => changes.notifyChange(table, scope),
    willEmitTableChange: (table) => announced && table === 'sdk_messages',
    resolveTaskIdForSession: (sessionId) => taskIdForSession(db, sessionId),
  };
}

const writes = new Set<string>(SDK_MESSAGE_WRITE_METHODS);

export const sdkMessageWrites: RepositoryOp<SDKMessageRepository, SdkMessageWriteMethod> = {
  name: 'sdk_messages.write',
  mode: 'write',
  methods: SDK_MESSAGE_WRITE_METHODS,
  Repository: SDKMessageRepository,
  run: (db, { method, args }, changes) => {
    if (!writes.has(method)) throw new Error(`sdk_messages.write does not run ${method}`);
    const announce = ANNOUNCED_SCOPES[method as SdkMessageWriteMethod];
    const repository = new SDKMessageRepository(
      db,
      sdkMessageChanges(db, changes, announce !== undefined)
    ) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const result = repository[method](...args);
    if (announce) changes.notifyChange('sdk_messages', announce(db, args));
    return result;
  },
};
