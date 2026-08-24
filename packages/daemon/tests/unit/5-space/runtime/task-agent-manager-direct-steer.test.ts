import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventQueueMetrics } from '../../../../src/lib/external-events/queue-health-metrics';
import { classifyExternalEventDirectSteer } from '../../../../src/lib/external-events/event-tiers';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';

const SESSION_ID = 'session-steer';
const PR_URL = 'https://github.com/lsm/HyperNeo/pull/2828';
const DEBOUNCE_MS = 50;
const MAX_BURST_WAIT_MS = 150;
const COOLDOWN_MS = 200;

interface StoredRow {
  message: SDKUserMessage;
  status: string;
  dbId: string;
}

interface EnqueuedJob {
  queue: string;
  payload: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function externalEvent(
  topic: string,
  eventId: string,
  payload: Record<string, unknown>,
  occurredAt = Date.now()
): ExternalEventPublishedPayload {
  return {
    namespaceId: 'ns',
    spaceId: 'space-1',
    eventId,
    source: 'github',
    topic,
    dedupeKey: eventId,
    summary: 'summary',
    externalUrl: `${PR_URL}#${eventId}`,
    occurredAt,
    ingestedAt: occurredAt,
    payload: {
      repoOwner: 'lsm',
      repoName: 'HyperNeo',
      prNumber: 2828,
      prUrl: PR_URL,
      body: '',
      ...payload,
    },
  };
}

function reviewVerdictText(state: string, eventId = 'rev-1'): string {
  return formatExternalEventEssence(
    externalEvent(
      'github/lsm/hyperneo/pull_request/2828.review_submitted',
      eventId,
      {
        eventType: 'pull_request_review',
        action: 'submitted',
        actor: 'codex[bot]',
        state,
        reviewer: 'codex[bot]',
        reviewerBot: true,
        reviewId: '0987',
      },
      Date.UTC(2026, 7, 23, 16, 12)
    )
  );
}

function reviewCommentText(eventId: string, actor = 'codex[bot]'): string {
  return formatExternalEventEssence(
    externalEvent(
      'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
      eventId,
      {
        eventType: 'pull_request_review_comment',
        action: 'polled',
        actor,
        body: 'Consider handling the empty-burst case here.',
        commentId: `c-${eventId}`,
        path: 'packages/daemon/src/lib/space/runtime/task-agent-manager.ts',
        line: 3400,
        inReplyToId: '',
      },
      Date.UTC(2026, 7, 23, 16, 12)
    )
  );
}

function checkFailedText(eventId: string, checkName: string): string {
  return formatExternalEventEssence(
    externalEvent('github/lsm/hyperneo/pull_request/2828.check_failed', eventId, {
      eventType: 'check_run',
      action: 'failed',
      actor: 'github-actions[bot]',
      checkName,
      conclusion: 'failure',
    })
  );
}

function digestTierPrStateText(eventId: string): string {
  return formatExternalEventEssence(
    externalEvent('github/lsm/hyperneo/pull_request/2828.polled', eventId, {
      eventType: 'pull_request',
      action: 'polled',
      actor: 'lsm',
      state: 'open',
    })
  );
}

function rowText(message: SDKUserMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === 'string' ? block.text : '';
}

interface Harness {
  manager: TaskAgentManager;
  rows: StoredRow[];
  statusUpdates: Array<{ dbIds: string[]; status: string }>;
  jobs: EnqueuedJob[];
  metrics: ExternalEventQueueMetrics;
  memoryQueue: Array<{ messageId: string; content: unknown }>;
}

function makeHarness(processingStatusArg = 'processing'): Harness {
  const rows: StoredRow[] = [];
  const statusUpdates: Array<{ dbIds: string[]; status: string }> = [];
  const jobs: EnqueuedJob[] = [];
  const metrics = new ExternalEventQueueMetrics();
  const memoryQueue: Array<{ messageId: string; content: unknown }> = [];
  let processingStatus = processingStatusArg;

  const session = {
    session: { id: SESSION_ID },
    getProcessingState: () => ({ status: processingStatus }),
    handleQueryTrigger: mock(async () => ({ success: true, messageCount: 0 })),
    ensureQueryStarted: mock(async () => {}),
    clearConversationContext: mock(async () => {}),
    messageQueue: {
      enqueueWithId: mock(async (messageId: string, content: unknown) => {
        memoryQueue.push({ messageId, content });
      }),
      size: () => 0,
    },
  } as unknown as AgentSession;

  const config = {
    db: {
      getDatabase: () => ({}),
      saveUserMessage: mock((_sessionId: string, message: SDKUserMessage, sendStatus: string) => {
        const dbId = `db-${rows.length + 1}`;
        rows.push({ message, status: sendStatus, dbId });
        return dbId;
      }),
      updateMessageStatus: mock((dbIds: string[], status: string) => {
        statusUpdates.push({ dbIds, status });
        for (const row of rows) {
          if (dbIds.includes(row.dbId)) row.status = status;
        }
      }),
      getUserMessagesByStatus: mock((_sessionId: string, status: string) => {
        const messages = rows.filter((row) => row.status === status).map((row) => row.message);
        return { messages, total: messages.length };
      }),
      getUserMessageIdsByStatus: mock(() => []),
      getSDKMessageRepo: () => ({
        getDeliveryContent: () => null,
        reopenDeliveryByUuid: () => null,
        markDeliveryFailedByUuid: () => null,
        markDeliveryDeferredByUuid: (uuid: string) =>
          rows.find((row) => row.message.uuid === uuid)?.dbId ?? null,
        getMessageByStatusAndUuid: () => null,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
        getActiveDeliveryRole: () => null,
        enqueue: (job: EnqueuedJob) => {
          jobs.push(job);
        },
      }),
    },
    internalEventBus: {
      subscribe: mock(() => () => {}),
      publish: mock(async () => {}),
    },
    nodeExecutionRepo: {
      getByAgentSessionId: () => null,
      listByAgentSessionId: () => [],
    },
    workflowRunRepo: { getRun: () => ({ workflowId: 'wf-steer' }) },
    taskRepo: {
      getTask: () => null,
      listByWorkflowRunIncludingArchived: () => [],
    },
    spaceRuntimeService: { queueHealthMetrics: metrics },
    directSteerDebounceMs: DEBOUNCE_MS,
    directSteerMaxBurstWaitMs: MAX_BURST_WAIT_MS,
    directSteerCooldownMs: COOLDOWN_MS,
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
  return { manager, rows, statusUpdates, jobs, metrics, memoryQueue };
}

async function injectDefer(manager: TaskAgentManager, text: string): Promise<void> {
  await manager.injectSubSessionMessage(SESSION_ID, text, true, undefined, 'defer', 'system');
}

function steerRows(rows: StoredRow[]): StoredRow[] {
  return rows.filter((row) => rowText(row.message).includes('injected mid-turn'));
}

function steerJobs(jobs: EnqueuedJob[]): EnqueuedJob[] {
  return jobs.filter((job) => job.queue === 'message_delivery' && job.payload.role === 'steer');
}

describe('classifyExternalEventDirectSteer', () => {
  it('classifies review verdicts, bot review comments, genuine CI failures, and merge conflicts', () => {
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.review_submitted',
        state: 'CHANGES_REQUESTED',
      })
    ).toBe('review');
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.review_submitted',
        state: 'APPROVED',
      })
    ).toBe('review');
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        actor: 'chatgpt-codex-connector[bot]',
      })
    ).toBe('review');
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
      })
    ).toBe('check');
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.merge_conflict',
      })
    ).toBe('merge_conflict');
  });

  it('keeps non-direct events on the digest tier', () => {
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.review_submitted',
        state: 'COMMENTED',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        actor: 'lsm',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'cancelled',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.check_cancelled',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.check_skipped',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.merge_conflict_resolved',
      })
    ).toBeNull();
    expect(
      classifyExternalEventDirectSteer({
        topic: 'github/lsm/hyperneo/pull_request/2828.polled',
      })
    ).toBeNull();
  });
});

