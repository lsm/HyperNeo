import { describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import {
  admitNeoWorkOrigin,
  requireLiveNeoWorkOrigin,
} from '../../../../src/lib/neo/work-origin.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const caller: OperationCaller = {
  source: 'mcp',
  sessionId: 'root',
  neoTurn: { messageId: 'ask-A', human: true, isLive: () => true },
};
describe('Neo work input origins', () => {
  test.each([
    ['missing session', human, undefined],
    ['remote RPC', { source: 'rpc', principal: 'other' }, 'root'],
    ['no runtime identity', { source: 'mcp', sessionId: 'root' }, 'root'],
    ['wrong session', caller, 'holder'],
    ['blank input', { ...caller, neoTurn: { ...caller.neoTurn!, messageId: '' } }, 'root'],
    ['closed turn', { ...caller, neoTurn: { ...caller.neoTurn!, isLive: () => false } }, 'root'],
  ] as const)('rejects %s before reservation', (_name, candidate, sessionId) => {
    expect(admitNeoWorkOrigin(candidate, sessionId)).toMatchObject({ reason: { ok: false } });
  });
  test('local RPC provenance is explicitly unknown even with supplied turn metadata', () => {
    expect(admitNeoWorkOrigin({ ...human, neoTurn: caller.neoTurn }, 'root')).toEqual({
      value: { originSessionId: 'root', originMessageId: null },
    });
    expect(
      requireLiveNeoWorkOrigin({ originSessionId: 'root', originMessageId: 'forged' }, human)
    ).toMatchObject({ reason: { ok: false } });
  });
  test('records actual root or holder input identity without treating system input as human lineage', () => {
    expect(admitNeoWorkOrigin(caller, 'root')).toEqual({
      value: { originSessionId: 'root', originMessageId: 'ask-A' },
    });
    expect(
      admitNeoWorkOrigin(
        {
          ...caller,
          sessionId: 'holder',
          neoTurn: {
            messageId: 'neo-consult:one:request',
            consultationId: 'one',
            human: false,
            isLive: () => true,
          },
        },
        'holder'
      )
    ).toEqual({ value: { originSessionId: 'holder', originMessageId: 'neo-consult:one:request' } });
  });
  test('rechecks captured identity against the live attempt and current input', () => {
    const attempts = new QueryAttemptRegistry();
    const attempt = attempts.allocate();
    const bound = { ...caller, neoTurn: { ...caller.neoTurn!, isLive: attempt.isLive } };
    const result = admitNeoWorkOrigin(bound, 'root');
    if ('reason' in result) throw new Error(result.reason.reason);
    expect(requireLiveNeoWorkOrigin(result.value, bound)).toEqual(result);
    expect(
      requireLiveNeoWorkOrigin(result.value, {
        ...bound,
        neoTurn: { ...bound.neoTurn, messageId: 'ask-B' },
      })
    ).toMatchObject({ reason: { ok: false } });
    attempts.allocate();
    expect(requireLiveNeoWorkOrigin(result.value, bound)).toMatchObject({ reason: { ok: false } });
    expect(result.value.originMessageId).toBe('ask-A');
  });
});
