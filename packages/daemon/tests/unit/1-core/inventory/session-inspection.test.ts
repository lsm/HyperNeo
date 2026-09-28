import { describe, expect, mock, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  admitSessionInspection,
  createSessionInspectionOperation,
  presentSessionInspection,
  requireInspectionCaller,
  requireInspectionTarget,
  type SessionInspectionDependencies,
} from '../../../../src/lib/inventory/session-inspection.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SpaceSessionMessage } from '../../../../src/lib/session/space-session-reads.ts';
import type { SessionInspectionRecord } from '../../../../src/storage/repositories/daemon-inventory-repository.ts';

const input = { sessionId: 'existing:chat', limit: 5, includeArchived: false };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo:root' };
const binding: NeoBinding = { sessionId: neo.sessionId!, kind: 'neo', concernId: null };
const row: SessionInspectionRecord = {
  id: input.sessionId,
  name: 'Project A',
  status: 'active',
  lastActiveAt: '2026-09-28T10:00:00Z',
  workspacePath: '/projects/a',
  processingStatus: 'waiting_for_input',
  scopeOwned: 0,
  neoBound: 0,
};
const message = (index: number): SpaceSessionMessage => ({
  id: `message:${index}`,
  message_type: 'assistant',
  message_subtype: null,
  is_terminal: false,
  timestamp: `2026-09-28T10:00:0${index}Z`,
  cursor: `time:${index}|message:${index}`,
  content_summary: 'Untrusted reported context, not proof of completion.',
});
function fixtures() {
  const deps = {
    readBinding: mock(() => binding as NeoBinding | null),
    readSession: mock(() => row as SessionInspectionRecord | null),
    readMessages: mock<SessionInspectionDependencies['readMessages']>(() => [message(1)]),
    now: mock(() => 100),
  } satisfies SessionInspectionDependencies;
  const registry = createOperationRegistry([createSessionInspectionOperation(deps)]);
  return {
    deps,
    registry,
    invoke: (value: unknown = input, caller = human) =>
      invokeOperation(registry, 'daemon.session.inspect', value, caller),
  };
}

describe('ordinary inspection pure gates', () => {
  test.each([human, neo])('admits the named local interfaces: %j', (caller) => {
    expect(admitSessionInspection(input, caller)).toEqual({ value: input });
  });
  test.each([
    { source: 'rpc' },
    { source: 'rpc', principal: 'remote' },
    { source: 'internal', principal: 'local', role: 'neo', sessionId: binding.sessionId },
    { source: 'mcp', role: 'neo' },
    { source: 'mcp', role: 'universal_read', sessionId: 'chat' },
    { source: 'mcp', role: 'long_term_agent', sessionId: 'agent' },
    { source: 'mcp', role: 'workflow_worker', sessionId: 'worker' },
  ] satisfies OperationCaller[])('rejects other interfaces without a read grant: %j', (caller) => {
    expect(admitSessionInspection(input, caller)).toEqual({
      reason: { accepted: false, reason: 'inspection_forbidden' },
    });
  });
  test.each([
    null,
    { ...binding, sessionId: 'other' },
    { ...binding, kind: 'worker' as const },
    { ...binding, concernId: 'a' },
    { ...binding, kind: 'concern' as const },
  ])('requires actual matching coordinator identity: %j', (candidate) => {
    expect(requireInspectionCaller(input, neo, candidate)).toEqual({
      reason: { accepted: false, reason: 'inspection_forbidden' },
    });
  });
  test('root and holder are inspect-capable, not execution workers', () => {
    expect(requireInspectionCaller(input, neo, binding)).toEqual({ value: input });
    const holder = { ...binding, concernId: 'a', kind: 'concern' as const };
    expect(requireInspectionCaller(input, neo, holder)).toEqual({ value: input });
    expect(requireInspectionCaller(input, human, null)).toEqual({ value: input });
  });
  test.each([null, { ...row, id: 'different' }])(
    'missing/mismatched identity is not an empty history: %j',
    (candidate) => {
      expect(requireInspectionTarget(input, candidate)).toEqual({
        reason: { accepted: false, reason: 'session_not_found' },
      });
    }
  );
  test.each([{ scopeOwned: 1 }, { neoBound: 1 }, { scopeOwned: -1 }, { neoBound: 2 }])(
    'protected or unknown scope stays protected: %j',
    (patch) => {
      expect(requireInspectionTarget(input, { ...row, ...patch })).toEqual({
        reason: { accepted: false, reason: 'protected_session' },
      });
    }
  );
  test('archive opt-in never bypasses protected context', () => {
    const archived = { ...row, status: 'archived' };
    expect(requireInspectionTarget(input, archived)).toEqual({
      reason: { accepted: false, reason: 'session_archived' },
    });
    expect(requireInspectionTarget({ ...input, includeArchived: true }, archived)).toEqual({
      value: archived,
    });
    expect(
      requireInspectionTarget({ ...input, includeArchived: true }, { ...archived, neoBound: 1 })
    ).toEqual({ reason: { accepted: false, reason: 'protected_session' } });
  });
});

