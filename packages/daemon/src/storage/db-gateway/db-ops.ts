import { externalEventSweeps } from '../../lib/external-events/external-event-store.ts';
import {
  ingestSessionEvent,
  readLatestSessionPrState,
} from '../../lib/external-events/session-external-event-store.ts';
import { sdkMessageWrites } from '../repositories/sdk-message-writes.ts';
import { claudeDesktopOutboxWrites } from '../repositories/claude-desktop-outbox-repository.ts';
import { codingLedgerWrites } from '../../lib/neo/packs/coding/pr-ledger.ts';
import { codingAssignmentWrites } from '../../lib/neo/packs/coding/assignments.ts';
import { codingSweepWrites } from '../../lib/neo/packs/coding/pr-sweep.ts';
import { codingTodoPrWrites } from '../../lib/neo/packs/coding/todo-prs.ts';
import { codingDeliveryWrites } from '../../lib/neo/packs/coding/delivery-facts.ts';
import {
  recordUnpaired,
  recordWouldRefuse,
  touchDevice,
} from '../repositories/device-pairing-repository.ts';
import {
  cleanupJobs,
  jobQueueReads,
  jobQueueWrites,
} from '../repositories/job-queue-repository.ts';
import { recordClaudeInboxRoute } from '../repositories/claude-inbox-route-repository.ts';
import { replaceNeoSessionSeen } from '../repositories/neo-session-seen-repository.ts';
import {
  removeRemoteDaemonSecret,
  saveRemoteDaemonSecret,
} from '../repositories/remote-daemon-secret-repository.ts';
import {
  registerClient,
  unregisterClient,
} from '../repositories/client-registration-repository.ts';
import {
  forgetAgentChildren,
  recordAgentChild,
} from '../repositories/agent-child-process-repository.ts';
import { recordOperationRefusal } from '../repositories/operation-refusal-repository.ts';
import { messageSearchIndexWrites } from '../repositories/sdk-message-repository.ts';
import { sessionWrites } from '../repositories/session-repository.ts';
import { deleteWorkFeedBatch } from '../work-feed.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [
    sdkMessageWrites,
    recordWouldRefuse,
    touchDevice,
    recordUnpaired,
    jobQueueWrites,
    jobQueueReads,
    externalEventSweeps,
    messageSearchIndexWrites,
    cleanupJobs,
    ingestSessionEvent,
    readLatestSessionPrState,
    deleteWorkFeedBatch,
    sessionWrites,
    codingLedgerWrites,
    codingAssignmentWrites,
    codingTodoPrWrites,
    codingDeliveryWrites,
    codingSweepWrites,
    claudeDesktopOutboxWrites,
    recordOperationRefusal,
    recordClaudeInboxRoute,
    replaceNeoSessionSeen,
    saveRemoteDaemonSecret,
    removeRemoteDaemonSecret,
    registerClient,
    unregisterClient,
    recordAgentChild,
    forgetAgentChildren,
  ].map((op) => [op.name, op])
);
