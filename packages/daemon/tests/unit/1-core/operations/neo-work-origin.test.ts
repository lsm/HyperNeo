import { describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import {
  admitNeoWorkOrigin,
  isNeoAskStartApproved,
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

describe('isNeoAskStartApproved', () => {
  const neo: OperationCaller = {
    source: 'mcp',
    sessionId: 'root',
    neoTurn: { messageId: 'note-1', human: false, isLive: () => true },
  };
  const work = { id: 'w1', status: 'proposed' as const };
  const ask = { originSessionId: 'root', approvedAt: 5, status: 'open' as const, workIds: ['w1'] };
  test.each<[string, Partial<typeof ask>, Partial<typeof work>, OperationCaller, boolean]>([
    ['a proposed item under an approved open ask', {}, {}, neo, true],
    ['an ask not approved', { approvedAt: null as never }, {}, neo, false],
    ['a settled ask', { status: 'achieved' as never }, {}, neo, false],
    ['another Neo session', {}, {}, { ...neo, sessionId: 'holder' }, false],
    ['an item not under the ask', { workIds: ['w2'] }, {}, neo, false],
    ['an item already started', {}, { status: 'queued' as never }, neo, false],
    [
      'a turn that ended',
      {},
      {},
      { ...neo, neoTurn: { ...neo.neoTurn!, isLive: () => false } },
      false,
    ],
    ['the user', {}, {}, { source: 'rpc', principal: 'local' }, false],
  ])('%s', (_label, askOverrides, workOverrides, as, approved) => {
    expect(
      isNeoAskStartApproved({ ...work, ...workOverrides }, { ...ask, ...askOverrides }, as)
    ).toBe(approved);
  });
});