describe('TaskAgentManager direct-inject tier mid-turn steer', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });
  afterEach(async () => {
    await sleep(DEBOUNCE_MS + 30);
  });

  it('steers a CHANGES_REQUESTED review verdict mid-turn as exactly one steer within the debounce window', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED'));

    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]?.status).toBe('deferred');

    await sleep(DEBOUNCE_MS + 40);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('injected mid-turn');
    expect(steerText).toContain('CHANGES_REQUESTED');
    expect(steerText).toContain('PR #2828');

    const jobs = steerJobs(harness.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.messageUuid).toBe(steers[0]!.message.uuid);
    expect(jobs[0]?.payload.origin).toBe('space_inject');

    expect(harness.statusUpdates).toContainEqual({
      dbIds: [harness.rows[0]!.dbId],
      status: 'consumed',
    });
    expect(harness.metrics.getCounters().directSteerInjected).toBe(1);
    expect(harness.metrics.getCounters().directSteerInjectedByClass.review).toBe(1);
  });

  it('coalesces a 12-comment review-bot burst into ONE steer', async () => {
    const harness = makeHarness();
    for (let i = 0; i < 12; i++) {
      await injectDefer(harness.manager, reviewCommentText(`rc-${i}`));
    }

    expect(harness.rows).toHaveLength(12);
    for (const row of harness.rows) expect(row.status).toBe('deferred');

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('(12 events, PR #2828)');
    expect(steerText).toContain('codex[bot]');
    expect(steerJobs(harness.jobs)).toHaveLength(1);

    const sourceDbIds = harness.rows
      .filter((row) => row.status !== 'enqueued')
      .map((row) => row.dbId);
    expect(sourceDbIds).toHaveLength(12);
    expect(harness.metrics.getCounters().directSteerInjected).toBe(1);
  });

  it('coalesces multi-check CI failures into one steer listing failing checks', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, checkFailedText('chk-lint', 'Lint'));
    await injectDefer(harness.manager, checkFailedText('chk-build', 'Build Binary (linux-x64)'));
    await injectDefer(harness.manager, checkFailedText('chk-test', 'Daemon Tests'));

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('CI check "Lint"');
    expect(steerText).toContain('CI check "Build Binary (linux-x64)"');
    expect(steerText).toContain('CI check "Daemon Tests"');
    expect(steerJobs(harness.jobs)).toHaveLength(1);
    expect(harness.metrics.getCounters().directSteerInjectedByClass.check).toBe(1);
  });

  it('falls back to the digest tier when the per-class cooldown budget is exceeded', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED', 'rev-first'));
    await sleep(DEBOUNCE_MS + 40);
    expect(steerRows(harness.rows)).toHaveLength(1);

    await injectDefer(harness.manager, reviewVerdictText('APPROVED', 'rev-second'));
    expect(harness.metrics.getCounters().directSteerSuppressedByCooldown).toBe(1);

    await sleep(DEBOUNCE_MS + 40);
    expect(steerRows(harness.rows)).toHaveLength(1);

    const secondRow = harness.rows.find((row) => rowText(row.message).includes('APPROVED'));
    expect(secondRow?.status).toBe('deferred');
    expect(
      harness.statusUpdates.some(
        ({ dbIds, status }) => status === 'consumed' && secondRow && dbIds.includes(secondRow.dbId)
      )
    ).toBe(false);
  });

  it('does not steer digest-tier events mid-turn', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, digestTierPrStateText('poll-1'));

    await sleep(DEBOUNCE_MS + 40);

    expect(steerRows(harness.rows)).toHaveLength(0);
    expect(steerJobs(harness.jobs)).toHaveLength(0);
    expect(harness.rows[0]?.status).toBe('deferred');
    expect(harness.metrics.getCounters().directSteerInjected).toBe(0);
  });
});

describe('TaskAgentManager direct-inject tier idle session', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });

  it('delivers normally to an idle session with no steer machinery engaged', async () => {
    const harness = makeHarness('idle');
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED'));

    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]?.status).toBe('enqueued');
    expect(harness.memoryQueue).toHaveLength(1);
    expect(harness.memoryQueue[0]!.content).toContain('CHANGES_REQUESTED');
    expect(steerJobs(harness.jobs)).toHaveLength(0);
    expect(harness.metrics.getCounters().directSteerInjected).toBe(0);

    await sleep(DEBOUNCE_MS + 30);
    expect(steerRows(harness.rows)).toHaveLength(0);
  });
});