describe('bounded inspection presentation', () => {
  test('whitelists metadata and excerpts without retaining frozen inputs', () => {
    const resource = Object.freeze({
      ...row,
      name: 'x'.repeat(200),
      config: 'SECRET-CONFIG',
      metadata: 'SECRET-METADATA',
      processingStatus: 'p'.repeat(200),
    });
    const history = Object.freeze(
      Array.from({ length: 22 }, (_, index) =>
        Object.freeze({
          ...message(index),
          content_summary: 'e'.repeat(400),
          sdk_message: 'SECRET-RAW',
        })
      )
    );
    const result = presentSessionInspection(
      Object.freeze({ ...input, limit: 20 }),
      resource,
      history,
      123
    );
    expect(result.resource).toEqual({
      kind: 'session',
      id: row.id,
      name: 'x'.repeat(160),
      status: row.status,
      workspacePath: row.workspacePath,
      lastActiveAt: row.lastActiveAt,
      recordedProcessingStatus: 'p'.repeat(160),
    });
    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]).toEqual({
      id: 'message:0',
      type: 'assistant',
      subtype: null,
      isTerminal: false,
      timestamp: message(0).timestamp,
      cursor: message(0).cursor,
      excerpt: 'e'.repeat(300),
    });
    expect(result.nextBefore).toBe(message(19).cursor);
    expect(result.capturedAt).toBe(123);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(resource.name).toHaveLength(200);
    expect(history[0].content_summary).toHaveLength(400);
    result.messages[0].excerpt = 'Changed output';
    expect(history[0].content_summary).toHaveLength(400);
  });
  test.each([[], [message(1)]].map((history) => ({ history })))(
    'represents empty/short history without inventing processing: %j',
    ({ history }) => {
      const result = presentSessionInspection(
        input,
        { ...row, processingStatus: null, workspacePath: null },
        history,
        1
      );
      expect(result.resource).toMatchObject({
        status: 'active',
        recordedProcessingStatus: null,
        workspacePath: null,
      });
      expect(result.messages).toHaveLength(history.length);
      expect(result.nextBefore).toBeNull();
    }
  );
  test('a filled page provides a candidate cursor, not a claim that earlier history exists', () => {
    const result = presentSessionInspection({ ...input, limit: 1 }, row, [message(1)], 1);
    expect(result.nextBefore).toBe(message(1).cursor);
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('complete');
    expect(result.messages[0].isTerminal).toBe(false);
  });
});

