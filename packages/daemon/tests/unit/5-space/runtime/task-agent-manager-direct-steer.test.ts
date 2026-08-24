import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventQueueMetrics } from '../../../../src/lib/external-events/queue-health-metrics';
import { classifyExternalEventDirectSteer } from '../../../../src/lib/external-events/event-tiers';
import { buildDeferredEventDigestEnvelopeText } from '../../../../src/lib/external-events/deferred-event-digest';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import {
  DIRECT_STEER_BUFFER_MAX_ENTRIES,
  DIRECT_STEER_SNIPPET_MAX_CHARS,
  TaskAgentManager,
} from '../../../../src/lib/space/runtime/task-agent-manager';

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

function deferredRowFixture(
  dbId: string,
  uuid: string,
  text = 'preexisting deferred row'
): StoredRow {
  return {
    dbId,
    status: 'deferred',
    message: {
      type: 'user',
      uuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      isSynthetic: true,
      inputKind: 'system',
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SDKUserMessage,
  };
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
  setFailJobEnqueue(value: boolean): void;
  setProcessingStatus(status: string): void;
  eventPayloads: Map<string, Record<string, unknown>>;
}

function makeHarness(processingStatusArg = 'processing'): Harness {
  const rows: StoredRow[] = [];
  const statusUpdates: Array<{ dbIds: string[]; status: string }> = [];
  const jobs: EnqueuedJob[] = [];
  const metrics = new ExternalEventQueueMetrics();
  const memoryQueue: Array<{ messageId: string; content: unknown }> = [];
  let processingStatus = processingStatusArg;
  let failJobEnqueue = false;
  const eventPayloads = new Map<string, Record<string, unknown>>();

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
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          rows.some((row) => row.message.uuid === uuid)
            ? { content: 'x', sendStatus: 'deferred' }
            : null,
        getMessageByStatusAndUuid: (_sessionId: string, status: string, uuid: string) => {
          const row = rows.find(
            (candidate) => candidate.message.uuid === uuid && candidate.status === status
          );
          return row ? { dbId: row.dbId } : null;
        },
        reopenDeliveryByUuid: () => null,
        markDeliveryDeferredByUuid: (_sessionId: string, uuid: string) =>
          rows.find((row) => row.message.uuid === uuid)?.dbId ?? null,
        markDeliveryFailedByUuid: (_sessionId: string, uuid: string) => {
          const row = rows.find((candidate) => candidate.message.uuid === uuid);
          if (!row) return null;
          row.status = 'failed';
          return row.dbId;
        },
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
        getActiveDeliveryRole: () => null,
        enqueue: (job: EnqueuedJob) => {
          if (failJobEnqueue) throw new Error('job queue unavailable');
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
    externalEventStore: {
      getById: (eventId: string) =>
        eventPayloads.has(eventId)
          ? {
              event: {
                payload: eventPayloads.get(eventId),
                occurredAt: Date.UTC(2026, 7, 23, 16, 14),
                externalUrl: `${PR_URL}#${eventId}`,
              },
            }
          : null,
    },
    directSteerDebounceMs: DEBOUNCE_MS,
    directSteerMaxBurstWaitMs: MAX_BURST_WAIT_MS,
    directSteerCooldownMs: COOLDOWN_MS,
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
  return {
    manager,
    rows,
    statusUpdates,
    jobs,
    metrics,
    memoryQueue,
    setFailJobEnqueue: (value: boolean) => {
      failJobEnqueue = value;
    },
    setProcessingStatus: (status: string) => {
      processingStatus = status;
    },
    eventPayloads,
  };
}

async function injectDefer(manager: TaskAgentManager, text: string): Promise<void> {
  await manager.injectSubSessionMessage(SESSION_ID, text, true, undefined, 'defer', 'system');
}

function steerRows(rows: StoredRow[]): StoredRow[] {
  return rows.filter(
    (row) => row.status === 'enqueued' && rowText(row.message).includes('injected mid-turn')
  );
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

  it('expands an upstream rate-limit fold containing bot review comments into the steer', async () => {
    const harness = makeHarness();
    const essences = Array.from({ length: 12 }, (_, i) => ({
      eventId: `fold-rc-${i}`,
      topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
      eventType: 'pull_request_review_comment',
      actor: 'codex[bot]',
      repo: 'lsm/HyperNeo',
      prNumber: 2828,
      prUrl: PR_URL,
      body: 'Folded comment',
      commentId: `fold-c-${i}`,
      occurredAt: Date.UTC(2026, 7, 23, 16, 12),
    }));
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));

    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]?.status).toBe('deferred');

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    expect(rowText(steers[0]!.message)).toContain('(12 events, PR #2828)');
    expect(steerJobs(harness.jobs)).toHaveLength(1);
    expect(harness.metrics.getCounters().directSteerInjectedByClass.review).toBe(1);
    expect(harness.rows[0]?.status).toBe('consumed');
  });

  it('does not steer while the session is waiting_for_input', async () => {
    const harness = makeHarness('waiting_for_input');
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED'));

    await sleep(DEBOUNCE_MS + 40);

    expect(steerRows(harness.rows)).toHaveLength(0);
    expect(steerJobs(harness.jobs)).toHaveLength(0);
    expect(harness.rows[0]?.status).toBe('deferred');
  });

  it('discards the steer row on delivery-enqueue failure, keeping source rows as the single carrier', async () => {
    const harness = makeHarness();
    harness.setFailJobEnqueue(true);
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED'));

    await sleep(DEBOUNCE_MS + 40);

    expect(steerRows(harness.rows)).toHaveLength(0);
    expect(steerJobs(harness.jobs)).toHaveLength(0);
    const sourceRow = harness.rows.find((row) =>
      rowText(row.message).includes('CHANGES_REQUESTED')
    );
    expect(sourceRow?.status).toBe('deferred');
    const failedRow = harness.rows.find((row) => row.status === 'failed');
    expect(failedRow).toBeDefined();
    expect(rowText(failedRow!.message)).toContain('injected mid-turn');
  });

  it('skips the steer when the session stops processing before the debounce fires', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED'));
    harness.setProcessingStatus('waiting_for_input');

    await sleep(DEBOUNCE_MS + 40);

    expect(steerRows(harness.rows)).toHaveLength(0);
    expect(steerJobs(harness.jobs)).toHaveLength(0);
    expect(harness.rows[0]?.status).toBe('deferred');
  });

  it('hydrates sparse rate-limit fold entries from the external-event store before classifying', async () => {
    const harness = makeHarness();
    harness.eventPayloads.set('sparse-rc-1', {
      actor: 'codex[bot]',
      body: 'Sparse folded comment body.',
      path: 'packages/daemon/src/lib/space/runtime/task-agent-manager.ts',
      line: 3600,
      commentId: 'c-sparse-rc-1',
    });
    harness.eventPayloads.set('sparse-rc-2', { actor: 'codex[bot]' });
    const essences = [
      {
        eventId: 'sparse-rc-1',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
      },
      {
        eventId: 'sparse-rc-2',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
      },
    ];
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('codex[bot]');
    expect(steerText).toContain('packages/daemon/src/lib');
    expect(steerText).not.toContain('unknown time');
    expect(steerText).toContain('#sparse-rc-1');
    expect(steerJobs(harness.jobs)).toHaveLength(1);
  });

  it('splits a mixed fold so only budgeted classes steer while cooled classes stay deferred', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED', 'warm-review'));
    await sleep(DEBOUNCE_MS + 40);
    expect(steerRows(harness.rows)).toHaveLength(1);

    const essences = [
      {
        eventId: 'mixed-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        actor: 'codex[bot]',
        commentId: 'c-mixed-review',
      },
      {
        eventId: 'mixed-check',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
        checkName: 'Daemon Tests',
      },
    ];
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(2);
    const splitSteerText = rowText(steers[1]!.message);
    expect(splitSteerText).toContain('Daemon Tests');
    expect(splitSteerText).not.toContain('mixed-review');

    const remainderRow = harness.rows.find(
      (row) => row.status === 'deferred' && rowText(row.message).includes('mixed-review')
    );
    expect(remainderRow).toBeDefined();
  });

  it('arms cooldowns for every direct class represented in a steered fold', async () => {
    const harness = makeHarness();
    const essences = [
      {
        eventId: 'mixed-chk',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
      },
      {
        eventId: 'mixed-conflict',
        topic: 'github/lsm/hyperneo/pull_request/2828.merge_conflict',
      },
    ];
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));
    await sleep(DEBOUNCE_MS + 60);
    expect(steerRows(harness.rows)).toHaveLength(1);
    const injectedByClass = harness.metrics.getCounters().directSteerInjectedByClass;
    expect(injectedByClass.check).toBe(1);
    expect(injectedByClass.merge_conflict).toBe(1);
    expect(harness.metrics.getCounters().directSteerInjected).toBe(1);

    await injectDefer(
      harness.manager,
      formatExternalEventEssence(
        externalEvent('github/lsm/hyperneo/pull_request/2828.merge_conflict', 'later-conflict', {
          eventType: 'pull_request',
          action: 'merge_conflict',
          actor: 'lsm',
        })
      )
    );
    expect(harness.metrics.getCounters().directSteerSuppressedByCooldown).toBe(1);
    await sleep(DEBOUNCE_MS + 40);
    expect(steerRows(harness.rows)).toHaveLength(1);
  });

  it('drops a mixed burst at flush when a represented class cooled meanwhile', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, checkFailedText('early-chk', 'Daemon Tests'));
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED', 'mixed-verdict'));

    await sleep(DEBOUNCE_MS + 80);

    expect(steerRows(harness.rows)).toHaveLength(2);
    expect(harness.metrics.getCounters().directSteerInjected).toBe(2);

    const mixedEssences = [
      {
        eventId: 'late-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        actor: 'codex[bot]',
        commentId: 'c-late-review',
      },
      {
        eventId: 'late-check',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
        checkName: 'Lint',
      },
    ];
    await injectDefer(
      harness.manager,
      buildDeferredEventDigestEnvelopeText(mixedEssences as never)
    );

    await sleep(DEBOUNCE_MS + 60);

    expect(steerRows(harness.rows)).toHaveLength(2);
    const mixedRow = harness.rows.find((row) => rowText(row.message).includes('late-review'));
    expect(mixedRow?.status).toBe('deferred');
    expect(harness.metrics.getCounters().directSteerSuppressedByCooldown).toBeGreaterThanOrEqual(1);
  });

  it('bounds the buffer by expanded event count, not row count', async () => {
    const harness = makeHarness();
    const bigFold = Array.from({ length: DIRECT_STEER_BUFFER_MAX_ENTRIES }, (_, i) => ({
      eventId: `cap-${i}`,
      topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
      conclusion: 'failure',
    }));
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(bigFold as never));
    await injectDefer(harness.manager, checkFailedText('cap-overflow', 'One More Check'));

    expect(harness.metrics.getCounters().directSteerSuppressedByBufferCap).toBe(1);

    await sleep(DEBOUNCE_MS + 60);
    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    expect(rowText(steers[0]!.message)).toContain(`(${DIRECT_STEER_BUFFER_MAX_ENTRIES} events`);
  });

  it('claims the real row id when the defer path returns the message uuid', async () => {
    const harness = makeHarness();
    const preexisting = deferredRowFixture('db-preexisting', 'uuid-preexisting');
    harness.rows.push(preexisting);

    await harness.manager.injectSubSessionMessage(
      SESSION_ID,
      reviewVerdictText('CHANGES_REQUESTED', 'reopen-evt'),
      true,
      undefined,
      'defer',
      'system',
      'uuid-preexisting'
    );

    await sleep(DEBOUNCE_MS + 40);

    expect(steerRows(harness.rows)).toHaveLength(1);
    expect(harness.statusUpdates).toContainEqual({
      dbIds: ['db-preexisting'],
      status: 'consumed',
    });
    expect(preexisting.status).toBe('consumed');
  });

  it('consumes the real row id when splitting a mixed fold delivered under an existing uuid', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, reviewVerdictText('CHANGES_REQUESTED', 'warm-review'));
    await sleep(DEBOUNCE_MS + 40);
    expect(steerRows(harness.rows)).toHaveLength(1);

    const mixedEssences = [
      {
        eventId: 'split-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        actor: 'codex[bot]',
        commentId: 'c-split-review',
      },
      {
        eventId: 'split-check',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
        checkName: 'Daemon Tests',
      },
    ];
    const mixedFoldText = buildDeferredEventDigestEnvelopeText(mixedEssences as never);
    harness.rows.push(deferredRowFixture('db-pre', 'uuid-pre', mixedFoldText));
    await harness.manager.injectSubSessionMessage(
      SESSION_ID,
      mixedFoldText,
      true,
      undefined,
      'defer',
      'system',
      'uuid-pre'
    );

    await sleep(DEBOUNCE_MS + 60);

    expect(harness.statusUpdates).toContainEqual({ dbIds: ['db-pre'], status: 'consumed' });
    expect(harness.rows.find((row) => row.dbId === 'db-pre')?.status).toBe('consumed');
    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(2);
    const splitSteerText = rowText(steers[1]!.message);
    expect(splitSteerText).toContain('Daemon Tests');
    expect(splitSteerText).not.toContain('split-review');
  });

  it('keeps cap-folded events in the mid-turn steer via the replacement envelope', async () => {
    const harness = makeHarness();
    await injectDefer(harness.manager, checkFailedText('chk-0', 'Check Zero'));
    await injectDefer(harness.manager, checkFailedText('chk-1', 'Check One'));
    for (let i = 2; i <= 102; i++) {
      await injectDefer(harness.manager, checkFailedText(`chk-${i}`, `Check ${i}`));
    }

    await sleep(MAX_BURST_WAIT_MS + 80);

    const steers = steerRows(harness.rows);
    expect(steers.length).toBeGreaterThanOrEqual(1);
    const allSteerText = steers.map((row) => rowText(row.message)).join('\n');
    expect(allSteerText).toContain('Check Zero');
    expect(allSteerText).toContain('Check One');
    expect(allSteerText).toContain('Check 60');
    expect(harness.metrics.getCounters().directSteerInjected).toBe(1);
  });

  it('ignores duplicate buffer admissions for the same explicit message uuid', async () => {
    const harness = makeHarness();
    const text = reviewVerdictText('CHANGES_REQUESTED', 'dup-evt');
    await harness.manager.injectSubSessionMessage(
      SESSION_ID,
      text,
      true,
      undefined,
      'defer',
      'system',
      'dup-uuid'
    );
    await harness.manager.injectSubSessionMessage(
      SESSION_ID,
      text,
      true,
      undefined,
      'defer',
      'system',
      'dup-uuid'
    );

    await sleep(DEBOUNCE_MS + 40);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    expect(rowText(steers[0]!.message)).toContain('(1 event');
  });

  it('renders full review feedback without the digest snippet truncation', async () => {
    const harness = makeHarness();
    const longBody = `${'Consider handling the empty-burst case here and also '.repeat(6)}TAIL_MARKER`;
    await injectDefer(
      harness.manager,
      formatExternalEventEssence(
        externalEvent(
          'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
          'long-body-evt',
          {
            eventType: 'pull_request_review_comment',
            action: 'polled',
            actor: 'codex[bot]',
            body: longBody,
            commentId: 'c-long-body',
            path: 'packages/daemon/src/lib/space/runtime/task-agent-manager.ts',
            line: 3400,
            inReplyToId: '',
          }
        )
      )
    );

    await sleep(DEBOUNCE_MS + 40);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('TAIL_MARKER');
    expect(steerText).not.toContain('…');
  });

  it('re-defers digest-tier passengers instead of dropping them when steering a mixed fold', async () => {
    const harness = makeHarness();
    const essences = [
      {
        eventId: 'pax-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        actor: 'codex[bot]',
        body: 'bot feedback',
        commentId: 'c-pax',
      },
      {
        eventId: 'pax-human',
        topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
        eventType: 'issue_comment',
        action: 'polled',
        actor: 'lsm',
        body: 'HUMAN_NOTE_MARKER',
        commentId: 'c-pax-human',
      },
    ];
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('pax-review');
    expect(steerText).not.toContain('HUMAN_NOTE_MARKER');

    const passengerRow = harness.rows.find(
      (row) => row.status === 'deferred' && rowText(row.message).includes('HUMAN_NOTE_MARKER')
    );
    expect(passengerRow).toBeDefined();

    const sourceRow = harness.rows.find(
      (row) => rowText(row.message).includes('pax-review') && row.dbId !== passengerRow?.dbId
    );
    expect(sourceRow?.status).toBe('consumed');
  });

  it('carries the fold omission count into the deferred passenger remainder', async () => {
    const harness = makeHarness();
    const essences = [
      {
        eventId: 'omitted-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        actor: 'codex[bot]',
        body: 'bot feedback with omissions',
        commentId: 'c-omit',
      },
      {
        eventId: 'omitted-human',
        topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
        eventType: 'issue_comment',
        action: 'polled',
        actor: 'lsm',
        body: 'human note',
        commentId: 'c-omit-human',
      },
    ];
    const foldText = JSON.stringify({
      type: 'external_event_digest',
      events: essences,
      droppedEventCount: 4,
    });
    await injectDefer(harness.manager, foldText);

    await sleep(DEBOUNCE_MS + 60);

    const passengerRow = harness.rows.find(
      (row) => row.status === 'deferred' && rowText(row.message).includes('omitted-human')
    );
    expect(passengerRow).toBeDefined();
    const passengerEnvelope = JSON.parse(rowText(passengerRow!.message)) as {
      type: string;
      droppedEventCount?: number;
    };
    expect(passengerEnvelope.type).toBe('external_event_digest');
    expect(passengerEnvelope.droppedEventCount).toBe(4);
  });

  it('does not double-admit a row that the cap fold superseded', async () => {
    const harness = makeHarness();
    for (let i = 0; i < 100; i++) {
      harness.rows.push(
        deferredRowFixture(
          `seed-db-${i}`,
          `seed-uuid-${i}`,
          formatExternalEventEssence(
            externalEvent('github/lsm/hyperneo/pull_request/2828.check_failed', `seed-${i}`, {
              eventType: 'check_run',
              action: 'failed',
              actor: 'github-actions[bot]',
              checkName: `Seed ${i}`,
              conclusion: 'failure',
            })
          )
        )
      );
    }
    const guardEssences = [
      {
        eventId: 'guard-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        actor: 'codex[bot]',
        body: 'guard feedback',
        commentId: 'c-guard',
      },
      {
        eventId: 'guard-check',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
        checkName: 'Guard Check',
      },
    ];
    const guardText = buildDeferredEventDigestEnvelopeText(guardEssences as never);
    await harness.manager.injectSubSessionMessage(
      SESSION_ID,
      guardText,
      true,
      undefined,
      'defer',
      'system',
      'env-uuid'
    );

    await sleep(MAX_BURST_WAIT_MS + 80);

    const steers = steerRows(harness.rows);
    expect(steers.length).toBeGreaterThanOrEqual(1);
    const allSteerText = steers.map((row) => rowText(row.message)).join('\n');
    expect(allSteerText.split('guard feedback').length - 1).toBe(1);
  });

  it('renders every grouped review-comment body in a direct steer', async () => {
    const harness = makeHarness();
    await injectDefer(
      harness.manager,
      formatExternalEventEssence(
        externalEvent(
          'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
          'reply-first',
          {
            eventType: 'pull_request_review_comment',
            action: 'polled',
            actor: 'codex[bot]',
            body: 'FIRST_REPLY_MARKER',
            commentId: 'thread-1',
            inReplyToId: '',
          }
        )
      )
    );
    await injectDefer(
      harness.manager,
      formatExternalEventEssence(
        externalEvent(
          'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
          'reply-second',
          {
            eventType: 'pull_request_review_comment',
            action: 'polled',
            actor: 'codex[bot]',
            body: 'SECOND_REPLY_MARKER',
            commentId: 'thread-1',
            inReplyToId: '',
          }
        )
      )
    );

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).toContain('FIRST_REPLY_MARKER');
    expect(steerText).toContain('SECOND_REPLY_MARKER');
  });

  it('bounds long bodies with the direct-tier snippet budget and keeps the retrieval id', async () => {
    const harness = makeHarness();
    await injectDefer(
      harness.manager,
      formatExternalEventEssence(
        externalEvent('github/lsm/hyperneo/pull_request/2828.review_comment_polled', 'long-evt', {
          eventType: 'pull_request_review_comment',
          action: 'polled',
          actor: 'codex[bot]',
          body: `${'A'.repeat(DIRECT_STEER_SNIPPET_MAX_CHARS + 500)}TAIL_BEYOND_BUDGET`,
          commentId: 'c-long-evt',
          path: 'packages/daemon/src/lib/space/runtime/task-agent-manager.ts',
          line: 3400,
          inReplyToId: '',
        })
      )
    );

    await sleep(DEBOUNCE_MS + 40);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    const steerText = rowText(steers[0]!.message);
    expect(steerText).not.toContain('TAIL_BEYOND_BUDGET');
    expect(steerText).toContain('…');
    expect(steerText).toContain('long-evt');
  });

  it('reports the omission count in an all-direct steer', async () => {
    const harness = makeHarness();
    const essences = [
      {
        eventId: 'alldirect-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        actor: 'codex[bot]',
        body: 'bot feedback',
        commentId: 'c-alldirect',
      },
      {
        eventId: 'alldirect-check',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
        conclusion: 'failure',
        checkName: 'All Direct Check',
      },
    ];
    await injectDefer(
      harness.manager,
      JSON.stringify({ type: 'external_event_digest', events: essences, droppedEventCount: 7 })
    );

    await sleep(DEBOUNCE_MS + 60);

    const steers = steerRows(harness.rows);
    expect(steers).toHaveLength(1);
    expect(rowText(steers[0]!.message)).toContain('7 older events were omitted');
  });

  it('discards the passenger copy when steer setup fails after it was persisted', async () => {
    const harness = makeHarness();
    harness.setFailJobEnqueue(true);
    const essences = [
      {
        eventId: 'rollback-review',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        actor: 'codex[bot]',
        body: 'bot feedback rollback',
        commentId: 'c-rollback',
      },
      {
        eventId: 'rollback-human',
        topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
        eventType: 'issue_comment',
        action: 'polled',
        actor: 'lsm',
        body: 'ROLLBACK_HUMAN_NOTE',
        commentId: 'c-rollback-human',
      },
    ];
    await injectDefer(harness.manager, buildDeferredEventDigestEnvelopeText(essences as never));

    await sleep(DEBOUNCE_MS + 60);

    const humanDeferredRows = harness.rows.filter(
      (row) => row.status === 'deferred' && rowText(row.message).includes('ROLLBACK_HUMAN_NOTE')
    );
    expect(humanDeferredRows).toHaveLength(1);
    expect(harness.rows.find((row) => row.status === 'failed')).toBeDefined();
    expect(harness.metrics.getCounters().directSteerInjected).toBe(0);
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
