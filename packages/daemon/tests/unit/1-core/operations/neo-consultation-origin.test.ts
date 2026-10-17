import { describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import {
  admitNeoConsultationOrigin,
  requireLiveNeoConsultationOrigin,
} from '../../../../src/lib/neo/consultation-origin.ts';

const root: NeoBinding = { sessionId: 'neo:root', projectId: null, kind: 'neo' };
const turn = { messageId: 'ask-A', human: true, isLive: () => true };
const caller: OperationCaller = { source: 'mcp', sessionId: root.sessionId, neoTurn: turn };
const origin = { originSessionId: root.sessionId, originMessageId: turn.messageId };

describe('admitNeoConsultationOrigin', () => {
  test.each([true, false])('uses the bound input, including human=%s', (human) => {
    expect(admitNeoConsultationOrigin({ ...caller, neoTurn: { ...turn, human } }, root)).toEqual({
      value: origin,
    });
  });
  test('admits a project Neo session the same way', () => {
    const holder: NeoBinding = { sessionId: 'neo:club', projectId: 'club', kind: 'project' };
    expect(admitNeoConsultationOrigin({ ...caller, sessionId: holder.sessionId }, holder)).toEqual({
      value: { ...origin, originSessionId: holder.sessionId },
    });
  });
  test.each([
    [{ ...caller, source: 'rpc', principal: 'local' }, root],
    [{ ...caller, source: 'internal' }, root],
    [caller, null],
    [caller, { ...root, kind: 'worker' }],
    [{ ...caller, sessionId: 'other' }, root],
  ] as [OperationCaller, NeoBinding | null][])(
    'admits only the calling Neo session before input admission: %j',
    (request, binding) => {
      expect(admitNeoConsultationOrigin(request, binding)).toEqual({
        reason: { ok: false, reason: 'Only a Neo session can consult.' },
      });
    }
  );
  test.each([undefined, { ...turn, isLive: () => false }, { ...turn, messageId: '' }])(
    'rejects an unbound or stale input: %j',
    (neoTurn) => {
      expect(admitNeoConsultationOrigin({ ...caller, neoTurn }, root)).toHaveProperty(
        'reason.ok',
        false
      );
    }
  );
});

describe('requireLiveNeoConsultationOrigin', () => {
  test('returns the captured identity without changing it', () => {
    expect(requireLiveNeoConsultationOrigin(origin, turn)).toEqual({ value: origin });
  });
  test.each([undefined, { ...turn, isLive: () => false }, { ...turn, messageId: 'ask-B' }])(
    'a successor cannot borrow the captured input: %j',
    (current) => {
      expect(requireLiveNeoConsultationOrigin(origin, current)).toHaveProperty('reason.ok', false);
    }
  );
});
