import { describe, expect, it, mock } from 'bun:test';
import {
  drainPendingRowOntoMailbox,
  pendingDrainMailboxPolicy,
  pendingDrainMessageUuid,
} from '../../../../src/lib/space/runtime/pending-drain-handoff.ts';
import type { PendingAgentMessageRecord } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';

const WORKER_TARGET = { kind: 'worker', taskId: 'task-1', agentName: 'coder' } as const;

function makeRow(overrides: Partial<PendingAgentMessageRecord> = {}): PendingAgentMessageRecord {
  return {
    id: 'row-1',
    workflowRunId: 'run-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    sourceAgentName: 'reviewer',
    targetKind: 'node_agent',
    targetAgentName: 'coder',
    message: 'queued note',
    workflowNodeId: null,
    idempotencyKey: null,
    attempts: 0,
    maxAttempts: 5,
    lastAttemptAt: null,
    lastError: null,
    status: 'pending',
    deliveredAt: null,
    deliveredSessionId: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt: 1,
    deliveryMode: null,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    resolved?: { sessionId: string } | { reason: string };
    handoff?: { kind: 'enqueued'; id: string } | { kind: 'rejected'; reason: string };
  } = {}
) {
  const resolved = overrides.resolved ?? { sessionId: 'sub-session-1' };
  return {
    ensureTargetSession: mock(async () =>
      'sessionId' in resolved
        ? { kind: 'resolved', sessionId: resolved.sessionId }
        : { kind: 'unresolved', reason: resolved.reason }
    ),
    handoffToMailbox: mock(async () => overrides.handoff ?? { kind: 'enqueued', id: 'entry-1' }),
    markDelivered: mock(() => {}),
    markFailed: mock(() => {}),
    markAttemptFailed: mock(() => null),
    onDelivered: mock(() => {}),
  };
}

describe('drainPendingRowOntoMailbox', () => {
  it('delivers through the door and the mailbox, then settles the row', async () => {
    const deps = makeDeps();
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'formatted note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'delivered', sessionId: 'sub-session-1' });
    expect(deps.ensureTargetSession).toHaveBeenCalledWith(WORKER_TARGET);
    expect(deps.handoffToMailbox).toHaveBeenCalledWith({
      to: 'session:sub-session-1',
      message: 'formatted note',
      origin: 'space_inject',
      messageUuid: 'row-1',
      policy: pendingDrainMailboxPolicy(row),
    });
    expect(deps.markDelivered).toHaveBeenCalledWith('row-1', 'sub-session-1');
    expect(deps.onDelivered).toHaveBeenCalledWith(row, 'sub-session-1');
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  it('seeds the message uuid from the idempotency key and passes defer mode through', async () => {
    const deps = makeDeps();
    const row = makeRow({
      idempotencyKey: 'human:task-1:coder:node-1:cli-9',
      deliveryMode: 'defer',
    });

    await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'formatted note',
      origin: 'chat',
    });

    expect(deps.handoffToMailbox).toHaveBeenCalledWith({
      to: 'session:sub-session-1',
      message: 'formatted note',
      origin: 'chat',
      messageUuid: 'human:task-1:coder:node-1:cli-9',
      policy: pendingDrainMailboxPolicy(row),
      deliveryMode: 'defer',
    });
  });

  it('skips without touching the repo when the row is already expired', async () => {
    const deps = makeDeps();
    const row = makeRow({ expiresAt: 1 });

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'late note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'skipped', reason: 'expired' });
    expect(deps.ensureTargetSession).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  it('terminalizes the row without handing off when the attempt budget is spent', async () => {
    const deps = makeDeps();
    const row = makeRow({ attempts: 5, maxAttempts: 5 });

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'spent note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'failed', reason: 'delivery attempts exhausted (5)' });
    expect(deps.markFailed).toHaveBeenCalledWith('row-1', 'delivery attempts exhausted (5)');
    expect(deps.handoffToMailbox).not.toHaveBeenCalled();
  });

  it('charges an attempt and keeps the row retryable when the door cannot resolve', async () => {
    const deps = makeDeps({ resolved: { reason: 'task_terminal' } });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'terminal note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'retry', reason: 'session resolution: task_terminal' });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith(
      'row-1',
      'session resolution: task_terminal'
    );
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.handoffToMailbox).not.toHaveBeenCalled();
  });

  it('charges an attempt and keeps the row retryable when the mailbox rejects', async () => {
    const deps = makeDeps({ handoff: { kind: 'rejected', reason: 'address unreachable' } });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'rejected note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({
      action: 'retry',
      reason: 'mailbox handoff rejected: address unreachable',
    });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith(
      'row-1',
      'mailbox handoff rejected: address unreachable'
    );
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  it('charges an attempt when a stage crashes', async () => {
    const deps = makeDeps();
    deps.handoffToMailbox.mockImplementation(async () => {
      throw new Error('job queue exploded');
    });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'crash note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'retry', reason: 'internal: job queue exploded' });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith('row-1', 'internal: job queue exploded');
  });
});

describe('pendingDrainMessageUuid', () => {
  it('prefers the idempotency key and falls back to the row id', () => {
    expect(pendingDrainMessageUuid({ id: 'row-1', idempotencyKey: 'key-1' })).toBe('key-1');
    expect(pendingDrainMessageUuid({ id: 'row-1', idempotencyKey: null })).toBe('row-1');
  });
});

describe('pendingDrainMailboxPolicy', () => {
  it('preserves the remaining ttl and attempt budget from the row', () => {
    const now = Date.now();
    const policy = pendingDrainMailboxPolicy({
      expiresAt: now + 60_000,
      attempts: 2,
      maxAttempts: 5,
    });
    expect(policy.maxAttempts).toBe(3);
    expect(policy.ttlMs).toBeGreaterThan(50_000);
    expect(policy.ttlMs).toBeLessThanOrEqual(60_000);
  });

  it('clamps the policy to at least one attempt and one millisecond', () => {
    const now = Date.now();
    expect(pendingDrainMailboxPolicy({ expiresAt: now, attempts: 9, maxAttempts: 5 })).toEqual({
      ttlMs: 1,
      maxAttempts: 1,
    });
  });
});
