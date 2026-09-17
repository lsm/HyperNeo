import { describe, test, expect } from 'bun:test';
import { createPrMergedGate } from '../../../../src/lib/workflows/end-node-handlers.ts';
import type { SpaceTask } from '@hyperneo/shared';

describe('createPrMergedGate', () => {
  const PR_URL = 'https://github.com/lsm/HyperNeo/pull/1234';

  function makeGateDeps(opts: { state?: string; throwOnLookup?: boolean; prUrl?: string } = {}) {
    const { state = 'MERGED', throwOnLookup = false, prUrl = PR_URL } = opts;
    return {
      resolvePrUrl: () => prUrl,
      getPrState: async () => {
        if (throwOnLookup) throw new Error('GitHub unreachable');
        return state;
      },
    };
  }

  const task = { id: 't-1', spaceId: 's-1' } as SpaceTask;

  test('passes when the PR is MERGED', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'MERGED' }));
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });

  test('blocks while the PR is OPEN (merge not yet done)', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'OPEN' }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('still OPEN');
      expect(result.error).toContain(PR_URL);
    }
  });

  test('blocks when the PR is CLOSED without a merge', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'CLOSED' }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLOSED');
      expect(result.error).toContain('not merged');
    }
  });

  test('fails closed on lookup error', async () => {
    const gate = createPrMergedGate(makeGateDeps({ throwOnLookup: true }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not verify');
    }
  });

  test('passes when no pr_url resolves and the workflow does not require one', async () => {
    const gate = createPrMergedGate(makeGateDeps({ prUrl: '' }));
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });

  test('fails closed when a required pr_url does not resolve', async () => {
    const gate = createPrMergedGate({
      resolvePrUrl: () => '',
      requirePrUrl: true,
      getPrState: async () => {
        throw new Error('must not be called');
      },
    });
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not resolve the run's PR URL");
      expect(result.error).toContain('stays approved');
    }
  });
});
