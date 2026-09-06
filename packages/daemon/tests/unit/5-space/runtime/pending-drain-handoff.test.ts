import { describe, expect, it, mock } from 'bun:test';
import {
  drainPendingRowOntoMailbox,
  pendingDrainMessageUuid,
} from '../../../../src/lib/space/runtime/pending-drain-handoff.ts';

import type { AgentMessageDeliveryOutcome } from '../../../../src/lib/space/runtime/agent-message-router.ts';
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
    delivery?: AgentMessageDeliveryOutcome;
  } = {}
) {
  const resolved = overrides.resolved ?? { sessionId: 'sub-session-1' };
  return {
    ensureTargetSession: mock(async () =>
      'sessionId' in resolved
        ? { kind: 'resolved', sessionId: resolved.sessionId }
        : { kind: 'unresolved', reason: resolved.reason }
    ),
    deliverRoutedMessage: mock(
      async () =>
        overrides.delivery ?? { state: 'delivered', sessionId: 'sub-session-1', messageId: 'row-1' }
    ),
    markDelivered: mock(() => {}),
    markFailed: mock(() => {}),
    markAttemptFailed: mock(() => null),
    onDelivered: mock(() => {}),
  };
}

describe('drainPendingRowOntoMailbox', () => {
  it('delivers through the routed delivery pipeline, then settles the row', async () => {
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
    expect(deps.deliverRoutedMessage).toHaveBeenCalledWith({
      target: WORKER_TARGET,
      message: 'formatted note',
      messageId: 'row-1',
      inputKind: 'task',
      origin: 'space_inject',
    });
    expect(deps.markDelivered).toHaveBeenCalledWith('row-1', 'sub-session-1');
    expect(deps.onDelivered).toHaveBeenCalledWith(row, 'sub-session-1');
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  it('scopes the delivery messageId to the pending record and marks human input', async () => {
    const deps = makeDeps();
    const row = makeRow({
      idempotencyKey: 'human:task-1:coder:node-1:cli-9',
      sourceAgentName: 'human',
      deliveryMode: 'defer',
    });

    await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'formatted note',
      origin: 'chat',
    });

    expect(deps.deliverRoutedMessage).toHaveBeenCalledWith({
      target: WORKER_TARGET,
      message: 'formatted note',
      messageId: 'row-1',
      inputKind: 'human',
      origin: 'chat',
      deliveryMode: 'defer',
    });
  });

  it('settles queued deliveries as delivered to the checkpoint session', async () => {
    const deps = makeDeps({
      delivery: { state: 'queued', sessionId: 'sub-session-1', messageId: 'row-1' },
    });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'formatted note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'delivered', sessionId: 'sub-session-1' });
    expect(deps.markDelivered).toHaveBeenCalledWith('row-1', 'sub-session-1');
  });

  it('terminalizes rows that expired before drain admission', async () => {
    const deps = makeDeps();
    const row = makeRow({ expiresAt: 1 });

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'late note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'failed', reason: 'expired before drain admission' });
    expect(deps.markFailed).toHaveBeenCalledWith('row-1', 'expired before drain admission');
    expect(deps.ensureTargetSession).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  it('terminalizes rows whose deadline passes while the routed delivery waits', async () => {
    const deps = makeDeps({
      delivery: { state: 'delivered', sessionId: 'sub-session-1', messageId: 'row-1' },
    });
    const row = makeRow({ expiresAt: Date.now() + 20 });
    deps.deliverRoutedMessage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { state: 'delivered', sessionId: 'sub-session-1', messageId: 'row-1' };
    });

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'slow delivery note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'failed', reason: 'expired during routed delivery' });
    expect(deps.markFailed).toHaveBeenCalledWith('row-1', 'expired during routed delivery');
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  it('terminalizes the row without delivering when the attempt budget is spent', async () => {
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
    expect(deps.deliverRoutedMessage).not.toHaveBeenCalled();
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
    expect(deps.deliverRoutedMessage).not.toHaveBeenCalled();
  });

  it('rechecks the deadline after session resolution and skips rows that expired mid-wait', async () => {
    const deps = {
      ensureTargetSession: mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { kind: 'resolved', sessionId: 'sub-session-1', created: false };
      }),
      deliverRoutedMessage: mock(async () => ({
        state: 'delivered',
        sessionId: 'sub-session-1',
        messageId: 'row-1',
      })),
      markDelivered: mock(() => {}),
      markFailed: mock(() => {}),
      markAttemptFailed: mock(() => null),
      onDelivered: mock(() => {}),
    };
    const row = makeRow({ expiresAt: Date.now() + 20 });

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'short ttl note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'failed', reason: 'expired during session resolution' });
    expect(deps.ensureTargetSession).toHaveBeenCalledTimes(1);
    expect(deps.deliverRoutedMessage).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith('row-1', 'expired during session resolution');
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  it('charges an attempt and keeps the row retryable when routed delivery fails', async () => {
    const deps = makeDeps({
      delivery: { state: 'failed', messageId: 'row-1', error: 'task/run is terminal (cancelled)' },
    });
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
      reason: 'routed delivery failed: task/run is terminal (cancelled)',
    });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith(
      'row-1',
      'routed delivery failed: task/run is terminal (cancelled)'
    );
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  it('charges an attempt and keeps the row retryable when the routed target is not found', async () => {
    const deps = makeDeps({
      delivery: { state: 'not_found', messageId: 'row-1', error: 'activation_timeout' },
    });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'activation note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({
      action: 'retry',
      reason: 'routed delivery not_found: activation_timeout',
    });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith(
      'row-1',
      'routed delivery not_found: activation_timeout'
    );
  });

  it('charges an attempt when a stage crashes', async () => {
    const deps = makeDeps();
    deps.deliverRoutedMessage.mockImplementation(async () => {
      throw new Error('delivery pipeline exploded');
    });
    const row = makeRow();

    const outcome = await drainPendingRowOntoMailbox({
      deps,
      row,
      target: WORKER_TARGET,
      message: 'crash note',
      origin: 'space_inject',
    });

    expect(outcome).toEqual({ action: 'retry', reason: 'internal: delivery pipeline exploded' });
    expect(deps.markAttemptFailed).toHaveBeenCalledWith(
      'row-1',
      'internal: delivery pipeline exploded'
    );
  });
});

describe('pendingDrainMessageUuid', () => {
  it('scopes the delivery uuid to the pending record id', () => {
    expect(pendingDrainMessageUuid({ id: 'row-1', idempotencyKey: 'key-1' })).toBe('row-1');
    expect(pendingDrainMessageUuid({ id: 'row-1' })).toBe('row-1');
  });
});
