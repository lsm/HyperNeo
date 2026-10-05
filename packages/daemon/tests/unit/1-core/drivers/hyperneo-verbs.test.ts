import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createHyperneoAdapter } from '../../../../src/lib/drivers/hyperneo-adapter';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff';

describe('hyperneo adapter send and status', () => {
  let db: Database;
  let handed: Array<{ sessionId: string; message: string; from: string }>;
  let outcome: MailboxHandoffOutcome;

  beforeEach(() => {
    handed = [];
    outcome = { kind: 'enqueued', id: 'mb1' };
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, main_repo_path TEXT,
      status TEXT, last_active_at TEXT, processing_state TEXT, type TEXT, space_id TEXT, room_id TEXT)`);
    db.exec(`CREATE TABLE sdk_messages (session_id TEXT, message_type TEXT, sdk_message TEXT,
      timestamp TEXT, parent_tool_use_id TEXT)`);
    const session =
      db.prepare(`INSERT INTO sessions (id, title, workspace_path, status, last_active_at,
      processing_state, type, space_id) VALUES (?, ?, '/focus/dolmen', ?, '2026-10-04T10:00:00.000Z', ?, 'worker', ?)`);
    session.run('idle', 'loader', 'active', '{"status":"idle"}', null);
    session.run('busy', 'parser', 'active', '{"status":"processing"}', null);
    session.run('gone', 'old', 'archived', null, null);
    session.run('space', 'space work', 'active', null, 'sp1');
    const result = db.prepare(`INSERT INTO sdk_messages VALUES (?, 'result', ?, ?, ?)`);
    result.run(
      'idle',
      '{"result":"first answer","is_error":false}',
      '2026-10-04T09:00:00.000Z',
      null
    );
    result.run(
      'idle',
      '{"result":"loader is fixed","is_error":false}',
      '2026-10-04T10:00:00.000Z',
      null
    );
    result.run('idle', '{"result":"subagent note"}', '2026-10-04T11:00:00.000Z', 'tool-1');
    result.run(
      'busy',
      '{"result":"API Error: 401","is_error":true}',
      '2026-10-04T10:00:00.000Z',
      null
    );
  });

  afterEach(() => db.close());

  function adapter() {
    return createHyperneoAdapter({
      db: () => db,
      machine: 'imac',
      searchSessionIds: () => new Set(),
      handoff: async (sessionId, message, from) => {
        handed.push({ sessionId, message, from });
        return outcome;
      },
    });
  }

  const ref = (id: string) => ({ adapter: 'hyperneo', id });
  const from = { from: 'session:neo:root' };

  test('status returns the session with its last top-level reply', async () => {
    expect(await adapter().status?.(ref('idle'))).toEqual({
      ok: true,
      value: {
        ref: ref('idle'),
        title: 'loader',
        place: { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' },
        status: 'done',
        lastActivityAt: Date.parse('2026-10-04T10:00:00.000Z'),
        link: '/session/idle',
        lastReply: 'loader is fixed',
      },
    });
  });

  test('status reads a failed last turn as failed only once the session is idle', async () => {
    expect(await adapter().status?.(ref('busy'))).toMatchObject({
      ok: true,
      value: { status: 'running' },
    });
    db.exec(`UPDATE sessions SET processing_state = '{"status":"idle"}' WHERE id = 'busy'`);
    expect(await adapter().status?.(ref('busy'))).toMatchObject({
      ok: true,
      value: { status: 'failed', lastReply: 'API Error: 401' },
    });
  });

  test('status and send do not reach sessions that belong to a Space or do not exist', async () => {
    expect(await adapter().status?.(ref('space'))).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(await adapter().send?.(ref('nope'), 'hi', from)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  test('send hands the message to the mailbox with the caller as origin', async () => {
    expect(await adapter().send?.(ref('idle'), 'go on', from)).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(await adapter().send?.(ref('busy'), 'next', from)).toEqual({
      ok: true,
      value: { delivered: false },
    });
    expect(handed).toEqual([
      { sessionId: 'idle', message: 'go on', from: 'session:neo:root' },
      { sessionId: 'busy', message: 'next', from: 'session:neo:root' },
    ]);
  });

  test('send rejects archived sessions and reports a refused handoff', async () => {
    expect(await adapter().send?.(ref('gone'), 'hi', from)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    outcome = { kind: 'rejected', reason: 'mailbox full' };
    expect(await adapter().send?.(ref('idle'), 'hi', from)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'mailbox full',
    });
    expect(handed.map((h) => h.sessionId)).toEqual(['idle']);
  });
});
