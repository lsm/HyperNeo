import { describe, expect, it, mock } from 'bun:test';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff.ts';
import {
  activateDeferredStage,
  claimQueuedStage,
  deliverOutcomeStage,
  handoffStage,
  isTerminalOutcome,
  type MailboxInjectSettlementDeps,
  normalizeExistingRowStage,
  settleMailboxInject,
  settleStage,
} from '../../../../src/lib/space/runtime/mailbox-inject-settlement-pipeline.ts';

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'msg-1';

type SettlementLike =
  | { kind: 'materialized'; dbId: string }
  | { kind: 'dead' | 'absent' | 'cancelled' | 'stuck' };

function makeDeps(overrides?: { handoff?: MailboxHandoffOutcome; settlement?: SettlementLike }): {
  deps: MailboxInjectSettlementDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: MailboxInjectSettlementDeps = {
    normalizeExistingRow: () => {
      calls.push('normalize');
    },
    handoffToMailbox: async () => overrides?.handoff ?? { kind: 'enqueued', id: 'entry-1' },
    awaitSettlement: async () => overrides?.settlement ?? { kind: 'materialized', dbId: 'db-1' },
    activateDeferredRow: async () => {
      calls.push('activate');
      return true;
    },
    claimQueued: async () => {
      calls.push('claimQueued');
    },
    persistFailedRow: async () => {
      calls.push('persistFailed');
    },
  };
  return { deps, calls };
}

describe('mailbox-inject-settlement stages', () => {
  it('normalizeExistingRowStage only normalizes when a row pre-exists', () => {
    const { deps, calls } = makeDeps();
    expect(normalizeExistingRowStage(deps, SESSION_ID, MESSAGE_ID, null)).toEqual({
      normalized: false,
    });
    expect(calls).toEqual([]);
    expect(normalizeExistingRowStage(deps, SESSION_ID, MESSAGE_ID, 'failed')).toEqual({
      normalized: true,
    });
    expect(calls).toEqual(['normalize']);
  });

  it('handoffStage fails fast on a rejected handoff and persists the failed row', async () => {
    const { deps, calls } = makeDeps({
      handoff: { kind: 'rejected', reason: 'entry failed serialization' },
    });
    const result = await handoffStage(deps, SESSION_ID, MESSAGE_ID);
    expect(result.finalOutcome).toEqual({
      action: 'failed',
      reason: 'mailbox handoff rejected: entry failed serialization',
    });
    expect(result.handoff).toBeUndefined();
    expect(calls).toEqual(['persistFailed']);
  });

  it('settleStage fails on a dead entry and keeps the materialized settlement otherwise', async () => {
    const dead = makeDeps({ settlement: { kind: 'dead' } });
    const failedResult = await settleStage(
      dead.deps,
      SESSION_ID,
      MESSAGE_ID,
      { kind: 'enqueued', id: 'entry-1' },
      false
    );
    expect(failedResult.finalOutcome).toEqual({
      action: 'failed',
      reason: 'mailbox entry failed to materialize (dead)',
    });
    expect(dead.calls).toEqual(['persistFailed']);

    const ok = makeDeps({ settlement: { kind: 'materialized', dbId: 'db-9' } });
    const result = await settleStage(
      ok.deps,
      SESSION_ID,
      MESSAGE_ID,
      { kind: 'enqueued', id: 'e' },
      true
    );
    expect(result.finalOutcome).toBeUndefined();
    expect(result.settlement).toEqual({ kind: 'materialized', dbId: 'db-9' });
  });

  it('activateDeferredStage activates only deferred rows and binds the outcome key', async () => {
    const { deps, calls } = makeDeps();
    expect(await activateDeferredStage(deps, SESSION_ID, MESSAGE_ID, 'failed')).toEqual({
      activated: false,
      finalOutcome: undefined,
    });
    expect(calls).toEqual([]);
    expect(await activateDeferredStage(deps, SESSION_ID, MESSAGE_ID, 'deferred')).toEqual({
      activated: true,
      finalOutcome: undefined,
    });
    expect(calls).toEqual(['activate']);
  });

  it('activateDeferredStage fails the settlement when activation activates nothing', async () => {
    const { deps, calls } = makeDeps();
    const originalActivate = deps.activateDeferredRow;
    deps.activateDeferredRow = async () => false;
    expect(await activateDeferredStage(deps, SESSION_ID, MESSAGE_ID, 'deferred')).toEqual({
      activated: false,
      finalOutcome: { action: 'failed', reason: 'deferred row activated nothing' },
    });
    expect(calls).toEqual([]);
    deps.activateDeferredRow = originalActivate;
  });

  it('claimQueuedStage claims the queued state for the message', async () => {
    const { deps, calls } = makeDeps();
    expect(await claimQueuedStage(deps, MESSAGE_ID)).toEqual({ queued: true });
    expect(calls).toEqual(['claimQueued']);
  });

  it('deliverOutcomeStage resolves the materialized row id', () => {
    expect(deliverOutcomeStage({ kind: 'materialized', dbId: 'db-1' }, MESSAGE_ID)).toEqual({
      finalOutcome: { action: 'delivered', dbId: 'db-1' },
    });
    expect(deliverOutcomeStage(undefined, MESSAGE_ID)).toEqual({
      finalOutcome: { action: 'delivered', dbId: MESSAGE_ID },
    });
  });

  it('isTerminalOutcome recognizes only bound outcomes', () => {
    expect(isTerminalOutcome(undefined)).toBe(false);
    expect(isTerminalOutcome({ action: 'delivered', dbId: 'db-1' })).toBe(true);
    expect(isTerminalOutcome({ action: 'failed', reason: 'x' })).toBe(true);
  });
});

