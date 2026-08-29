import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { buildSyntheticExternalEventMessage } from '../../../../src/lib/external-events/deferred-event-digest';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../../../src/lib/external-events/types';
import { buildImmediateEventMessageUuid } from '../../../../src/lib/space/runtime/immediate-event-delivery-pipeline';
import {
  admitTurnEnd,
  aggregateRender,
  buildMessage,
  capDigestBatch,
  claimPending,
  DETERMINISTIC_DIGEST_UUID_PREFIX,
  loadPending,
  orderAndDedupe,
  persistAndAppend,
  reconcileDurable,
  resolveTarget,
  runRenderPendingDigest,
  TURN_END_DIGEST_MESSAGE_BYTE_CAP,
  TURN_END_DIGEST_PENDING_ROW_CAP,
  type RenderPendingDigestCtx,
  type RenderPendingDigestDeps,
  type RenderPendingDigestLedgerMark,
} from '../../../../src/lib/space/runtime/render-pending-digest-pipeline';

const SESSION_ID = 'session-digest';
const TARGET = {
  workflowRunId: 'run-1',
  taskId: 'task-1',
  nodeId: 'node-1',
  agentName: 'coder',
};
const EXECUTION = {
  workflowRunId: 'run-1',
  workflowNodeId: 'node-1',
  agentName: 'coder',
};
const BASE_AT = 1_755_500_000_000;
const NOW = BASE_AT + 60_000;
const QUEUE_TTL_MS = 300_000;
const PR_URL = 'https://github.com/acme/widgets/pull/42';
const CHECK_TOPIC = 'github/acme/widgets/pull_request/42.check_failed';

interface Harness {
  deps: RenderPendingDigestDeps;
  rows: ExternalEventDeliveryRecord[];
  records: Map<string, ExternalEventRecord>;
  saved: SDKUserMessage[];
  reopened: Array<{ sessionId: string; uuid: string }>;
  deletedDigests: Array<{ sessionId: string; dbId: string }>;
  appended: SDKUserMessage[];
  marks: RenderPendingDigestLedgerMark[];
  listedScopes: unknown[];
  digestRows: SDKUserMessage[];
  deliveryContent: Map<string, unknown>;
  inFlight: Set<string>;
  acquiredClaims: string[];
  releasedClaims: string[];
  failedDeliveries: Array<{ eventId: string; deliveryKey: string; reason: string }>;
  admissibility: {
    ownsCurrentExecution: boolean;
    interruptInProgress: boolean;
    taskAdmissible: boolean;
    taskTerminal: boolean;
    spacePaused: boolean;
  };
  subscription: { topics: Set<string> | null };
}

function harness(overrides: Partial<RenderPendingDigestDeps> = {}): Harness {
  const rows: ExternalEventDeliveryRecord[] = [];
  const records = new Map<string, ExternalEventRecord>();
  const saved: SDKUserMessage[] = [];
  const reopened: Array<{ sessionId: string; uuid: string }> = [];
  const deletedDigests: Array<{ sessionId: string; dbId: string }> = [];
  const appended: SDKUserMessage[] = [];
  const marks: RenderPendingDigestLedgerMark[] = [];
  const listedScopes: unknown[] = [];
  const digestRows: SDKUserMessage[] = [];
  const deliveryContent = new Map<string, unknown>();
  const inFlight = new Set<string>();
  const acquiredClaims: string[] = [];
  const releasedClaims: string[] = [];
  const failedDeliveries: Array<{ eventId: string; deliveryKey: string; reason: string }> = [];
  const admissibility = {
    ownsCurrentExecution: true,
    interruptInProgress: false,
    taskAdmissible: true,
    taskTerminal: false,
    spacePaused: false,
  };
  const subscription: { topics: Set<string> | null } = { topics: null };
  const deps: RenderPendingDigestDeps = {
    getExecutionByAgentSessionId: (sessionId) => (sessionId === SESSION_ID ? EXECUTION : null),
    listPendingDeliveries: (scope) => {
      listedScopes.push(scope);
      return rows.filter((row) => scope.taskId === undefined || row.taskId === scope.taskId);
    },
    ownsCurrentExecution: () => admissibility.ownsCurrentExecution,
    isSessionInterruptInProgress: () => admissibility.interruptInProgress,
    isTaskAdmissible: () => admissibility.taskAdmissible,
    isTaskTerminal: () => admissibility.taskTerminal,
    isSpacePaused: () => admissibility.spacePaused,
    listUserMessagesByUuidPrefix: () => digestRows,
    getDeliveryContent: (_sessionId, uuid) => deliveryContent.get(uuid) ?? null,
    isDeliveryInFlight: (deliveryKey) => inFlight.has(deliveryKey),
    acquireDeliveryClaims: (deliveryKeys) => {
      acquiredClaims.push(...deliveryKeys);
    },
    releaseDeliveryClaims: (deliveryKeys) => {
      releasedClaims.push(...deliveryKeys);
    },
    now: () => NOW,
    queueTtlMs: QUEUE_TTL_MS,
    isTargetStillSubscribed: (_target, topic) =>
      subscription.topics ? subscription.topics.has(topic) : true,
    failDeliveryTerminal: (_target, eventId, deliveryKey, reason) => {
      failedDeliveries.push({ eventId, deliveryKey, reason });
    },
    getEventById: (eventId) => records.get(eventId) ?? null,
    saveDigestMessageIfAbsent: async (_sessionId, message) => {
      const uuid = String(message.uuid);
      const existing = saved.find((row) => String(row.uuid) === uuid);
      if (existing) return { dbId: `db-${uuid}`, replayed: true };
      saved.push(message);
      return { dbId: `db-${uuid}`, replayed: false };
    },
    reopenFailedDigest: (sessionId, uuid) => {
      reopened.push({ sessionId, uuid });
    },
    deleteDigestMessage: (sessionId, dbId) => {
      deletedDigests.push({ sessionId, dbId });
    },
    appendDigest: async (_sessionId, message) => {
      appended.push(message);
      return true;
    },
    markDeliveriesDelivered: (_target, entries) => {
      marks.push(...entries);
    },
    ...overrides,
  };
  return {
    deps,
    rows,
    records,
    saved,
    reopened,
    deletedDigests,
    appended,
    marks,
    listedScopes,
    digestRows,
    deliveryContent,
    inFlight,
    acquiredClaims,
    releasedClaims,
    failedDeliveries,
    admissibility,
    subscription,
  };
}

