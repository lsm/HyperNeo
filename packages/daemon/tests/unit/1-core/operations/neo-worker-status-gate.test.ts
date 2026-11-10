import { describe, expect, test } from 'bun:test';
import { neoSyncedWorkers, neoWorkerStatusDue } from '../../../../src/lib/neo/worker-status-gate';

describe('neoWorkerStatusDue', () => {
  test('reads a worker the sync does not hold, or one that changed', () => {
    expect(neoWorkerStatusDue(undefined, undefined)).toBe(true);
    expect(neoWorkerStatusDue('done:1', undefined)).toBe(true);
    expect(neoWorkerStatusDue('done:2', 'done:1')).toBe(true);
    expect(neoWorkerStatusDue('done:1', 'done:1')).toBe(false);
  });
});

describe('neoSyncedWorkers', () => {
  test('keys each worker by status and last activity', () => {
    expect(
      neoSyncedWorkers([{ adapter: 'codex-desktop', id: 'a', status: 'done', at: 5 }]).get(
        'codex-desktop:a'
      )
    ).toBe('done:5');
  });
});
