import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  type NeoDriverSettleDeps,
  type NeoDriverSettleEvidence,
  planNeoDriverSettlement,
  requireNeoDriverSettled,
  settleNeoDriverWork,
} from '../../../../src/lib/neo/settle-driver-work.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';

const work: NeoWork = Object.freeze({
  id: 'work-1',
  requestKey: 'root:k',
  originSessionId: 'root',
  originMessageId: 'm1',
  concernId: null,
  title: 'Font',
  instruction: 'Raise the font.',
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 100,
});
const ref: WorkRef = { adapter: 'codex-desktop', id: 'thread-1' };
const status = (value: Record<string, unknown>) => ({
  kind: 'completed' as const,
  value: { ok: true, value: { lastActivityAt: 200, ...value } },
});
const evidence = (extra: Partial<NeoDriverSettleEvidence> = {}): NeoDriverSettleEvidence => ({
  startedAt: 150,
  sent: null,
  outcome: status({ status: 'done', lastReply: 'Shipped.', lastReplyAt: 200 }),
  priorLiveStatus: null,
  continuing: false,
  now: 300,
  ...extra,
});

describe('planNeoDriverSettlement', () => {
  test('settles finished work and shows it done on the card', () => {
    expect(planNeoDriverSettlement(work, evidence())).toMatchObject({
      landed: null,
      cardStatus: 'done',
      settled: { status: 'reported', report: 'Shipped.' },
    });
  });

  test('a send that just landed anchors the card and waits for the next refresh to settle', () => {
    const plan = planNeoDriverSettlement(
      work,
      evidence({
        startedAt: null,
        sent: { inputBefore: 4, opening: 'Raise the font.' },
        outcome: status({
          status: 'running',
          recentInputs: [{ at: 8, text: 'Raise the font. Neo routed this' }],
        }),
      })
    );
    expect(plan).toMatchObject({ landed: 8, cardStatus: 'running', settled: null });
  });

  test('running work stays unsettled', () => {
    const plan = planNeoDriverSettlement(
      work,
      evidence({ outcome: status({ status: 'running' }) })
    );
    expect(plan.settled).toBeNull();
    expect(requireNeoDriverSettled(plan)).toEqual({ reason: 'unsettled' });
  });
});

describe('settleNeoDriverWork', () => {
  const harness = (outcome: ReturnType<typeof status>, transitioned: NeoWork | null) => {
    const calls: string[] = [];
    const deps: NeoDriverSettleDeps = {
      readStartedAt: () => 150,
      readSent: () => null,
      readLiveStatus: () => null,
      isContinuing: () => false,
      readStatus: async (_work, _ref, since) => {
        calls.push(`status since ${since}`);
        return outcome;
      },
      recordStartedAt: (_id, at) => calls.push(`started ${at}`),
      recordLive: (_id, cardStatus) => {
        calls.push(`live ${cardStatus}`);
        return true;
      },
      recordCheck: () => false,
      notifyChanged: () => calls.push('changed'),
      noteUnsettled: async () => {
        calls.push('note');
      },
      forgetActivity: () => calls.push('forget'),
      transition: (_work, settled) => {
        calls.push(`transition ${settled.status}`);
        return transitioned;
      },
      anchorFollow: (_id, at) => calls.push(`anchor ${at}`),
      returnReport: async (done) => {
        calls.push(`report ${done.status}`);
      },
    };
    return { deps, calls };
  };

  test('a failed status read is recorded as unchecked and tells the UI once it flips', async () => {
    const { deps, calls } = harness({ kind: 'failed', error: 'offline' } as never, null);
    const checks: Array<[string, boolean]> = [];
    deps.recordCheck = (id, read) => {
      checks.push([id, read]);
      return true;
    };
    expect(await settleNeoDriverWork(deps, work, ref)).toBe('unsettled');
    expect(checks).toEqual([[work.id, false]]);
    expect(calls).toContain('changed');
  });

  test('finished work is reported, anchored for follow-up and returned to Neo', async () => {
    const reported = { ...work, status: 'reported' as const, report: 'Shipped.' };
    const { deps, calls } = harness(
      status({ status: 'done', lastReply: 'Shipped.', lastReplyAt: 200 }),
      reported
    );
    expect(await settleNeoDriverWork(deps, work, ref)).toEqual({
      status: 'reported',
      report: 'Shipped.',
    });
    expect(calls).toEqual([
      'status since 150',
      'live done',
      'changed',
      'forget',
      'transition reported',
      'anchor 200',
      'report reported',
    ]);
  });

  test('running work gets its notes and is not transitioned', async () => {
    const { deps, calls } = harness(status({ status: 'running' }), null);
    expect(await settleNeoDriverWork(deps, work, ref)).toBe('unsettled');
    expect(calls).toEqual(['status since 150', 'live running', 'changed', 'note']);
  });

  test('a lost transition race reports nothing', async () => {
    const { deps, calls } = harness(status({ status: 'failed', lastReply: 'Broke.' }), null);
    await settleNeoDriverWork(deps, work, ref);
    expect(calls).not.toContain('report failed');
    expect(calls).toContain('transition failed');
  });
});