describe('settleMailboxInject — halted pipeline composition', () => {
  it('delivers a fresh injection without normalization and with a queue claim', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await settleMailboxInject({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      rowExistedAtHandoff: false,
      existingSendStatus: null,
      deps,
    });
    expect(outcome).toEqual({ action: 'delivered', dbId: 'db-1' });
    expect(calls).toEqual(['claimQueued']);
  });

  it('normalizes, activates, and claims queued for a deferred-row retry', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await settleMailboxInject({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      rowExistedAtHandoff: true,
      existingSendStatus: 'deferred',
      deps,
    });
    expect(outcome).toEqual({ action: 'delivered', dbId: 'db-1' });
    expect(calls).toEqual(['normalize', 'activate', 'claimQueued']);
  });

  it('halts at the settlement gate on a dead entry — activation and queue claim never run', async () => {
    const { deps, calls } = makeDeps({ settlement: { kind: 'dead' } });
    const outcome = await settleMailboxInject({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      rowExistedAtHandoff: true,
      existingSendStatus: 'deferred',
      deps,
    });
    expect(outcome).toEqual({
      action: 'failed',
      reason: 'mailbox entry failed to materialize (dead)',
    });
    expect(calls).toEqual(['normalize', 'persistFailed']);
  });

  it('halts after activation when the deferred row activated nothing', async () => {
    const { deps, calls } = makeDeps();
    deps.activateDeferredRow = async () => false;
    const outcome = await settleMailboxInject({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      rowExistedAtHandoff: true,
      existingSendStatus: 'deferred',
      deps,
    });
    expect(outcome).toEqual({ action: 'failed', reason: 'deferred row activated nothing' });
    expect(calls).toEqual(['normalize']);
  });

  it('halts before settlement when the handoff is rejected', async () => {
    const { deps, calls } = makeDeps({
      handoff: { kind: 'rejected', reason: 'invalid mailbox address' },
    });
    const outcome = await settleMailboxInject({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      rowExistedAtHandoff: true,
      existingSendStatus: 'failed',
      deps,
    });
    expect(outcome).toEqual({
      action: 'failed',
      reason: 'mailbox handoff rejected: invalid mailbox address',
    });
    expect(calls).toEqual(['normalize', 'persistFailed']);
  });
});
