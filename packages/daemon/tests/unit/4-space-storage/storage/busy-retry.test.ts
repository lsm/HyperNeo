import { describe, expect, it } from 'bun:test';
import { isSqliteBusyError, withBusyRetry } from '../../../../src/storage/busy-retry';

class FakeSqliteError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'SQLiteError';
  }
}

describe('isSqliteBusyError', () => {
  it('matches the bun:sqlite database is locked message', () => {
    expect(isSqliteBusyError(new FakeSqliteError('database is locked'))).toBe(true);
  });

  it('matches SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT codes', () => {
    expect(isSqliteBusyError(new FakeSqliteError('something', 'SQLITE_BUSY'))).toBe(true);
    expect(isSqliteBusyError(new FakeSqliteError('something', 'SQLITE_BUSY_SNAPSHOT'))).toBe(true);
  });

  it('rejects unrelated sqlite errors', () => {
    expect(isSqliteBusyError(new FakeSqliteError('no such table: foo'))).toBe(false);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('unrelated'))).toBe(false);
    expect(isSqliteBusyError('database is locked')).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });
});

describe('withBusyRetry', () => {
  it('returns the result without retrying when the operation succeeds', () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        return 'ok';
      },
      { sleep: (ms) => sleeps.push(ms) }
    );

    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries with exponential backoff until the lock clears', () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls++;
        if (calls < 3) throw new FakeSqliteError('database is locked', 'SQLITE_BUSY');
        return 42;
      },
      { baseDelayMs: 10, sleep: (ms) => sleeps.push(ms) }
    );

    expect(result).toBe(42);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('rethrows non-busy errors immediately without retrying', () => {
    const sleeps: number[] = [];
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls++;
          throw new Error('no such table: sdk_messages');
        },
        { sleep: (ms) => sleeps.push(ms) }
      )
    ).toThrow('no such table: sdk_messages');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('throws the last busy error after exhausting attempts', () => {
    const sleeps: number[] = [];
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls++;
          throw new FakeSqliteError('database is locked', 'SQLITE_BUSY');
        },
        { maxAttempts: 3, baseDelayMs: 10, sleep: (ms) => sleeps.push(ms) }
      )
    ).toThrow('database is locked');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('runs at least one attempt when maxAttempts is below one', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls++;
          throw new FakeSqliteError('database is locked');
        },
        { maxAttempts: 0, sleep: () => {} }
      )
    ).toThrow('database is locked');
    expect(calls).toBe(1);
  });
});
