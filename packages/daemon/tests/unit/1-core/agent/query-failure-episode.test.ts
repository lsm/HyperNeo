import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/database.ts';
import { QueryFailureGovernor } from '../../../../src/lib/agent/query-failure-episode.ts';

describe('Query failure episode', () => {
  it('retains the failure cap through rehydration and resets only on explicit recovery or success', async () => {
    const session = { id: 'synthetic-worker', metadata: {} } as Session;
    const persisted = structuredClone(session);
    const db = {
      getSession: () => persisted,
      updateSession: vi.fn(async (_id, patch) => Object.assign(persisted.metadata, patch.metadata)),
    } as unknown as Database;
    vi.useFakeTimers();
    try {
      let governor = new QueryFailureGovernor(session, db);
      const episode = await governor.admit(() => true);
      const first = await governor.failure('Unknown fake query error', episode);
      expect(first.failures).toBe(1);
      let ready = false;
      const waiting = governor
        .admit(() => true)
        .then(() => {
          ready = true;
        });
      await vi.advanceTimersByTimeAsync(999);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      await governor.failure('Different fake error', episode);
      governor = new QueryFailureGovernor(structuredClone(persisted), db);
      const retry = governor.admit(() => true);
      await vi.advanceTimersByTimeAsync(2000);
      await retry;
      expect((await governor.failure('Third unknown error', episode)).failed).toBe(true);
      const restored = new QueryFailureGovernor(structuredClone(persisted), db);
      await expect(restored.admit(() => true)).rejects.toThrow('Third unknown error');
      await restored.reset();
      const fresh = await restored.admit(() => true);
      await expect(governor.failure('Late old failure', episode)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await restored.failure('New episode failure', fresh);
      await restored.success(fresh);
      expect(persisted.metadata.queryFailureEpisode?.failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a preparation dependency that never resolves and rejects late superseded completion', async () => {
    const governor = new QueryFailureGovernor(
      { id: 'deadline', metadata: {} } as Session,
      {} as Database
    );
    vi.useFakeTimers();
    try {
      const pending = governor.prepare(
        () => new Promise(() => {}),
        Date.now() + 100,
        () => true
      );
      const checked = expect(pending).rejects.toThrow('Query preparation timed out');
      await vi.advanceTimersByTimeAsync(100);
      await checked;
      await expect(
        governor.prepare(
          async () => 'late',
          Date.now() + 100,
          () => false
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });
});
