import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  NEO_REORGANIZE_EVERY_MS,
  NEO_REORGANIZE_IDLE_MS,
  NEO_TOPICS_REORGANIZE_NIGHTLY,
  planNeoNightlyReorganize,
  runNeoNightlyReorganize,
  scheduleNeoNightlyReorganize,
} from '../../../../src/lib/neo/reorganize-nightly.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const now = 10 * NEO_REORGANIZE_EVERY_MS;

describe('planNeoNightlyReorganize', () => {
  test('runs once the human has been away long enough and the last run is old enough', () => {
    expect(planNeoNightlyReorganize(now, now - NEO_REORGANIZE_IDLE_MS, null)).toEqual({
      lastRunAt: now,
      nextAt: now + NEO_REORGANIZE_EVERY_MS,
      run: true,
    });
    expect(planNeoNightlyReorganize(now, null, now - NEO_REORGANIZE_EVERY_MS)).toMatchObject({
      run: true,
    });
  });

  test('waits for the human to go idle, then for the next day', () => {
    expect(planNeoNightlyReorganize(now, now - 1000, null)).toEqual({
      lastRunAt: null,
      nextAt: now - 1000 + NEO_REORGANIZE_IDLE_MS,
      run: false,
    });
    expect(planNeoNightlyReorganize(now, null, now - 1000)).toEqual({
      lastRunAt: now - 1000,
      nextAt: now - 1000 + NEO_REORGANIZE_EVERY_MS,
      run: false,
    });
  });
});

describe('runNeoNightlyReorganize', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  function claim(lastRunAt: number | null) {
    scheduleNeoNightlyReorganize(mailbox.jobQueue, 0, lastRunAt);
    scheduleNeoNightlyReorganize(mailbox.jobQueue, 0, lastRunAt);
    expect(mailbox.rowCount()).toBe(1);
    return mailbox.jobQueue.dequeue(NEO_TOPICS_REORGANIZE_NIGHTLY)[0];
  }
  const pending = () =>
    mailbox.jobQueue.listJobs({ queue: NEO_TOPICS_REORGANIZE_NIGHTLY, status: 'pending' });

  test('reorganizes while the human is away and schedules the next day', async () => {
    const lines: string[] = [];
    let runs = 0;
    const result = await runNeoNightlyReorganize(claim(null), mailbox.jobQueue, {
      now: () => now,
      lastHumanAt: () => now - NEO_REORGANIZE_IDLE_MS,
      reorganize: async () => {
        runs++;
        return {
          merged: [{ sourceId: 'x', targetId: 'y' }],
          asked: [],
          moved: [{ askId: 'a', projectId: 'c' }],
          stayed: [{ askId: 'b', reason: 'stays_main' }],
          cleanupPlanned: [],
          cleanupApplied: false,
          cleanupFailed: [],
        };
      },
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ ran: true, moved: 1, stayed: 1 });
    expect(runs).toBe(1);
    expect(lines).toEqual([
      'neo reorganize: nightly run merged 1 project(s), moved 1 ask(s), left 1 with main',
    ]);
    expect(pending()).toHaveLength(1);
    expect(pending()[0].payload).toEqual({ scope: 'neo', lastRunAt: now });
    expect(pending()[0].runAt).toBe(now + NEO_REORGANIZE_EVERY_MS);
  });

  test('leaves topics alone while the human is active and checks back once they go idle', async () => {
    let runs = 0;
    const result = await runNeoNightlyReorganize(
      claim(now - NEO_REORGANIZE_EVERY_MS),
      mailbox.jobQueue,
      {
        now: () => now,
        lastHumanAt: () => now - 60_000,
        reorganize: async () => {
          runs++;
          return {
            merged: [],
            asked: [],
            moved: [],
            stayed: [],
            cleanupPlanned: [],
            cleanupApplied: false,
            cleanupFailed: [],
          };
        },
        log: () => {},
      }
    );

    expect(result).toEqual({ ran: false, nextAt: now - 60_000 + NEO_REORGANIZE_IDLE_MS });
    expect(runs).toBe(0);
    expect(pending()[0].payload).toEqual({
      scope: 'neo',
      lastRunAt: now - NEO_REORGANIZE_EVERY_MS,
    });
  });
});
