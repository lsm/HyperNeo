import type { ChangeRecorder, RepositoryOp } from '../db-gateway/db-op.ts';
import {
  sdkMessageScope,
  sdkMessageSubtype,
  messageIdsScope,
  messageIdScope,
  type TableChangeScope,
} from '../reactive-database.ts';
import type { Database as FacadeDatabase } from '../index.ts';
import type { Database } from '../sqlite-compat.ts';
import { applySdkBodyWriteMode } from '../sdk-message-body-admission.ts';
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

function scopeDatabase(db: Database): FacadeDatabase {
  return { getDatabase: () => db } as FacadeDatabase;
}

const ANNOUNCED_SCOPES: Partial<
  Record<SdkMessageWriteMethod, (db: Database, args: unknown[]) => TableChangeScope | undefined>
> = {
  saveSDKMessage: (db, args) => ({
    ...sdkMessageScope(scopeDatabase(db), args[0]),
    messageSubtype: sdkMessageSubtype(args[1]),
  }),
  saveUserMessage: (db, args) => sdkMessageScope(scopeDatabase(db), args[0]),
  updateMessageStatus: (db, args) => messageIdsScope(scopeDatabase(db), args[0]),
  updateMessageTimestamp: (db, args) => messageIdScope(scopeDatabase(db), args[0]),
  deletePendingUserMessage: (_db, args) => ({ sessionId: args[0] as string }),
  deleteMessagesAfter: (_db, args) => ({ sessionId: args[0] as string }),
  deleteMessagesAtAndAfter: (_db, args) => ({ sessionId: args[0] as string }),
};

export function sdkMessageChanges(
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
  get Repository() {
    return SDKMessageRepository;
  },
  run: (db, input, changes) => {
    const { method, args } = input;
    applySdkBodyWriteMode(db, input);
    if (!writes.has(method)) throw new Error(`sdk_messages.write does not run ${method}`);
    if (
      method === 'recordDeliveryTurnEnd' &&
      !db.prepare('SELECT 1 FROM sessions WHERE id=?').get(args[0] as string)
    )
      return;
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
