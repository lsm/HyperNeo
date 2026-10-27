import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/database.ts';
import { QueryFailureGovernor } from '../../../../src/lib/agent/query-failure-episode.ts';

describe('Query failure episode', () => {
  it('retains a bounded useful error when a provider returns a large failure', async () => {
    const session = { id: 'large-error', metadata: {} } as Session;
    const db = {
      getSession: () => session,
      updateSession: async () => {},
    } as unknown as Database;
    const governor = new QueryFailureGovernor(session, db);
    const id = await governor.admit(() => true);
    const episode = await governor.failure(`Original cause: ${'x'.repeat(100_000)}`, id);
    expect(episode.error.startsWith('Original cause: ')).toBe(true);
    expect(episode.error.length).toBeLessThanOrEqual(4096);
    expect(session.metadata.queryFailureEpisode?.error).toBe(episode.error);
  });

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

  it('does not admit an old waiting attempt after explicit recovery', async () => {
    const session = { id: 'recovery-wait', metadata: {} } as Session;
    const db = {
      getSession: () => session,
      updateSession: vi.fn(async (_id, patch) => Object.assign(session.metadata, patch.metadata)),
    } as unknown as Database;
    const governor = new QueryFailureGovernor(session, db);
    vi.useFakeTimers();
    try {
      const old = await governor.admit(() => true);
      await governor.failure('Fake error', old);
      const waiting = governor.admit(() => true);
      const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      await governor.reset();
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(await governor.admit(() => true)).not.toBe(old);
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
      const pending = governor.bound(
        () => new Promise(() => {}),
        Date.now() + 100,
        () => true
      );
      const checked = expect(pending).rejects.toThrow('Query preparation timed out');
      await vi.advanceTimersByTimeAsync(100);
      await checked;
      await expect(
        governor.bound(
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
