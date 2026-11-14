import { beforeEach, describe, expect, test } from 'bun:test';
import { anthropicRateLimitEventsRead } from '../../../../src/storage/repositories/anthropic-usage-read';
import { ChangeRecorder } from '../../../../src/storage/db-gateway/db-op';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;

function store(event: Record<string, unknown>, timestamp: string): void {
  const body = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: event });
  db.prepare(
    `INSERT INTO sdk_messages(id, session_id, message_type, timestamp, sdk_message)
     VALUES (?, 'synthetic-session', 'rate_limit_event', ?, ?)`
  ).run(crypto.randomUUID(), timestamp, body);
}

function read() {
  return anthropicRateLimitEventsRead.run(db, 200, new ChangeRecorder());
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE sdk_messages(id TEXT PRIMARY KEY, session_id TEXT, message_type TEXT, timestamp TEXT, sdk_message TEXT, body_seq INTEGER);CREATE TABLE sdk_message_bodies(seq INTEGER PRIMARY KEY, sdk_message TEXT)'
  );
});

describe('stored rate limit events', () => {
  test('keeps the newest event per window and skips the overage window', () => {
    store(
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 },
      '2026-11-13T10:00:00Z'
    );
    store(
      { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8 },
      '2026-11-13T12:00:00Z'
    );
    store(
      { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_795_000_000 },
      '2026-11-13T11:00:00Z'
    );
    store(
      { status: 'allowed', rateLimitType: 'overage', utilization: 0.1 },
      '2026-11-13T13:00:00Z'
    );

    expect(read()).toEqual([
      { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8 },
      { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_795_000_000 },
    ]);
  });

  test('skips a row whose body is not valid JSON', () => {
    db.prepare(
      `INSERT INTO sdk_messages(id, session_id, message_type, timestamp, sdk_message)
       VALUES ('broken', 'synthetic-session', 'rate_limit_event', '2026-11-13T14:00:00Z', 'not json')`
    ).run();
    store(
      { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.5 },
      '2026-11-13T10:00:00Z'
    );

    expect(read()).toEqual([
      { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.5 },
    ]);
  });
});
