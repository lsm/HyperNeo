import { globalSettingsWrites } from '../repositories/global-settings-writes.ts';
import {
  codingPollPageReads,
  codingPollPageWrites,
} from '../../lib/neo/packs/coding/poll-http-db.ts';
import { readWorkInput } from '../work-input.ts';
import { codingMergeReads, codingMergeWrites } from '../../lib/neo/packs/coding/merge-facts-db.ts';
import {
  codingAncestryReads,
  codingAncestryWrites,
} from '../../lib/neo/packs/coding/ancestry-facts-db.ts';
import { codingQueryReads, codingQueryWrites } from '../../lib/neo/packs/coding/query-facts-db.ts';
import { codingWorkReads, codingWorkWrites } from '../../lib/neo/packs/coding/work-facts-db.ts';
import { codingRefReads, codingRefWrites } from '../../lib/neo/packs/coding/ref-facts-db.ts';
import {
  codingBranchReads,
  codingBranchWrites,
} from '../../lib/neo/packs/coding/branch-facts-db.ts';
import { neoProjectForgetWrites } from '../repositories/neo-project-forget-writes.ts';
import { jobEnqueueWrites } from '../repositories/job-enqueue-writes.ts';
import { neoProjectCleanupWrites } from '../repositories/neo-project-cleanup-writes.ts';
import { toolDefaultTransitions } from '../repositories/tool-default-transition.ts';
import { reserveNeoHomeProjects } from '../repositories/neo-home-reservation.ts';
import {
  neoTodoSessionReads,
  neoTodoSessionWrites,
} from '../repositories/neo-todo-session-repository.ts';
import { codingTodoPrReads } from '../../lib/neo/packs/coding/todo-prs.ts';
import { neoTodoReads, neoTodoWrites } from '../repositories/neo-ask-todo-repository.ts';
import { SDK_MESSAGE_TRANSACTIONS } from '../repositories/sdk-message-transactions.ts';
import { neoWakeQueueWrite } from '../repositories/neo-wake-queue-repository.ts';
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
import { submitSessionEvent } from '../repositories/session-event-submission.ts';
import { parkDeliveryJob } from '../repositories/job-delivery-parking.ts';
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
import {
  recordNeoSessionMessage,
  sentDuringTurn,
} from '../repositories/neo-session-message-repository.ts';
import {
  acceptWorkDeliveryInput,
  recordWorkDeliveryOutcome,
} from '../repositories/work-delivery-input-repository.ts';
import { recordOperationRefusal } from '../repositories/operation-refusal-repository.ts';
import { messageSearchIndexWrites } from '../repositories/sdk-message-repository.ts';
import { sessionWrites } from '../repositories/session-repository.ts';
import { sessionToolPreferenceReads } from '../repositories/session-tool-preference-read.ts';
import { spaceTaskWrites } from '../repositories/space-task-repository.ts';
import { createStandaloneTask } from '../tasks/create-task.ts';
import { editStandaloneTaskWithDependencies } from '../tasks/set-task-dependencies.ts';
import { transitionStandaloneTask } from '../tasks/transition-task.ts';
import { deleteWorkFeedBatch } from '../work-feed.ts';
import { enqueueMailboxAdmission } from '../repositories/mailbox-admission-write.ts';
import { cancelRateLimitDelivery } from '../repositories/rate-limit-cancel-write.ts';
import { claimOwnedInputWithdrawal } from '../repositories/owned-input-withdrawal-write.ts';
import type { DbOp } from './db-op.ts';
import { credentialStoreWrites } from '../repositories/credential-store-writes.ts';
import { enqueueSessionDelivery } from '../repositories/session-delivery-enqueue-write.ts';
import { releaseRateLimitDeliveries } from '../repositories/rate-limit-retry-write.ts';
import { providerRpcWrites } from '../repositories/provider-rpc-writes.ts';
import { jobStaleReclaimWrites } from '../repositories/job-stale-reclaim-write.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [
    codingPollPageReads,
    codingPollPageWrites,
    readWorkInput,
    codingMergeReads,
    codingMergeWrites,
    codingAncestryReads,
    codingAncestryWrites,
    codingQueryReads,
    codingQueryWrites,
    codingWorkReads,
    codingWorkWrites,
    codingRefReads,
    codingRefWrites,
    codingBranchReads,
    codingBranchWrites,
    neoProjectForgetWrites,
    neoProjectCleanupWrites,
    reserveNeoHomeProjects,
    neoTodoSessionReads,
    neoTodoSessionWrites,
    codingTodoPrReads,
    neoTodoReads,
    neoTodoWrites,
    sdkMessageWrites,
    neoWakeQueueWrite,
    ...SDK_MESSAGE_TRANSACTIONS,
    recordWouldRefuse,
    touchDevice,
    recordUnpaired,
    jobQueueWrites,
    submitSessionEvent,
    jobQueueReads,
    parkDeliveryJob,
    externalEventSweeps,
    messageSearchIndexWrites,
    cleanupJobs,
    ingestSessionEvent,
    readLatestSessionPrState,
    deleteWorkFeedBatch,
    sessionWrites,
    sessionToolPreferenceReads,
    toolDefaultTransitions,
    spaceTaskWrites,
    createStandaloneTask,
    transitionStandaloneTask,
    editStandaloneTaskWithDependencies,
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
    recordNeoSessionMessage,
    sentDuringTurn,
    acceptWorkDeliveryInput,
    recordWorkDeliveryOutcome,
    jobEnqueueWrites,
    enqueueMailboxAdmission,
    cancelRateLimitDelivery,
    claimOwnedInputWithdrawal,
    globalSettingsWrites,
    releaseRateLimitDeliveries,
    providerRpcWrites,
    credentialStoreWrites,
    enqueueSessionDelivery,
    jobStaleReclaimWrites,
  ].map((op) => [op.name, op])
);
