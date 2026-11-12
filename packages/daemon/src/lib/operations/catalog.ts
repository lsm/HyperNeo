import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createDiscoveryOperations } from './discovery.ts';
import {
  createSendMessageOperation,
  type AgentTargetResolver,
  type SessionSentObserver,
  type SessionStatusRead,
  type SessionTitleRead,
  type SessionReportHandler,
} from '../messaging/message-send.ts';
import { createAttachDaemonOperation } from '../remote-daemons/attach-operation.ts';
import {
  createDetachDaemonOperation,
  createListDaemonsOperation,
  createProbeDaemonOperation,
} from '../remote-daemons/manage-operations.ts';
import { createRemoteSendForwarder } from '../remote-daemons/forward-send.ts';
import { remoteDaemons } from '../remote-daemons/registry.ts';
import {
  createOperationRegistry,
  type OperationRegistry,
  type OperationDefinition,
} from './registry.ts';
import { createHandoffOperations } from '../handoffs/operations.ts';

export interface MessagingOperationDependencies {
  sessionStatus: SessionStatusRead;
  sessionTitle?: SessionTitleRead;
  resolveMessageAgent?: AgentTargetResolver;
  sessionSent?: SessionSentObserver;
  isNeo?: (sessionId: string) => boolean;
  inNeoProject?: (sessionId: string) => boolean;
  workerReport?: SessionReportHandler;
}

export function createDaemonOperationCatalog(
  jobQueue: JobQueueRepository,
  messaging: MessagingOperationDependencies,
  extra: readonly OperationDefinition[] = []
): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    ...createHandoffOperations(messaging.sessionStatus),
    createSendMessageOperation(
      jobQueue,
      messaging.sessionStatus,
      createRemoteSendForwarder(remoteDaemons),
      messaging.resolveMessageAgent,
      messaging.sessionTitle,
      messaging.sessionSent,
      messaging.isNeo,
      messaging.workerReport,
      messaging.inNeoProject
    ),
    createAttachDaemonOperation(remoteDaemons),
    createProbeDaemonOperation(remoteDaemons),
    createListDaemonsOperation(remoteDaemons),
    createDetachDaemonOperation(remoteDaemons),
    ...extra,
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
