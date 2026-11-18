import { describe, expect, test } from 'bun:test';

describe('inferWorkerOwnership', () => {
  test('lists unreleased legacy starts with evidence and excludes protected sessions', async () => {
    const path = '../../../../src/lib/neo/worker-ownership-backfill.ts';
    const { inferWorkerOwnership } = await import(path);
    const rows = [
      'created',
      'reused',
      'sent',
      'adopted',
      'bound',
      'named',
      'claimed',
      'released',
      'worker',
    ].map((id) => ({
      adapter: 'claude-code',
      id,
      startedAt: 100,
      claimedBy: id === 'claimed' ? 'todo' : null,
      releasedAt: id === 'released' ? 101 : null,
      role: id === 'worker' ? 'worker' : null,
    }));
    const touches = [
      { adapter: 'claude-code', id: 'created', verb: 'start', humanNamed: false },
      { adapter: 'claude-code', id: 'reused', verb: 'send', humanNamed: false },
      { adapter: 'claude-code', id: 'sent', verb: 'send', humanNamed: false },
      { adapter: 'claude-code', id: 'adopted', verb: 'adopt', humanNamed: false },
      { adapter: 'claude-code', id: 'bound', verb: 'bind', humanNamed: false },
      { adapter: 'claude-code', id: 'named', verb: 'start', humanNamed: true },
    ];
    const result = inferWorkerOwnership(rows, touches);
    expect(result.candidates.map((row) => row.id)).toEqual(['created', 'claimed']);
    expect(result.candidates[0].evidence).toMatchObject({
      startedAt: 100,
      claimedBy: null,
      verbs: ['start'],
    });
    expect(result.candidates[1].evidence.strength).toBe('inferred, weak');
    expect(result.notice).toContain('Creation is inferred, not proven');
  });
});
