import { describe, expect, test } from 'bun:test';
import { neoDerivedId } from '../../../../src/lib/neo/derived-id.ts';
import { neoTurnRequestKey } from '../../../../src/lib/neo/request-key.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const turn = (messageId: string): OperationCaller => ({
  source: 'mcp',
  sessionId: 'root',
  role: 'neo',
  neoTurn: { messageId, human: true, isLive: () => true },
});

describe('neoDerivedId', () => {
  test('derives the same version-8 UUID from the same seed', () => {
    expect(neoDerivedId('seed')).toBe(neoDerivedId('seed'));
    expect(neoDerivedId('seed')).not.toBe(neoDerivedId('other'));
    expect(neoDerivedId('seed')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe('neoTurnRequestKey', () => {
  test('a retry of the same request in the same turn gets the same key', () => {
    const key = neoTurnRequestKey(turn('m1'), 'neo.work.propose', { title: 'A' });
    expect(neoTurnRequestKey(turn('m1'), 'neo.work.propose', { title: 'A' })).toBe(key);
    expect(neoTurnRequestKey(turn('m1'), 'neo.work.propose', { title: 'B' })).not.toBe(key);
    expect(neoTurnRequestKey(turn('m2'), 'neo.work.propose', { title: 'A' })).not.toBe(key);
    expect(neoTurnRequestKey(turn('m1'), 'neo.ask.open', { title: 'A' })).not.toBe(key);
  });

  test('a caller without a turn gets a fresh key every time', () => {
    const human: OperationCaller = { source: 'rpc', principal: 'local' };
    expect(neoTurnRequestKey(human, 'neo.work.propose', {})).not.toBe(
      neoTurnRequestKey(human, 'neo.work.propose', {})
    );
  });
});
