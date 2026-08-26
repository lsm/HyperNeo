import { describe, expect, it } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type {
  ExternalEventDeliveryRecord,
  ExternalEventRecord,
} from '../../../../src/lib/external-events/types';
import {
  aggregateRender,
  buildMessage,
  loadPending,
  orderAndDedupe,
  persistAndAppend,
  type RenderPendingDigestCtx,
  type RenderPendingDigestDeps,
  type RenderPendingDigestLedgerMark,
  runRenderPendingDigest,
} from '../../../../src/lib/space/runtime/render-pending-digest-pipeline';

const SESSION_ID = 'session-digest';
const TARGET = {
  workflowRunId: 'run-1',
  taskId: 'task-1',
  nodeId: 'node-1',
  agentName: 'coder',
};
const BASE_AT = 1_755_500_000_000;
const PR_URL = 'https://github.com/acme/widgets/pull/42';
const CHECK_TOPIC = 'github/acme/widgets/pull_request/42.check_failed';

interface Harness {
  deps: RenderPendingDigestDeps;
  rows: ExternalEventDeliveryRecord[];
  records: Map<string, ExternalEventRecord>;
  saved: SDKUserMessage[];
  appended: SDKUserMessage[];
  marks: RenderPendingDigestLedgerMark[];
  listedTargets: unknown[];
}

function harness(overrides: Partial<RenderPendingDigestDeps> = {}): Harness {
  const rows: ExternalEventDeliveryRecord[] = [];
  const records = new Map<string, ExternalEventRecord>();
  const saved: SDKUserMessage[] = [];
  const appended: SDKUserMessage[] = [];
  const marks: RenderPendingDigestLedgerMark[] = [];
  const listedTargets: unknown[] = [];
  const deps: RenderPendingDigestDeps = {
    listPendingDeliveries: (target) => {
      listedTargets.push(target);
      return rows;
    },
    getEventById: (eventId) => records.get(eventId) ?? null,
    saveDigestMessageIfAbsent: async (_sessionId, message) => {
      const uuid = String(message.uuid);
      const existing = saved.find((row) => String(row.uuid) === uuid);
      if (existing) return { dbId: `db-${uuid}`, replayed: true };
      saved.push(message);
      return { dbId: `db-${uuid}`, replayed: false };
    },
    appendDigest: async (_sessionId, message) => {
      appended.push(message);
      return true;
    },
    markDeliveriesDelivered: (entries) => {
      marks.push(...entries);
    },
    ...overrides,
  };
  return { deps, rows, records, saved, appended, marks, listedTargets };
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

function ctxOf(
  h: Harness,
  overrides: Partial<RenderPendingDigestCtx> = {}
): RenderPendingDigestCtx {
  return { sessionId: SESSION_ID, target: TARGET, deps: h.deps, ...overrides };
}

function runStages(h: Harness): RenderPendingDigestCtx {
  return buildMessage(aggregateRender(orderAndDedupe(loadPending(ctxOf(h)))));
}

describe('render-pending-digest pipeline', () => {
  it('loadPending skips when no ledger rows are pending for the target', () => {
    const h = harness();
    const ctx = loadPending(ctxOf(h));
    expect(ctx.outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
    expect(h.listedTargets).toEqual([TARGET]);
  });

  it('loadPending reads essences from the store by eventId', () => {
    const h = harness();
    seedPending(h, [
      ['ev-check', 'check'],
      ['ev-gone', 'check'],
    ]);
    h.records.delete('ev-gone');
    const ctx = loadPending(ctxOf(h));
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
    const ctx = aggregateRender(orderAndDedupe(loadPending(ctxOf(h))));
    expect(ctx.digestText).toContain('External events while you were working (2 events, PR #42):');
    expect(ctx.digestText).toContain('CI check "build-linux"');
    expect(ctx.digestText).toContain('Review comment');
  });

  it('buildMessage derives a deterministic uuid from the sorted eventIds', () => {
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

  it('end to end: one digest message for a mixed pending set, all rows marked', async () => {
    const h = harness();
    seedPending(h, [
      ['ev-check', 'check'],
      ['ev-review', 'review'],
      ['ev-comment', 'comment'],
    ]);
    const outcome = await runRenderPendingDigest(h.deps, { sessionId: SESSION_ID, target: TARGET });
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
  });

  it('end to end: empty pending set is a skip', async () => {
    const h = harness();
    const outcome = await runRenderPendingDigest(h.deps, { sessionId: SESSION_ID, target: TARGET });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_pending_events' });
  });

  it('end to end: one event with two pending ledger rows renders once and marks both rows', async () => {
    const h = harness();
    seedPending(h, [['ev-a', 'check']]);
    h.rows.push(pendingRow('ev-a', { deliveryKey: 'delivery-2' }));
    const outcome = await runRenderPendingDigest(h.deps, { sessionId: SESSION_ID, target: TARGET });
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
    const outcome = await runRenderPendingDigest(h.deps, { sessionId: SESSION_ID, target: TARGET });
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
    const input = { sessionId: SESSION_ID, target: TARGET };
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
  });
});