describe('ordinary session inspection operation', () => {
  test('defaults and registration use the existing typed operation door, no construction reads', async () => {
    const f = fixtures();
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
    expect(f.registry.get('daemon.session.inspect')?.policy).toEqual({
      safetyClass: 'read',
      roles: ['neo'],
    });
    expect(listOperationSummaries(f.registry, neo).map(({ name }) => name)).toEqual([
      'daemon.session.inspect',
    ]);
    expect(listOperationSummaries(f.registry, { source: 'mcp', role: 'long_term_agent' })).toEqual(
      []
    );
    expect(await f.invoke({ sessionId: input.sessionId })).toEqual({
      kind: 'completed',
      value: presentSessionInspection(input, row, [message(1)], 100),
    });
    expect(f.deps.readBinding).not.toHaveBeenCalled();
    expect(f.deps.readSession).toHaveBeenCalledWith(input.sessionId);
    expect(f.deps.readMessages.mock.calls).toEqual([[input.sessionId, 5, undefined]]);
    expect(f.deps.now).toHaveBeenCalledTimes(1);
  });
  test.each([
    { source: 'rpc', principal: 'remote' },
    { source: 'mcp', role: 'universal_read', sessionId: 'chat' },
    { source: 'internal', role: 'neo', sessionId: binding.sessionId },
  ] satisfies OperationCaller[])('caller denial precedes all read ports: %j', async (caller) => {
    const f = fixtures();
    expect(await f.invoke(input, caller)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'inspection_forbidden' },
    });
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
  });
  test('forged/stale Neo role cannot reach target or history without its binding', async () => {
    const f = fixtures();
    f.deps.readBinding.mockReturnValue(null);
    expect(await f.invoke(input, neo)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'inspection_forbidden' },
    });
    expect(f.deps.readBinding).toHaveBeenCalledWith(binding.sessionId);
    expect(f.deps.readSession).not.toHaveBeenCalled();
    expect(f.deps.readMessages).not.toHaveBeenCalled();
    expect(f.deps.now).not.toHaveBeenCalled();
  });
  test.each([
    { candidate: null, reason: 'session_not_found' },
    { candidate: { ...row, neoBound: 1 }, reason: 'protected_session' },
    { candidate: { ...row, scopeOwned: 1 }, reason: 'protected_session' },
    { candidate: { ...row, status: 'archived' }, reason: 'session_archived' },
  ])('target gate precedes transcript read: %j', async ({ candidate, reason }) => {
    const f = fixtures();
    f.deps.readSession.mockReturnValue(candidate);
    expect(await f.invoke(input, neo)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason },
    });
    expect(f.deps.readMessages).not.toHaveBeenCalled();
    expect(f.deps.now).not.toHaveBeenCalled();
  });
  test('archive opt-in and earlier cursor pass exactly to the existing reader', async () => {
    const f = fixtures();
    f.deps.readSession.mockReturnValue({ ...row, status: 'archived' });
    const options = { ...input, includeArchived: true, limit: 1, before: 'opaque:time|id' };
    expect(await f.invoke(options, neo)).toEqual({
      kind: 'completed',
      value: presentSessionInspection(options, { ...row, status: 'archived' }, [message(1)], 100),
    });
    expect(f.deps.readMessages.mock.calls).toEqual([[input.sessionId, 1, options.before]]);
  });
  test.each([
    { sessionId: '' },
    { ...input, limit: 0 },
    { ...input, limit: 21 },
    { ...input, limit: 1.5 },
    { ...input, before: '' },
    { ...input, includeArchived: 'yes' },
    { ...input, mode: 'parallel' },
  ])('validates before reads: %j', async (value) => {
    const f = fixtures();
    expect(await f.invoke(value, neo)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
  });
  test.each(['binding', 'session', 'history'] as const)(
    'infrastructure failure in %s has no retry or fallback',
    async (stage) => {
      const f = fixtures();
      const port =
        stage === 'binding'
          ? f.deps.readBinding
          : stage === 'session'
            ? f.deps.readSession
            : f.deps.readMessages;
      port.mockImplementation(() => {
        throw new Error('storage failed');
      });
      expect(await f.invoke(input, neo)).toEqual({
        kind: 'failed',
        code: 'execution_failed',
        message: 'storage failed',
      });
      expect(port).toHaveBeenCalledTimes(1);
      expect(f.deps.now).not.toHaveBeenCalled();
    }
  );
});
