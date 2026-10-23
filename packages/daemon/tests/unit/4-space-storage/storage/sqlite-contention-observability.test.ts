import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { subscribeToStructuredLogs } from '../../../../src/lib/logger';
import { Database } from '../../../../src/storage/sqlite-compat';
import { withBusyRetry } from '../../../../src/storage/busy-retry';

const options = {
  slowThresholdMs: 0,
  summaryIntervalMs: 0,
  maxQueryGroups: 10,
  summaryQueryLimit: 10,
};

describe('SQLite contention diagnostic contract', () => {
  test('successful transactions expose acquisition, body and commit without changing results', () => {
    const events: Record<string, unknown>[] = [];
    const off = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:sqlite.query') events.push(event.metadata);
    });
    const db = new Database(':memory:', { queryObservability: options });
    try {
      db.exec('CREATE TABLE proof(n INTEGER)');
      const result = db.transaction(() => {
        db.prepare('INSERT INTO proof VALUES (?)').run(7);
        return 'unchanged';
      }, 'immediate')();
      expect(result).toBe('unchanged');
      expect(db.prepare('SELECT n FROM proof').get()).toEqual({ n: 7 });
      const transaction = events.find((e) => e.operation === 'transaction');
      expect(transaction).toMatchObject({
        outcome: 'ok',
        transaction: {
          mode: 'immediate',
          boundary: 'transaction',
          phases: [
            expect.objectContaining({ phase: 'begin', outcome: 'acquired' }),
            expect.objectContaining({ phase: 'body', outcome: 'ok' }),
            expect.objectContaining({ phase: 'commit', outcome: 'ok' }),
          ],
        },
      });
      expect(transaction?.executionStartedAt).toEqual(expect.any(Number));
      expect(transaction?.executionFinishedAt).toEqual(expect.any(Number));
    } finally {
      db.close();
      off();
    }
  });

  test('nested rollback is labelled as savepoint rollback and retains the outer write', () => {
    const events: Record<string, unknown>[] = [];
    const off = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:sqlite.query') events.push(event.metadata);
    });
    const db = new Database(':memory:', { queryObservability: options });
    try {
      db.exec('CREATE TABLE proof(n INTEGER)');
      db.transaction(() => {
        db.run('INSERT INTO proof VALUES (1)');
        expect(() =>
          db.transaction(() => {
            db.run('INSERT INTO proof VALUES (2)');
            throw new Error('synthetic rollback');
          })()
        ).toThrow('synthetic rollback');
      }, 'immediate')();
      expect(db.prepare('SELECT n FROM proof').all()).toEqual([{ n: 1 }]);
      expect(events.find((e) => e.outcome === 'error')).toMatchObject({
        transaction: {
          boundary: 'savepoint',
          phases: [
            expect.objectContaining({ phase: 'begin', outcome: 'acquired' }),
            expect.objectContaining({ phase: 'body', outcome: 'error' }),
            expect.objectContaining({ phase: 'rollback', outcome: 'error' }),
          ],
        },
      });
    } finally {
      db.close();
      off();
    }
  });

  test('busy retries log actual sleep and terminal outcome while retaining backoff', () => {
    const events: Record<string, unknown>[] = [];
    const off = subscribeToStructuredLogs((event) => {
      if (event.message === 'sqlite.busy_retry') events.push(event.metadata);
    });
    let attempts = 0;
    const sleeps: number[] = [];
    try {
      expect(
        withBusyRetry(
          () => {
            if (++attempts < 3) throw new Error('database is locked');
            return 42;
          },
          {
            sleep: (ms) => {
              sleeps.push(ms);
            },
          }
        )
      ).toBe(42);
      expect(sleeps).toEqual([25, 50]);
      expect(events.filter((e) => e.phase === 'sleep')).toEqual([
        expect.objectContaining({ requestedMs: 25, outcome: 'ok', durationMs: expect.any(Number) }),
        expect.objectContaining({ requestedMs: 50, outcome: 'ok', durationMs: expect.any(Number) }),
      ]);
      expect(events.at(-1)).toMatchObject({ phase: 'retry', attempt: 3, outcome: 'ok' });
    } finally {
      off();
    }
  });
  test('real gateway, merge and mirror workers retain contention ownership and original times', () => {
    const root = mkdtempSync(join(tmpdir(), 'hn-sqlite-contention-'));
    mkdirSync(join(root, 'home'));
    try {
      const proof = resolve(
        import.meta.dirname,
        '../../../../../../.claude/skills/verify/sqlite-contention.ts'
      );
      const child = spawnSync('bun', [proof, root], {
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(root, 'data'),
          HYPERNEO_SQL_QUERY_OBSERVABILITY: '1',
        },
        timeout: 12_000,
        encoding: 'utf8',
      });
      expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({
        status: 0,
        error: undefined,
        stderr: '',
      });
      const observed = JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8'));
      expect(observed.forwardedWorkers).toEqual([
        'db-gateway-write',
        'message-search-merge',
        'project-mirror',
      ]);
      expect(observed.rows).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