function pendingRow(
  eventId: string,
  overrides: Partial<ExternalEventDeliveryRecord> = {}
): ExternalEventDeliveryRecord {
  return {
    eventId,
    deliveryKey: `delivery-${eventId}`,
    workflowRunId: TARGET.workflowRunId,
    taskId: TARGET.taskId,
    nodeId: TARGET.nodeId,
    agentName: TARGET.agentName,
    state: 'pending',
    failureReason: null,
    deliveredAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

const SCOPE = {
  repoOwner: 'acme',
  repoName: 'widgets',
  prNumber: 42,
  prUrl: PR_URL,
};

const PAYLOADS = {
  check: {
    eventType: 'check_run',
    action: 'completed',
    actor: 'github-actions[bot]',
    ...SCOPE,
    checkName: 'build-linux',
    conclusion: 'failure',
  },
  review: {
    eventType: 'pull_request_review_comment',
    action: 'created',
    actor: 'codex',
    ...SCOPE,
    body: 'The retry loop double-counts failures.',
    commentId: '4242',
    path: 'src/delivery.ts',
    line: 87,
  },
  comment: {
    eventType: 'issue_comment',
    action: 'created',
    actor: 'reviewer',
    ...SCOPE,
    body: 'Approving now.',
    commentId: '101',
  },
};

const TOPICS = {
  check: CHECK_TOPIC,
  review: 'github/acme/widgets/pull_request/42.review_comment_polled',
  comment: 'github/acme/widgets/pull_request/42.comment_polled',
};

type SeedKind = keyof typeof PAYLOADS;

function seedPending(h: Harness, seeds: Array<[eventId: string, kind: SeedKind]>): void {
  for (const [eventId, kind] of seeds) {
    h.rows.push(pendingRow(eventId));
    h.records.set(eventId, {
      event: {
        id: eventId,
        spaceId: 'space-digest',
        source: 'github',
        topic: TOPICS[kind],
        dedupeKey: `dedupe-${eventId}`,
        occurredAt: BASE_AT,
        ingestedAt: BASE_AT,
        summary: 'fixture',
        payload: PAYLOADS[kind],
      },
      state: 'published',
      createdAt: BASE_AT,
      updatedAt: BASE_AT,
    });
  }
}

function digestMembershipRow(
  eventIds: string[],
  sendStatus?: string
): SDKUserMessage & { sendStatus?: string } {
  const row = buildSyntheticExternalEventMessage(
    SESSION_ID,
    'digest',
    `${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-${eventIds.length}`
  );
  return { ...row, externalEventIds: eventIds, sendStatus } as SDKUserMessage & {
    sendStatus?: string;
  };
}

function seedSizedComments(h: Harness, eventIds: string[]): void {
  for (const [index, eventId] of eventIds.entries()) {
    h.rows.push(pendingRow(eventId));
    h.records.set(eventId, {
      event: {
        id: eventId,
        spaceId: 'space-digest',
        source: 'github',
        topic: TOPICS.comment,
        dedupeKey: `dedupe-${eventId}`,
        occurredAt: BASE_AT + index * 1000,
        ingestedAt: BASE_AT,
        summary: 'fixture',
        payload: { ...PAYLOADS.comment, commentId: String(1000 + index) },
      },
      state: 'published',
      createdAt: BASE_AT,
      updatedAt: BASE_AT,
    });
  }
}

function messageBytesFor(h: Harness, eventIds: string[]): number {
  const rows = h.rows.filter((row) => eventIds.includes(row.eventId));
  const ctx = buildMessage(
    aggregateRender(orderAndDedupe(loadPending(ctxOf(h, { pendingRows: rows, target: TARGET }))))
  );
  return Buffer.byteLength(JSON.stringify(ctx.digestMessage), 'utf8');
}

function cappedEssences(
  h: Harness,
  overrides: Partial<RenderPendingDigestCtx> = {}
): RenderPendingDigestCtx {
  return capDigestBatch({
    ...ctxOf(h, { target: TARGET }),
    ...loadPending(ctxOf(h, { pendingRows: h.rows })),
    ...overrides,
  });
}

function ctxOf(
  h: Harness,
  overrides: Partial<RenderPendingDigestCtx> = {}
): RenderPendingDigestCtx {
  return { sessionId: SESSION_ID, taskId: TARGET.taskId, deps: h.deps, ...overrides };
}

function runStages(h: Harness): RenderPendingDigestCtx {
  return buildMessage(
    aggregateRender(orderAndDedupe(loadPending(ctxOf(h, { pendingRows: h.rows, target: TARGET }))))
  );
}

function claimed(
  h: Harness,
  overrides: Partial<RenderPendingDigestCtx> = {}
): RenderPendingDigestCtx {
  return claimPending(ctxOf(h, { target: TARGET, scopedRows: h.rows, ...overrides }));
}

describe('render-pending-digest pipeline', () => {
  it('resolveTarget skips when the session owns no execution', () => {
    const h = harness({ getExecutionByAgentSessionId: () => null });
    const ctx = resolveTarget(ctxOf(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_execution' });
  });

  it('resolveTarget skips when no scoped ledger rows are pending', () => {
    const h = harness();
    const ctx = resolveTarget(ctxOf(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
    expect(h.listedScopes).toEqual([
      {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      },
    ]);
  });

  it('resolveTarget defaults the target taskId from the first scoped row', () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    const ctx = resolveTarget(ctxOf(h, { taskId: undefined }));
    expect(ctx.target).toEqual(TARGET);
    expect(h.listedScopes).toEqual([
      { workflowRunId: 'run-1', nodeId: 'node-1', agentName: 'coder' },
    ]);
  });

  it('resolveTarget scopes pending rows by the requested taskId', () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.rows.push(pendingRow('ev-other', { taskId: 'task-2' }));
    const ctx = resolveTarget(ctxOf(h));
    expect(ctx.scopedRows?.map((row) => row.eventId)).toEqual(['ev-a']);
  });

  it('resolveTarget narrows fallback rows to the fallback task when taskId is omitted', () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.rows.push(pendingRow('ev-other', { taskId: 'task-2' }));
    const ctx = resolveTarget(ctxOf(h, { taskId: undefined }));
    expect(ctx.target).toEqual(TARGET);
    expect(ctx.scopedRows?.map((row) => row.eventId)).toEqual(['ev-a']);
  });

  it('admitTurnEnd halts on each admission gate with a distinct reason', () => {
    const cases = [
      { ownsCurrentExecution: false, reason: 'session_not_current' },
      { interruptInProgress: true, reason: 'session_interrupted' },
      { taskAdmissible: false, reason: 'task_not_admissible' },
      { spacePaused: true, reason: 'space_paused' },
    ];
    for (const { reason, ...flags } of cases) {
      const h = harness();
      Object.assign(h.admissibility, flags);
      const ctx = admitTurnEnd(ctxOf(h, { target: TARGET }));
      expect(ctx.outcome).toEqual({ action: 'skip', reason });
    }
  });

  it('admitTurnEnd holds scoped rows without terminal-failing them during an interrupt', () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.admissibility.interruptInProgress = true;
    const ctx = admitTurnEnd(ctxOf(h, { target: TARGET, scopedRows: h.rows }));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'session_interrupted' });
    expect(h.marks).toEqual([]);
    expect(h.failedDeliveries).toEqual([]);
  });

  it('admitTurnEnd runs terminal-task cleanup even while the session is interrupted', () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.admissibility.interruptInProgress = true;
    h.admissibility.taskAdmissible = false;
    h.admissibility.taskTerminal = true;
    const ctx = admitTurnEnd(ctxOf(h, { target: TARGET, scopedRows: h.rows }));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a', reason: 'task_terminal' },
    ]);
  });

  it('admitTurnEnd terminally fails scoped rows for a terminal task, not a transiently stopped one', () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.admissibility.taskAdmissible = false;
    h.admissibility.taskTerminal = true;
    const ctx = admitTurnEnd(ctxOf(h, { target: TARGET, scopedRows: h.rows }));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a', reason: 'task_terminal' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b', reason: 'task_terminal' },
    ]);
    const stopped = harness();
    seedPending(stopped, [['ev-a', 'check']]);
    stopped.admissibility.taskAdmissible = false;
    const stoppedCtx = admitTurnEnd(ctxOf(stopped, { target: TARGET, scopedRows: stopped.rows }));
    expect(stoppedCtx.outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });
    expect(stopped.failedDeliveries).toEqual([]);
  });

  it('admitTurnEnd finalizes consumed-evidenced rows instead of terminal-failing them for a terminal task', () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a'], 'consumed'));
    h.admissibility.taskAdmissible = false;
    h.admissibility.taskTerminal = true;
    const ctx = admitTurnEnd(ctxOf(h, { target: TARGET, scopedRows: h.rows }));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });
    expect(h.marks).toEqual([{ eventId: 'ev-a', deliveryKey: 'delivery-ev-a' }]);
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b', reason: 'task_terminal' },
    ]);
  });

  it('admitTurnEnd finalizes rows evidenced by a consumed persisted digest for a terminal task', () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.digestRows.push(digestMembershipRow(['ev-a'], 'consumed'));
    h.admissibility.taskAdmissible = false;
    h.admissibility.taskTerminal = true;
    const ctx = admitTurnEnd(ctxOf(h, { target: TARGET, scopedRows: h.rows }));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'task_not_admissible' });
    expect(h.marks).toEqual([{ eventId: 'ev-a', deliveryKey: 'delivery-ev-a' }]);
    expect(h.failedDeliveries).toEqual([]);
  });

  it('reconcileDurable collects legacy rows, memberships, and exact replay matches', () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-consumed'], 'consumed'));
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b']));
    h.digestRows.push(digestMembershipRow(['ev-c'], 'enqueued'));
    const ctx = reconcileDurable(ctxOf(h, { scopedRows: h.rows }));
    expect(ctx.consumedDurableEventIds).toEqual(new Set(['ev-consumed']));
    expect(ctx.digestMembershipEventIds).toEqual(new Set(['ev-c']));
    expect(ctx.replayable).toBe(true);
  });

  it('reconcileDurable marks partial memberships as not replayable', () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a'], 'submitted'));
    const ctx = reconcileDurable(ctxOf(h, { scopedRows: h.rows }));
    expect(ctx.replayable).toBe(false);
    expect(ctx.digestMembershipEventIds).toEqual(new Set(['ev-a']));
  });

  it('reconcileDurable treats only exact pending-set matches as replayable, not subsets', () => {
    const h = harness();
    seedPending(h, [['ev-b', 'review']]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b']));
    const ctx = reconcileDurable(ctxOf(h, { scopedRows: h.rows }));
    expect(ctx.replayable).toBe(false);
    expect(ctx.replayDigestMessage).toBeUndefined();
  });

  it('claimPending skips in-flight, membership, and immediate-tier rows without marking them', () => {
    const h = harness();
    for (const eventId of ['ev-inflight', 'ev-member', 'ev-immediate', 'ev-ok']) {
      seedPending(h, [[eventId, 'comment']]);
    }
    h.inFlight.add('delivery-ev-inflight');
    h.digestRows.push(digestMembershipRow(['ev-member'], 'enqueued'));
    h.deliveryContent.set(buildImmediateEventMessageUuid('ev-immediate', 'delivery-ev-immediate'), {
      sendStatus: 'submitted',
    });
    const ctx = claimPending(
      ctxOf(h, {
        target: TARGET,
        scopedRows: h.rows,
        digestMembershipEventIds: new Set(['ev-member']),
        replayable: false,
      })
    );
    expect(ctx.pendingRows?.map((row) => row.eventId)).toEqual(['ev-ok']);
    expect(h.acquiredClaims).toEqual(['delivery-ev-ok']);
    expect(h.marks).toEqual([]);
    expect(h.failedDeliveries).toEqual([]);
  });

  it('claimPending lets rows whose immediate message failed fall back to the digest', () => {
    const h = harness();
    seedPending(h, [
      ['ev-failed', 'comment'],
      ['ev-live', 'comment'],
      ['ev-eaten', 'comment'],
    ]);
    h.deliveryContent.set(buildImmediateEventMessageUuid('ev-failed', 'delivery-ev-failed'), {
      sendStatus: 'failed',
    });
    h.deliveryContent.set(buildImmediateEventMessageUuid('ev-live', 'delivery-ev-live'), {
      sendStatus: 'submitted',
    });
    h.deliveryContent.set(buildImmediateEventMessageUuid('ev-eaten', 'delivery-ev-eaten'), {
      sendStatus: 'consumed',
    });
    const ctx = claimed(h);
    expect(ctx.pendingRows?.map((row) => row.eventId)).toEqual(['ev-failed']);
    expect(h.marks).toEqual([{ eventId: 'ev-eaten', deliveryKey: 'delivery-ev-eaten' }]);
  });

  it('claimPending scans past nonclaimable rows instead of stopping at the cap boundary', () => {
    const h = harness();
    const blocked = 20;
    for (let index = 0; index < blocked; index++) {
      h.rows.push(pendingRow(`ev-blocked-${index}`));
    }
    for (let index = 0; index < TURN_END_DIGEST_PENDING_ROW_CAP; index++) {
      h.rows.push(pendingRow(`ev-fresh-${index}`));
    }
    const membershipIds = new Set(h.rows.slice(0, blocked).map((row) => row.eventId));
    const ctx = claimPending(
      ctxOf(h, { target: TARGET, scopedRows: h.rows, digestMembershipEventIds: membershipIds })
    );
    expect(ctx.pendingRows).toHaveLength(TURN_END_DIGEST_PENDING_ROW_CAP);
    expect(ctx.pendingRows?.every((row) => row.eventId.startsWith('ev-fresh-'))).toBe(true);
  });

  it('claimPending terminally fails TTL-expired rows instead of claiming them', () => {
    const h = harness();
    seedPending(h, [['ev-ttl', 'comment']]);
    const record = h.records.get('ev-ttl');
    if (record) h.records.set('ev-ttl', { ...record, createdAt: NOW - QUEUE_TTL_MS - 1 });
    const ctx = claimed(h);
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-ttl', deliveryKey: 'delivery-ev-ttl', reason: 'ttl_expired' },
    ]);
  });

  it('claimPending terminally fails rows whose subscription is gone', () => {
    const h = harness();
    seedPending(h, [['ev-sub', 'comment']]);
    h.subscription.topics = new Set([TOPICS.check]);
    const ctx = claimed(h);
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.failedDeliveries).toEqual([
      {
        eventId: 'ev-sub',
        deliveryKey: 'delivery-ev-sub',
        reason: 'subscription_no_longer_active',
      },
    ]);
  });

  it('claimPending caps the claimed set at the turn-end row cap', () => {
    const h = harness();
    for (let index = 0; index < TURN_END_DIGEST_PENDING_ROW_CAP + 5; index++) {
      h.rows.push(pendingRow(`ev-${index}`));
    }
    const ctx = claimed(h);
    expect(ctx.pendingRows).toHaveLength(TURN_END_DIGEST_PENDING_ROW_CAP);
    expect(h.acquiredClaims).toHaveLength(TURN_END_DIGEST_PENDING_ROW_CAP);
  });

  it('loadPending skips when the claimed set is empty', () => {
    const h = harness();
    const ctx = loadPending(ctxOf(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
  });

  it('loadPending reads essences from the store by eventId', () => {
    const h = harness();
    seedPending(h, [
      ['ev-check', 'check'],
      ['ev-gone', 'check'],
    ]);
    h.records.delete('ev-gone');
    const ctx = loadPending(ctxOf(h, { pendingRows: h.rows }));
    expect(ctx.pendingRows).toHaveLength(2);
    const essence = ctx.essences?.[0];
    expect(essence).toMatchObject({
      eventId: 'ev-check',
      topic: CHECK_TOPIC,
      eventType: 'check_run',
      checkName: 'build-linux',
      conclusion: 'failure',
      prNumber: 42,
    });
  });

  it('orderAndDedupe dedupes by eventId, orders by eventId, and skips when nothing renderable', () => {
    const h = harness();
    const deduped = orderAndDedupe(
      ctxOf(h, {
        essences: [
          { eventId: 'ev-b', topic: 'github/a/b/c.polled' },
          { eventId: 'ev-a', topic: 'github/a/b/c.polled' },
          { eventId: 'ev-a', topic: 'github/a/b/c.polled' },
        ],
      })
    );
    expect(deduped.essences?.map((essence) => essence.eventId)).toEqual(['ev-a', 'ev-b']);
    const empty = orderAndDedupe(ctxOf(h, { essences: [] }));
    expect(empty.outcome).toEqual({ action: 'skip', reason: 'no_renderable_events' });
  });

  it('aggregateRender renders through the single aggregate digest renderer', () => {
    const h = harness();
    seedPending(h, [
      ['ev-check', 'check'],
      ['ev-review', 'review'],
    ]);
    const ctx = aggregateRender(orderAndDedupe(loadPending(ctxOf(h, { pendingRows: h.rows }))));
    expect(ctx.digestText).toContain('External events while you were working (2 events, PR #42):');
    expect(ctx.digestText).toContain('CI check "build-linux"');
    expect(ctx.digestText).toContain('Review comment');
  });

  it('capDigestBatch keeps a fitting set unchanged at the default cap', () => {
    const h = harness();
    seedSizedComments(h, ['ev-a', 'ev-b', 'ev-c']);
    h.deps.digestMessageByteCap = TURN_END_DIGEST_MESSAGE_BYTE_CAP;
    const ctx = cappedEssences(h);
    expect(ctx.essences?.map((essence) => essence.eventId)).toEqual(['ev-a', 'ev-b', 'ev-c']);
  });

  it('capDigestBatch fits exactly at the cap boundary and splits one event past it', () => {
    const h = harness();
    seedSizedComments(h, ['ev-a', 'ev-b', 'ev-c']);
    const pairBytes = messageBytesFor(h, ['ev-a', 'ev-b']);
    h.deps.digestMessageByteCap = pairBytes;
    const atCap = cappedEssences(h);
    expect(atCap.essences?.map((essence) => essence.eventId)).toEqual(['ev-a', 'ev-b']);
    h.deps.digestMessageByteCap = pairBytes - 1;
    const underCap = cappedEssences(h);
    expect(underCap.essences?.map((essence) => essence.eventId)).toEqual(['ev-a']);
  });

  it('capDigestBatch splits oldest-first by occurrence, not by eventId order', () => {
    const h = harness();
    seedSizedComments(h, ['ev-d', 'ev-c', 'ev-b', 'ev-a']);
    h.deps.digestMessageByteCap = messageBytesFor(h, ['ev-d', 'ev-c']);
    const ctx = cappedEssences(h);
    expect(ctx.essences?.map((essence) => essence.eventId)).toEqual(['ev-d', 'ev-c']);
  });

  it('capDigestBatch emits an over-cap single event as its own batch', () => {
    const h = harness();
    seedSizedComments(h, ['ev-d', 'ev-c', 'ev-b', 'ev-a']);
    h.deps.digestMessageByteCap = 1;
    const ctx = cappedEssences(h);
    expect(ctx.essences?.map((essence) => essence.eventId)).toEqual(['ev-d']);
  });

  it('capDigestBatch leaves a replayable set uncapped', () => {
    const h = harness();
    seedSizedComments(h, ['ev-a', 'ev-b', 'ev-c']);
    h.deps.digestMessageByteCap = 1;
    const essences = loadPending(ctxOf(h, { pendingRows: h.rows })).essences!;
    const ctx = capDigestBatch(ctxOf(h, { target: TARGET, essences, replayable: true }));
    expect(ctx.essences).toBe(essences);
  });

  it('buildMessage derives a deterministic uuid and embeds the membership', () => {
    const essence = (eventId: string) => ({ eventId, topic: 'github/a/b/c.polled' });
    const build = (ids: string[]) =>
      buildMessage(ctxOf(harness(), { essences: ids.map(essence), digestText: 't' }));
    const ab1 = build(['ev-b', 'ev-a']);
    const ab2 = build(['ev-a', 'ev-b']);
    expect(ab1.digestUuid).toBe(ab2.digestUuid);
    expect(ab1.digestUuid).not.toBe(build(['ev-a', 'ev-c']).digestUuid);
    expect(ab1.digestUuid).toMatch(/^digest-/);
    expect(String(ab1.digestMessage?.uuid)).toBe(ab1.digestUuid);
    expect(ab1.digestMessage?.session_id).toBe(SESSION_ID);
    expect((ab1.digestMessage as { externalEventIds?: string[] }).externalEventIds).toEqual([
      'ev-a',
      'ev-b',
    ]);
  });

  it('buildMessage replays the matched persisted digest verbatim', () => {
    const stored = digestMembershipRow(['ev-a', 'ev-b']);
    const ctx = buildMessage(
      ctxOf(harness(), {
        essences: [{ eventId: 'ev-b', topic: TOPICS.review }],
        digestText: 't',
        replayable: true,
        replayDigestMessage: stored,
        replayEventIds: new Set(['ev-b']),
      })
    );
    expect(ctx.digestUuid).toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2`);
    expect(ctx.digestMessage).toBe(stored);
  });

  it('persistAndAppend saves, hands off to the mailbox, and marks ledger rows delivered', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    const ctx = await persistAndAppend(runStages(h));
    expect(ctx.outcome).toMatchObject({ action: 'delivered', replayed: false });
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toHaveLength(1);
    expect(h.marks).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b' },
    ]);
  });

  it('persistAndAppend holds pending when the mailbox rejects or throws', async () => {
    for (const override of [
      { appendDigest: async () => false },
      {
        appendDigest: async () => {
          throw new Error('mailbox down');
        },
      },
    ]) {
      const h = harness(override);
      seedPending(h, [['ev-a', 'check']]);
      const ctx = await persistAndAppend(runStages(h));
      expect(ctx.outcome?.action).toBe('held');
      expect(h.marks).toEqual([]);
    }
  });

  it('persistAndAppend fails without marking when persisting the digest throws', async () => {
    const h = harness({
      saveDigestMessageIfAbsent: async () => {
        throw new Error('db locked');
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const ctx = await persistAndAppend(runStages(h));
    expect(ctx.outcome).toMatchObject({ action: 'failed', stage: 'persistDigest' });
    expect(h.marks).toEqual([]);
  });

  it('persistAndAppend deletes an interrupt-struck digest row so the generic flush cannot enqueue it', async () => {
    const h = harness({
      appendDigest: async () => {
        h.admissibility.interruptInProgress = true;
        return true;
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const ctx = await persistAndAppend(runStages(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'session_interrupted' });
    expect(h.saved).toHaveLength(1);
    expect(h.deletedDigests).toEqual([
      { sessionId: SESSION_ID, dbId: `db-${String(h.saved[0]!.uuid)}` },
    ]);
    expect(h.marks).toEqual([]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('persistAndAppend does not delete a replayed digest row owned by another task on interrupt', async () => {
    const h = harness({
      saveDigestMessageIfAbsent: async (_sessionId, message) => {
        const uuid = String(message.uuid);
        return { dbId: `db-${uuid}`, replayed: true };
      },
      appendDigest: async () => {
        h.admissibility.interruptInProgress = true;
        return true;
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const ctx = await persistAndAppend(runStages(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'session_interrupted' });
    expect(h.deletedDigests).toEqual([]);
    expect(h.marks).toEqual([]);
  });

  it('persistAndAppend reports a digestCleanup failure when an interrupt-struck row cannot be deleted', async () => {
    const h = harness({
      appendDigest: async () => {
        h.admissibility.interruptInProgress = true;
        return true;
      },
      deleteDigestMessage: () => {
        throw new Error('delete rejected');
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const ctx = await persistAndAppend(runStages(h));
    expect(ctx.outcome).toMatchObject({ action: 'failed', stage: 'digestCleanup' });
    expect(h.marks).toEqual([]);
  });

  it('end to end: one digest message for a mixed pending set, all rows marked', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-check', 'check'],
      ['ev-review', 'review'],
      ['ev-comment', 'comment'],
    ]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventIds).toEqual(['ev-check', 'ev-comment', 'ev-review']);
    expect(outcome.deliveryKeys).toEqual([
      'delivery-ev-check',
      'delivery-ev-review',
      'delivery-ev-comment',
    ]);
    expect(outcome.text).toContain('External events while you were working (3 events, PR #42):');
    expect(outcome.text).toContain('CI check "build-linux"');
    expect(outcome.text).toContain('Review comment');
    expect(outcome.text).toContain('PR comment');
    expect(h.saved).toHaveLength(1);
    expect(h.marks).toHaveLength(3);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: execution rebound during the persist gap neither appends nor marks', async () => {
    const h = harness({
      saveDigestMessageIfAbsent: async (_sessionId, message) => {
        h.admissibility.ownsCurrentExecution = false;
        const uuid = String(message.uuid);
        h.saved.push(message);
        return { dbId: `db-${uuid}`, replayed: false };
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_not_current' });
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: an interrupt starting during the persist gap neither appends nor marks', async () => {
    const h = harness({
      saveDigestMessageIfAbsent: async (_sessionId, message) => {
        h.admissibility.interruptInProgress = true;
        const uuid = String(message.uuid);
        h.saved.push(message);
        return { dbId: `db-${uuid}`, replayed: false };
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_interrupted' });
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: an interrupt starting during the append await skips before marking', async () => {
    const h = harness({
      appendDigest: async (_sessionId, message) => {
        h.appended.push(message);
        h.admissibility.interruptInProgress = true;
        return true;
      },
    });
    seedPending(h, [['ev-a', 'check']]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_interrupted' });
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toHaveLength(1);
    expect(h.marks).toEqual([]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: a pending subset of a persisted digest renders fresh instead of replaying stored content', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.rows.splice(0, 1);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b']));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.uuid).not.toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2`);
    expect(outcome.replayed).toBe(false);
    expect(outcome.eventIds).toEqual(['ev-b']);
    expect(h.marks).toEqual([{ eventId: 'ev-b', deliveryKey: 'delivery-ev-b' }]);
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toHaveLength(1);
  });

  it('end to end: an exact pending-set match on a persisted digest replays it verbatim', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b'], 'failed'));
    h.saved.push(digestMembershipRow(['ev-a', 'ev-b'], 'failed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.uuid).toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2`);
    expect(outcome.replayed).toBe(true);
    expect(outcome.text).toBe('digest');
    expect(h.marks).toHaveLength(2);
    expect(h.reopened).toEqual([
      { sessionId: SESSION_ID, uuid: `${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2` },
    ]);
  });

  it('end to end: a fresh digest render never reopens a stored row', async () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    expect(h.reopened).toEqual([]);
  });

  it('end to end: pending rows evidenced by consumed legacy rows finalize without re-rendering', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-fresh', 'check'],
      ['ev-eaten', 'comment'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-eaten'], 'consumed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventIds).toEqual(['ev-fresh']);
    expect(h.marks).toEqual([
      { eventId: 'ev-eaten', deliveryKey: 'delivery-ev-eaten' },
      { eventId: 'ev-fresh', deliveryKey: 'delivery-ev-fresh' },
    ]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: every pending row evidenced by consumed rows finalizes without a digest', async () => {
    const h = harness();
    seedPending(h, [['ev-eaten', 'comment']]);
    h.digestRows.push(digestMembershipRow(['ev-eaten'], 'consumed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.marks).toEqual([{ eventId: 'ev-eaten', deliveryKey: 'delivery-ev-eaten' }]);
    expect(h.saved).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it('end to end: a consumed persisted digest finalizes its pending rows instead of replaying', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b'], 'consumed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.marks).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b' },
    ]);
    expect(h.saved).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it('end to end: a terminalized member of a persisted digest forces a fresh digest for the survivors', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b']));
    const record = h.records.get('ev-b');
    if (record) h.records.set('ev-b', { ...record, createdAt: NOW - QUEUE_TTL_MS - 1 });
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.uuid).not.toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2`);
    expect(outcome.eventIds).toEqual(['ev-a']);
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b', reason: 'ttl_expired' },
    ]);
    expect(h.marks).toEqual([{ eventId: 'ev-a', deliveryKey: 'delivery-ev-a' }]);
  });

  it('end to end: an event expiring during the persist gap is terminalized and not marked', async () => {
    const h = harness({
      saveDigestMessageIfAbsent: async (_sessionId, message) => {
        const record = h.records.get('ev-b');
        if (record) h.records.set('ev-b', { ...record, createdAt: NOW - QUEUE_TTL_MS - 1 });
        const uuid = String(message.uuid);
        h.saved.push(message);
        return { dbId: `db-${uuid}`, replayed: false };
      },
    });
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.failedDeliveries).toEqual([
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b', reason: 'ttl_expired' },
    ]);
    expect(h.saved).toHaveLength(1);
    expect(h.appended).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: pending rows covered by an in-flight persisted digest hold for a retryable reconcile', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b'], 'enqueued'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({
      action: 'skip',
      reason: 'no_claimable_events',
      heldDigestInFlight: true,
    });
    expect(h.saved).toEqual([]);
    expect(h.appended).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.failedDeliveries).toEqual([]);
  });

  it('end to end: pending rows covered by a consumed persisted digest are marked delivered', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a', 'ev-b'], 'consumed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_claimable_events' });
    expect(h.saved).toEqual([]);
    expect(h.appended).toEqual([]);
    expect(h.marks).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b' },
    ]);
    expect(h.failedDeliveries).toEqual([]);
  });

  it('end to end: pending rows covered by separate persisted digests render one fresh combined digest', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    h.digestRows.push(digestMembershipRow(['ev-a'], 'deferred'));
    h.digestRows.push(digestMembershipRow(['ev-b'], 'failed'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventIds).toEqual(['ev-a', 'ev-b']);
    expect(outcome.uuid).not.toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-1`);
    expect(outcome.uuid).not.toBe(`${DETERMINISTIC_DIGEST_UUID_PREFIX}fixture-2`);
    expect(h.marks).toHaveLength(2);
  });

  it('end to end: empty pending set is a skip', async () => {
    const h = harness();
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
  });

  it('end to end: one event with two pending ledger rows renders once and marks both rows', async () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.rows.push(pendingRow('ev-a', { deliveryKey: 'delivery-2' }));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventIds).toEqual(['ev-a']);
    expect(outcome.deliveryKeys).toEqual(['delivery-ev-a', 'delivery-2']);
    expect(outcome.text).toContain('(1 event, PR #42):');
    expect(h.marks).toHaveLength(2);
  });

  it('end to end: rows without a store record stay pending and are not marked', async () => {
    const h = harness();
    seedPending(h, [['ev-ok', 'check']]);
    h.rows.push(pendingRow('ev-gone'));
    const outcome = await runRenderPendingDigest(h.deps, {
      sessionId: SESSION_ID,
      taskId: TARGET.taskId,
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventIds).toEqual(['ev-ok']);
    expect(outcome.deliveryKeys).toEqual(['delivery-ev-ok']);
  });

  it('crash-replay pin: same pending set re-flushed after a crash reuses the uuid without a second digest row', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-a', 'check'],
      ['ev-b', 'review'],
    ]);
    const input = { sessionId: SESSION_ID, taskId: TARGET.taskId };
    const crashed = {
      ...h.deps,
      markDeliveriesDelivered: () => {
        throw new Error('crash after mailbox acceptance');
      },
    };
    const first = await runRenderPendingDigest(crashed, input);
    expect(first.action).toBe('failed');
    expect(h.saved).toHaveLength(1);
    const replayedUuid = String(h.saved[0]?.uuid);
    const second = await runRenderPendingDigest(h.deps, input);
    expect(second.action).toBe('delivered');
    if (second.action !== 'delivered') return;
    expect(second.replayed).toBe(true);
    expect(second.uuid).toBe(replayedUuid);
    expect(second.dbId).toBe(`db-${replayedUuid}`);
    expect(h.saved).toHaveLength(1);
    expect(h.marks).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b' },
    ]);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: an over-cap backlog drains across renders as N under-cap digests', async () => {
    const h = harness();
    seedSizedComments(h, ['ev-a', 'ev-b', 'ev-c', 'ev-d']);
    h.deps.digestMessageByteCap = messageBytesFor(h, ['ev-a', 'ev-b']);
    const input = { sessionId: SESSION_ID, taskId: TARGET.taskId };
    const first = await runRenderPendingDigest(h.deps, input);
    expect(first.action).toBe('delivered');
    if (first.action !== 'delivered') return;
    expect(first.eventIds).toEqual(['ev-a', 'ev-b']);
    expect(first.text).toContain('(2 events, PR #42):');
    expect(Buffer.byteLength(JSON.stringify(h.saved[0]), 'utf8')).toBeLessThanOrEqual(
      h.deps.digestMessageByteCap!
    );
    expect(h.marks).toEqual([
      { eventId: 'ev-a', deliveryKey: 'delivery-ev-a' },
      { eventId: 'ev-b', deliveryKey: 'delivery-ev-b' },
    ]);
    h.rows.splice(0, 2);
    const second = await runRenderPendingDigest(h.deps, input);
    expect(second.action).toBe('delivered');
    if (second.action !== 'delivered') return;
    expect(second.eventIds).toEqual(['ev-c', 'ev-d']);
    expect(second.uuid).not.toBe(first.uuid);
    expect(Buffer.byteLength(JSON.stringify(h.saved[1]), 'utf8')).toBeLessThanOrEqual(
      h.deps.digestMessageByteCap!
    );
    expect(h.marks).toHaveLength(4);
    expect(h.saved).toHaveLength(2);
    expect(h.releasedClaims).toEqual(h.acquiredClaims);
  });

  it('end to end: a held capped batch retries its own digest, then the remainder drains', async () => {
    const h = harness({ appendDigest: async () => false });
    seedSizedComments(h, ['ev-a', 'ev-b', 'ev-c']);
    h.deps.digestMessageByteCap = messageBytesFor(h, ['ev-a', 'ev-b']);
    const input = { sessionId: SESSION_ID, taskId: TARGET.taskId };
    const held = await runRenderPendingDigest(h.deps, input);
    expect(held).toMatchObject({ action: 'held', reason: 'mailbox_rejected' });
    expect(h.marks).toEqual([]);
    expect((h.saved[0] as { externalEventIds?: string[] }).externalEventIds).toEqual([
      'ev-a',
      'ev-b',
    ]);
    h.deps.appendDigest = async (_sessionId, message) => {
      h.appended.push(message);
      return true;
    };
    const retried = await runRenderPendingDigest(h.deps, input);
    expect(retried.action).toBe('delivered');
    if (retried.action !== 'delivered') return;
    expect(retried.replayed).toBe(true);
    expect(retried.eventIds).toEqual(['ev-a', 'ev-b']);
    h.rows.splice(0, 2);
    const remainder = await runRenderPendingDigest(h.deps, input);
    expect(remainder.action).toBe('delivered');
    if (remainder.action !== 'delivered') return;
    expect(remainder.eventIds).toEqual(['ev-c']);
    expect(h.marks).toHaveLength(3);
    expect(h.saved).toHaveLength(2);
  });
});
