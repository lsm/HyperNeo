import { createLiveFileRead } from '../artifacts/live-file-read.ts';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { createConnectionList } from '../connections/list-operation.ts';
import { createGoogleConnectionOperations } from '../connections/operations.ts';
import { sessionWorkerRef } from '../neo/worker-identity.ts';
import { neoTodoSessionReads } from '../../storage/repositories/neo-todo-session-repository.ts';
import { createArtifactReadOperations } from '../artifacts/read-operations.ts';
import { createCardHandoffRead } from '../handoffs/card-read.ts';
import { createArtifactReferenceResolve } from '../artifacts/resolve-operation.ts';
import { createBuildOperation } from '../system/build-operation.ts';
import { daemonPairingLimiter } from '../pairing/pairing-limiter.ts';
import { daemonPairWaits } from '../pairing/pair-waits.ts';
import { createDevicePairingOperations } from '../pairing/pairing-operations.ts';
import { createHumanDeviceResetOperation } from '../pairing/human-device-reset.ts';
import { announceDeviceRevoked } from '../pairing/upgrade-auth.ts';
import { DevicePairingRepository } from '../../storage/repositories/device-pairing-repository.ts';
import type { Database } from '../../storage/database.ts';
import { createDaemonOperationCatalog, type MessagingOperationDependencies } from './catalog.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { OperationDefinition } from './registry.ts';
import { listOperationSummaries } from './discovery.ts';
import { createDaemonSnapshotOperation } from '../inventory/snapshot-operation.ts';
import { DaemonInventoryRepository } from '../../storage/repositories/daemon-inventory-repository.ts';
import { createSessionInspectionOperation } from '../inventory/session-inspection.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { neoFolderPath } from '../neo/folder.ts';
import { NeoSessionMessageRepository } from '../../storage/repositories/neo-session-message-repository.ts';
import { planNeoSessionMessage } from '../neo/session-messages.ts';
import { listSessionMessages } from '../session/space-session-reads.ts';
import { createMessageStatusOperation } from '../messaging/message-status.ts';
import { MAILBOX_LANE } from '../mailbox/enqueue.ts';
import { MESSAGE_DELIVERY } from '../job-queue-constants.ts';

type DefaultOperations = (db: Database) => readonly OperationDefinition[];

const defaultOperations = new Map<string, DefaultOperations>();

export function contributeDefaultOperations(id: string, build: DefaultOperations): void {
  defaultOperations.set(id, build);
}

function readSessionField(
  db: Database,
  field: 'status' | 'title' | 'workspace_path',
  sessionId: string
): string | null {
  const row = db
    .getDatabase()
    .prepare(`SELECT ${field} AS value FROM sessions WHERE id = ?`)
    .get(sessionId) as { value: string } | undefined | null;
  return row?.value ?? null;
}

export function createDatabaseOperationCatalog(
  db: Database,
  jobQueue: JobQueueRepository = db.getJobQueueRepo(),
  overrides: Partial<MessagingOperationDependencies> = {},
  extra: readonly OperationDefinition[] = []
) {
  const explicit = new Set(extra.map((operation) => operation.name));
  const contributed = [...defaultOperations.values()]
    .flatMap((build) => build(db))
    .filter((operation) => !explicit.has(operation.name));
  const registry = createDaemonOperationCatalog(
    jobQueue,
    {
      sessionStatus: (sessionId) => readSessionField(db, 'status', sessionId),
      isNeo: (sessionId) =>
        new NeoRepository(db.getDatabase()).getBindingBySession(sessionId)?.kind === 'neo',
      inNeoProject: (sessionId) =>
        readSessionField(db, 'workspace_path', sessionId) === neoFolderPath(),
      sessionTitle: async (id) => {
        const title = readSessionField(db, 'title', id);
        return title !== null
          ? workerIdentity({ adapter: 'hyperneo', id }, title).label
          : workerIdentity(
              sessionWorkerRef(id, false),
              await db.gateway.call(neoTodoSessionReads, 'workerName', sessionWorkerRef(id, false))
            ).label;
      },
      sessionSent: async (sent) => {
        const neo = new NeoRepository(db.getDatabase());
        const sessionId = neo.defaultBinding()?.sessionId;
        const conversationId = neo.conversationId();
        const message = planNeoSessionMessage(
          sent,
          sessionId && conversationId ? { sessionId, conversationId } : null,
          (id) => readSessionField(db, 'title', id)
        );
        if (message) await new NeoSessionMessageRepository(db.getDatabase()).record(message);
      },
      ...overrides,
    },
    [
      ...contributed,
      ...extra,
      ...createArtifactReadOperations(() => db.getDatabase()),
      createCardHandoffRead(() => db.getDatabase()),
      createLiveFileRead(() => db.getDatabase()),
      createArtifactReferenceResolve(() => db.getDatabase()),
      createBuildOperation(() => db.getDatabase().prepare('SELECT 1').get()),
      ...createDevicePairingOperations({
        repo: () => new DevicePairingRepository(db.getDatabase()),
        limiter: daemonPairingLimiter,
        now: Date.now,
        revoked: announceDeviceRevoked,
        waits: daemonPairWaits,
      }),
      createHumanDeviceResetOperation(() => db.getDatabase()),
      createConnectionList(() => db.getDatabase()),
      ...createGoogleConnectionOperations(() => db.getDatabase()),
      createDaemonSnapshotOperation({
        readResources: (input) => new DaemonInventoryRepository(db.getDatabase()).read(input),
        readCapabilities: (caller) =>
          listOperationSummaries(registry, caller).map(({ name }) => name),
      }),
      createMessageStatusOperation({
        readSendStatus: (sessionId, messageId) => {
          const note = jobQueue.getLatestByPayload('neo_notes', {
            'to.sessionId': sessionId,
            messageUuid: messageId,
          });
          if (note && !note.payload.neoBatchUuid) return 'enqueued';
          const id = note ? String(note.payload.neoBatchUuid) : messageId;
          return (
            db.getSDKMessageRepo().getDeliveryContent(sessionId, id)?.sendStatus ??
            (note ? 'enqueued' : null)
          );
        },
        readMailboxAdmission: (sessionId, messageId) =>
          jobQueue.getLatestByPayload(MAILBOX_LANE, {
            'to.sessionId': sessionId,
            messageUuid: messageId,
          }),
        readDeliveryError: (sessionId, messageId) =>
          jobQueue.getLatestByPayload(MESSAGE_DELIVERY, { sessionId, messageUuid: messageId })
            ?.error ?? null,
      }),
      createSessionInspectionOperation({
        readSession: (id) => new DaemonInventoryRepository(db.getDatabase()).readSession(id),
        readMessages: (id, limit, before) =>
          listSessionMessages(db.getDatabase(), id, limit, before),
      }),
    ]
  );
  return registry;
}
