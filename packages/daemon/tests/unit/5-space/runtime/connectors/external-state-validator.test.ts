import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearConnectorRegistry,
  registerConnector,
  createExternalStateValidator,
} from '../../../../../src/lib/space/runtime/connectors';
import type {
  ConnectorOp,
  ConnectorOutcome,
} from '../../../../../src/lib/space/runtime/connectors';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';

function ctxWithData(prUrl?: string, extra?: Record<string, unknown>): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'send_message',
    params: { target: 'Review', message: 'hi', data: { pr_url: prUrl, ...extra } },
    nodeId: 'node-1',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
  };
}

function capturingOp(outcome: ConnectorOutcome): { op: ConnectorOp } {
  const op: ConnectorOp = async () => outcome;
  return { op };
}

describe('external_state validator', () => {
  beforeEach(() => clearConnectorRegistry());

  test('pass predicate → allow with projected data', async () => {
    const { op } = capturingOp({ ok: true, data: { state: 'MERGED', url: 'u' } });
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
      dataProjection: (d) => ({ pr_url: d.url }),
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data).toEqual({ pr_url: 'u' });
  });

  test('pending predicate (pass fails) → retryable_block', async () => {
    const { op } = capturingOp({ ok: true, data: { state: 'OPEN' } });
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      pending: { eq: ['state', 'OPEN'] },
      retryAfterMs: 5_000,
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(5_000);
    expect((result as { data?: Record<string, unknown> }).data?.externalStatePending).toBe(true);
  });

  test('pass fails and no pending → terminal block', async () => {
    const { op } = capturingOp({ ok: true, data: { state: 'CLOSED' } });
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      pending: { eq: ['state', 'OPEN'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('condition not satisfied');
  });

  test('retryable op failure (rate limit) → retryable_block with op retryAfterMs', async () => {
    const { op } = capturingOp({
      ok: false,
      error: 'rate limited',
      retryable: true,
      retryAfterMs: 42_000,
    });
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(42_000);
    expect(
      (result as { data?: Record<string, unknown> }).data?.externalStatePending
    ).toBeUndefined();
  });

  test('terminal op failure → block', async () => {
    const { op } = capturingOp({ ok: false, error: 'not found' });
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not found');
  });

  test('unregistered connector → block', async () => {
    const validate = createExternalStateValidator({
      connector: 'nope',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not registered');
  });

  test('unknown op → block', async () => {
    registerConnector({ id: 'stub', ops: {} });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'missing',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData('https://x/y/pull/1'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('no op');
  });

  test('op validates its own params → block when a required input is missing', async () => {
    const op: ConnectorOp = async (opParams) =>
      opParams.subject
        ? { ok: true, data: { state: 'MERGED' } }
        : { ok: false, error: 'subject is required' };
    registerConnector({ id: 'stub', ops: { getIt: op } });
    const validate = createExternalStateValidator({
      connector: 'stub',
      op: 'getIt',
      pass: { eq: ['state', 'MERGED'] },
      label: 'gate',
    });
    const result = await validate(ctxWithData(undefined));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('subject is required');
  });
});
