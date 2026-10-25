import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReplyCall } from '../../../../src/lib/messaging/session-reply';
import { readDriverSettlement } from '../../../../src/lib/neo/driver-work';
import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createHyperneoAdapter,
  type HyperneoSessionControl,
} from '../../../../src/lib/drivers/hyperneo-adapter';
import { ModelUnavailableError } from '../../../../src/lib/session/session-lifecycle';
import type { ArchiveAdmission } from '../../../../src/lib/drivers/types';
import type { MailboxHandoffOutcome } from '../../../../src/lib/mailbox/handoff';
import { Database } from '../../../../src/storage/sqlite-compat';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns';

function control(db: Database, events: string[], withdraw?: HyperneoSessionControl['withdraw']) {
  let selectedModel = 'gpt-6-luna';
  return {
    sessions: {
      ...(withdraw ? { withdraw } : {}),
      resolveModel: async (model: string) =>
        model === 'GLM 5.3'
          ? { id: 'glm-5.3', provider: 'glm' }
          : ['glm-5.3', 'gpt-6-luna'].includes(model)
            ? { id: model, provider: 'synthetic' }
            : null,
      create: async (workspacePath: string, title: string, model?: string) => {
        selectedModel = model ?? selectedModel;
        const status = workspacePath === '/focus/repo' ? 'pending_worktree_choice' : 'active';
        db.prepare(
          `INSERT INTO sessions (id, title, workspace_path, status, last_active_at, type)
            VALUES ('new', ?, ?, ?, '2026-10-04T12:00:00.000Z', 'worker')`
        ).run(title, workspacePath, status);
        events.push(`create ${workspacePath}${model ? ` on ${model}` : ''}`);
        return 'new';
      },
      model: (sessionId: string) => (sessionId === 'new' ? selectedModel : null),
      chooseWorktree: async (sessionId: string) => {
        db.exec(`UPDATE sessions SET status = 'active' WHERE id = '${sessionId}'`);
        events.push(`worktree ${sessionId}`);
      },
      announce: (sessionId: string) => {
        events.push(`announce ${sessionId}`);
      },
      interrupt: (sessionId: string) => {
        events.push(`interrupt ${sessionId}`);
        return true;
      },
      archive: async (ref: { id: string }, admit: ArchiveAdmission) => {
        const refused = admit();
        if (refused) return refused;
        db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(ref.id);
        events.push(`archive ${ref.id}`);
        return { ok: true as const, value: { archived: true } };
      },
    },
    neoFolder: () => '/data/Neo',
    folderExists: (folder: string) => folder !== '/focus/missing',
    makeFolder: () => {},
    homeDir: '/Users/test',
  };
}

describe('hyperneo adapter send and status', () => {
  let db: Database;
  let handed: Array<{
    sessionId: string;
    message: string;
    from: string;
    messageUuid: string;
    deliveryMode?: string;
  }>;
  let outcome: MailboxHandoffOutcome;
  let events: string[];

  beforeEach(() => {
    handed = [];
    events = [];
    outcome = { kind: 'enqueued', id: 'mb1' };
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, main_repo_path TEXT,
      status TEXT, last_active_at TEXT, processing_state TEXT, type TEXT, space_id TEXT, room_id TEXT,
      worktree_branch TEXT, git_branch TEXT, worktree_path TEXT)`);
    db.exec(`CREATE TABLE sdk_messages (session_id TEXT, message_type TEXT, sdk_message TEXT,
      timestamp TEXT, parent_tool_use_id TEXT, send_status TEXT)`);
    const session =
      db.prepare(`INSERT INTO sessions (id, title, workspace_path, status, last_active_at,
      processing_state, type, space_id) VALUES (?, ?, '/focus/dolmen', ?, '2026-10-04T10:00:00.000Z', ?, 'worker', ?)`);
    session.run('idle', 'loader', 'active', '{"status":"idle"}', null);
    session.run('busy', 'parser', 'active', '{"status":"processing"}', null);
    session.run('gone', 'old', 'archived', null, null);
    session.run('space', 'space work', 'active', null, 'sp1');
    const result = db.prepare(
      `INSERT INTO sdk_messages (session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
        VALUES (?, 'result', ?, ?, ?)`
    );
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
      'idle',
      '{"result":"Compacted.","internal_compaction_turn":1}',
      '2026-10-04T12:00:00.000Z',
      null
    );
    result.run(
      'busy',
      '{"result":"API Error: 401","is_error":true}',
      '2026-10-04T10:00:00.000Z',
      null
    );
  });

  afterEach(() => db.close());

  function adapter(
    prepareExecution?: WorkExecutionPreparer,
    withdraw?: HyperneoSessionControl['withdraw']
  ) {
    fillSdkMessageFixtureColumns(db);
    return createHyperneoAdapter({
      prepareExecution,
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      handoff: async (sessionId, message, from, messageUuid, deliveryMode) => {
        handed.push({
          sessionId,
          message,
          from,
          messageUuid,
          ...(deliveryMode ? { deliveryMode } : {}),
        });
        return outcome;
      },
      ...control(db, events, withdraw),
    });
  }

  const ref = (id: string) => ({ adapter: 'hyperneo', id });

  test('withdraw is advertised only when an owned controller is available', async () => {
    expect(adapter().capabilities).not.toContain('withdraw');
    expect(adapter().withdraw).toBeUndefined();
    const seen: string[][] = [];
    const driver = adapter(undefined, async (...args) => {
      seen.push(args);
      return { ok: true, value: { queuedSubmissionId: args[1], withdrawn: true } };
    });
    expect(driver.capabilities).toContain('withdraw');
    expect(
      await driver.withdraw!(ref('busy'), 'mailbox-entry', {
        from: 'session:sender',
        caller: { source: 'internal' },
      })
    ).toEqual({ ok: true, value: { queuedSubmissionId: 'mailbox-entry', withdrawn: true } });
    expect(seen).toEqual([['busy', 'mailbox-entry', 'session:sender']]);
  });

  test.each(['space', 'missing'])('withdraw never reaches a controller for %s', async (id) => {
    const driver = adapter(undefined, async () => {
      throw new Error('must not run');
    });
    expect(
      await driver.withdraw!(ref(id), 'mailbox-entry', {
        from: 'session:sender',
        caller: { source: 'internal' },
      })
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test.each(['idle', 'busy'])(
    'queue defers the input with its receipt for an owned %s session',
    async (id) => {
      const driver = adapter();
      expect(driver.capabilities).toContain('queue');
      const result = await driver.queue!(ref(id), 'after this turn', {
        from: 'session:sender',
        caller: { source: 'internal' },
      });
      expect(result).toEqual({
        ok: true,
        value: {
          delivered: false,
          queuedSubmissionId: 'mb1',
          receipt: { executionId: id, inputId: handed[0].messageUuid },
        },
      });
      expect(handed).toEqual([
        {
          sessionId: id,
          message: `after this turn\n\nReply with ${sessionReplyCall('sender')}, not SendMessage.`,
          from: 'session:sender',
          messageUuid: expect.any(String),
          deliveryMode: 'defer',
        },
      ]);
    }
  );

  test.each(['gone', 'space', 'missing'])(
    'queue reuses session admission for %s without handoff',
    async (id) => {
      expect(
        await adapter().queue!(ref(id), 'queued', { from: 'user', caller: { source: 'rpc' } })
      ).toMatchObject({ ok: false });
      expect(handed).toEqual([]);
    }
  );

  test('queue does not return a submission receipt when mailbox admission fails', async () => {
    outcome = { kind: 'rejected', reason: 'mailbox unavailable' };
    expect(
      await adapter().queue!(ref('idle'), 'queued', { from: 'user', caller: { source: 'rpc' } })
    ).toEqual({ ok: false, reason: 'not_delivered', detail: 'mailbox unavailable' });
  });

  test('creates the native session without scanning unrelated protected temp directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hyperneo-sandbox-'));
    const directory = join(root, 'prepared');
    const unrelated = mkdtempSync(join(tmpdir(), 'hyperneo-unrelated-'));
    chmodSync(unrelated, 0);
    mkdirSync(join(directory, '.git/info'), { recursive: true });
    let released = false;
    try {
      const driver = adapter(async () => ({
        ok: true,
        value: {
          directory,
          release: async () => {
            released = true;
          },
        },
      }));
      expect(
        await driver.start!(
          {
            place: { machine: 'imac', folder: '/focus/repo', name: 'repo' },
            title: 't',
            message: 'm',
            preparation: { pack: 'coding', parameters: {} },
          },
          { from: 'user', caller: { source: 'rpc' } }
        )
      ).toMatchObject({ ok: true });
      expect(events).toEqual([`create ${directory}`, 'announce new']);
      expect(
        JSON.parse(readFileSync(join(directory, '.claude/settings.local.json'), 'utf8')).sandbox
          .enabled
      ).toBe(true);
      expect(handed).toHaveLength(1);
      expect(released).toBe(false);
    } finally {
      chmodSync(unrelated, 0o700);
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failed preparation creates no native session or handoff', async () => {
    const driver = adapter(async () => ({
      ok: false,
      reason: 'preparation_failed',
      detail: 'fetch failed',
    }));
    expect(
      await driver.start!(
        {
          place: { machine: 'imac', folder: '/focus/repo', name: 'repo' },
          title: 't',
          message: 'm',
          preparation: { pack: 'coding', parameters: {} },
        },
        { from: 'user', caller: { source: 'rpc' } }
      )
    ).toMatchObject({ ok: false, reason: 'preparation_failed' });
    expect(events).toEqual([]);
    expect(handed).toEqual([]);
  });

  test('archives an idle session but rejects live turns and owned Space sessions', async () => {
    const driver = adapter();
    expect(await driver.archive!(ref('idle'), () => null)).toMatchObject({ ok: true });
    expect(await driver.status!(ref('idle'))).toMatchObject({ value: { status: 'stopped' } });
    expect(await driver.archive!(ref('busy'), () => null)).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(await driver.archive!(ref('space'), () => null)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(events).toEqual(['archive idle']);
  });

  test('checks admission again immediately before the lifecycle effect', async () => {
    let admitted = 0;
    expect(
      await adapter().archive!(ref('idle'), () =>
        ++admitted === 1 ? null : { ok: false, reason: 'busy', detail: 'new' }
      )
    ).toMatchObject({ ok: false, reason: 'busy' });
    expect(events).toEqual([]);
    expect(await adapter().status!(ref('idle'))).toMatchObject({ value: { status: 'done' } });
  });
  const from = { from: 'session:neo:root', caller: { source: 'rpc' as const } };

  test('status returns the session with its last top-level reply and when it came', async () => {
    expect(await adapter().status?.(ref('idle'))).toEqual({
      ok: true,
      value: {
        ref: ref('idle'),
        title: 'loader',
        execution: { directory: '/focus/dolmen', machine: 'imac' },
        place: { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' },
        status: 'done',
        lastActivityAt: Date.parse('2026-10-04T10:00:00.000Z'),
        link: '/session/idle',
        lastReply: 'loader is fixed',
        lastReplyAt: Date.parse('2026-10-04T10:00:00.000Z'),
        recentInputs: [],
      },
    });
  });

  describe('persisted exchange evidence', () => {
    const base = Date.parse('2026-10-04T08:00:00.000Z');
    const write = (
      at: number,
      type: string,
      payload: unknown,
      extra: { parent?: string; sent?: string } = {}
    ) =>
      db
        .prepare(`INSERT INTO sdk_messages (session_id, message_type, sdk_message, timestamp, parent_tool_use_id, send_status)
        VALUES ('idle', ?, ?, ?, ?, ?)`)
        .run(
          type,
          JSON.stringify(payload),
          new Date(base + at).toISOString(),
          extra.parent ?? null,
          extra.sent ?? 'consumed'
        );
    const input = (text: unknown, inputKind = 'human') => ({
      message: { content: text },
      inputKind,
    });
    const settle = (value: unknown) =>
      readDriverSettlement(
        { updatedAt: base },
        { kind: 'completed', value },
        base + 100,
        base + 1,
        true,
        'Fix parser'
      );
    beforeEach(() => {
      db.prepare("DELETE FROM sdk_messages WHERE session_id = 'idle'").run();
    });

    test('real adapter evidence isolates the card reply from PR events and human inputs', async () => {
      write(1, 'user', input('Fix parser', 'task'));
      write(2, 'result', { result: 'Parser fixed' });
      write(3, 'user', input('PR event for another card', 'system'));
      write(4, 'result', { result: 'Other PR reviewed' });
      write(5, 'user', input('New human ask'));
      write(6, 'result', { result: 'Human answer' });
      const detail = await adapter().status!(ref('idle'), base);
      expect(detail).toMatchObject({
        value: {
          exchange: [
            { at: base + 1, role: 'user', text: 'Fix parser' },
            { at: base + 2, role: 'agent', text: 'Parser fixed' },
            { at: base + 3, role: 'user', text: 'PR event for another card' },
            { at: base + 4, role: 'agent', text: 'Other PR reviewed' },
            { at: base + 5, role: 'user', text: 'New human ask' },
            { at: base + 6, role: 'agent', text: 'Human answer' },
          ],
        },
      });
      expect(settle(detail)).toBeNull();
      expect(settle(await adapter().status!(ref('idle'), base + 1))).toBeNull();
    });

    test('excludes queued, tool, subagent and compaction rows but retains non-text boundaries', async () => {
      write(1, 'user', input('Fix parser'));
      write(2, 'user', input('Queued ask'), { sent: 'enqueued' });
      write(3, 'user', input([{ type: 'tool_result', content: 'tool output' }]));
      write(4, 'user', input('Nested ask'), { parent: 'tool' });
      write(5, 'result', { result: 'Nested answer' }, { parent: 'tool' });
      write(6, 'result', { result: 'Compacted', internal_compaction_turn: 1 });
      write(7, 'assistant', { message: { content: 'Intermediate text' } });
      write(8, 'result', { result: 'Parser fixed' });
      write(9, 'user', input([{ type: 'image', source: {} }]));
      write(10, 'result', { result: 'Image answer' });
      const detail = await adapter().status!(ref('idle'), base);
      expect(detail).toMatchObject({
        value: {
          exchange: [
            { at: base + 1, role: 'user', text: 'Fix parser' },
            { at: base + 8, role: 'agent', text: 'Parser fixed' },
            { at: base + 9, role: 'user', text: '[Non-text input]' },
            { at: base + 10, role: 'agent', text: 'Image answer' },
          ],
        },
      });
      expect(settle(detail)).toBeNull();
    });

    test('bounds history and text, reporting truncation instead of inventing an anchor', async () => {
      write(1, 'user', input('Fix parser'));
      for (let at = 2; at <= 45; at++) write(at, 'result', { result: 'x'.repeat(5_000) });
      const detail = await adapter().status!(ref('idle'), base);
      expect(detail.ok).toBe(true);
      if (!detail.ok) throw new Error(detail.reason);
      expect(detail.value.exchangeCut).toBe(true);
      expect(detail.value.exchange).toHaveLength(40);
      expect(detail.value.exchange?.[0]).toEqual({
        at: base + 6,
        role: 'agent',
        text: 'x'.repeat(4_000),
      });
      expect(detail.value.exchange?.at(-1)?.at).toBe(base + 45);
      expect(settle(detail)).toBeNull();
    });

    test('empty history is explicit and equal timestamps retain storage order', async () => {
      expect(await adapter().status!(ref('idle'), base)).toMatchObject({ value: { exchange: [] } });
      write(1, 'user', input('Fix parser'));
      write(1, 'result', { result: '   ' });
      write(1, 'user', input('   ', 'system'));
      const detail = await adapter().status!(ref('idle'), base);
      expect(detail).toMatchObject({
        value: {
          exchange: [
            { at: base + 1, role: 'user', text: 'Fix parser' },
            { at: base + 1, role: 'agent', text: '[No written result]' },
            { at: base + 1, role: 'user', text: '[Non-text input]' },
          ],
        },
      });
    });
  });

  test('status reports the inputs that reached the session, from its own messages', async () => {
    const input = db.prepare(
      `INSERT INTO sdk_messages (session_id, message_type, sdk_message, timestamp, send_status)
        VALUES ('busy', 'user', ?, ?, ?)`
    );
    const user = (content: unknown, inputKind?: string) =>
      JSON.stringify({ type: 'user', ...(inputKind && { inputKind }), message: { content } });
    input.run(user('Fix the parser', 'task'), '2026-10-04T10:01:00.000Z', 'consumed');
    input.run(user([{ type: 'tool_result', content: 'ok' }]), '2026-10-04T10:02:00.000Z', null);
    input.run(user('Done check for w1', 'system'), '2026-10-04T10:03:00.000Z', 'consumed');
    input.run(
      user([{ type: 'text', text: 'Also add tests', human: true }], 'human'),
      '2026-10-04T10:04:00.000Z',
      null
    );
    input.run(user('Still queued'), '2026-10-04T10:05:00.000Z', 'enqueued');
    db.prepare(
      `INSERT INTO sdk_messages (session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
        VALUES ('busy', 'user', ?, '2026-10-04T10:06:00.000Z', 'tool-1')`
    ).run(user('Subagent: read the parser'));
    const at = (iso: string) => Date.parse(iso);

    expect(await adapter().status?.(ref('busy'))).toMatchObject({
      value: {
        recentInputs: [
          { at: at('2026-10-04T10:01:00.000Z'), text: 'Fix the parser', human: false },
          { at: at('2026-10-04T10:04:00.000Z'), text: 'Also add tests', human: true },
        ],
      },
    });
    expect(await adapter().status?.(ref('busy'), at('2026-10-04T10:02:00.000Z'))).toMatchObject({
      value: {
        recentInputs: [{ at: at('2026-10-04T10:04:00.000Z'), text: 'Also add tests', human: true }],
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

  test('a turn a restart cut off reads queued, a user stop reads stopped', async () => {
    db.exec(
      `UPDATE sessions SET processing_state = '{"status":"interrupted","reason":"restart","messageId":"m1"}' WHERE id = 'busy'`
    );
    expect(await adapter().status?.(ref('busy'))).toMatchObject({
      ok: true,
      value: { status: 'queued' },
    });
    db.exec(`UPDATE sessions SET processing_state = '{"status":"interrupted"}' WHERE id = 'busy'`);
    expect(await adapter().status?.(ref('busy'))).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
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

  test('a sender on another daemon gets its full address as the reply target', async () => {
    await adapter().send?.(ref('idle'), 'go on', {
      from: 'daemon:imac::session:neo-root',
      caller: { source: 'rpc' },
    });
    expect(handed[0].message).toBe(
      `go on\n\nReply with ${sessionReplyCall('daemon:imac::session:neo-root')}, not SendMessage.`
    );
  });

  test('send hands the message to the mailbox with the caller as origin', async () => {
    const idle = await adapter().send?.(ref('idle'), 'go on', from);
    const busy = await adapter().send?.(ref('busy'), 'next', from);
    expect(handed).toEqual([
      {
        sessionId: 'idle',
        message: `go on\n\nReply with ${sessionReplyCall('neo:root')}, not SendMessage.`,
        from: 'session:neo:root',
        messageUuid: expect.any(String),
      },
      {
        sessionId: 'busy',
        message: `next\n\nReply with ${sessionReplyCall('neo:root')}, not SendMessage.`,
        from: 'session:neo:root',
        messageUuid: expect.any(String),
      },
    ]);
    expect(handed[0].messageUuid).not.toBe(handed[1].messageUuid);
    expect(idle).toEqual({
      ok: true,
      value: { delivered: true, receipt: { executionId: 'idle', inputId: handed[0].messageUuid } },
    });
    expect(busy).toEqual({
      ok: true,
      value: { delivered: false, receipt: { executionId: 'busy', inputId: handed[1].messageUuid } },
    });
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

describe('hyperneo adapter start and stop', () => {
  let db: Database;
  let events: string[];
  let handed: string[];
  let uuids: string[];

  beforeEach(() => {
    events = [];
    handed = [];
    uuids = [];
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, main_repo_path TEXT,
      status TEXT, last_active_at TEXT, processing_state TEXT, type TEXT, space_id TEXT, room_id TEXT,
      worktree_branch TEXT, git_branch TEXT, worktree_path TEXT)`);
    db.exec(`INSERT INTO sessions (id, title, workspace_path, status, last_active_at, processing_state, type)
      VALUES ('busy', 'parser', '/focus/dolmen', 'active', '2026-10-04T10:00:00.000Z', '{"status":"processing"}', 'worker'),
             ('idle', 'loader', '/focus/dolmen', 'active', '2026-10-04T10:00:00.000Z', '{"status":"idle"}', 'worker')`);
  });

  afterEach(() => db.close());

  function adapter(overrides: Partial<HyperneoSessionControl> = {}) {
    const controls = control(db, events);
    return createHyperneoAdapter({
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      handoff: async (sessionId, message, _from, messageUuid) => {
        handed.push(`${sessionId}: ${message}`);
        uuids.push(messageUuid);
        return { kind: 'enqueued', id: 'mb1' };
      },
      ...controls,
      sessions: { ...controls.sessions, ...overrides },
    });
  }

  const from = { from: 'session:neo%3Aroot', caller: { source: 'rpc' as const } };
  const place = (folder?: string) => ({
    machine: 'imac',
    name: 'x',
    ...(folder ? { folder } : {}),
  });

  test('start opens a session in a git folder on its own worktree and sends the message', async () => {
    const result = await adapter().start?.(
      { place: place('/focus/repo'), title: 'font size', message: 'make it larger' },
      from
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        ref: { adapter: 'hyperneo', id: 'new' },
        title: 'font size',
        status: 'queued',
        model: 'gpt-6-luna',
      },
    });
    expect(events).toEqual(['create /focus/repo', 'worktree new', 'announce new']);
    expect(handed).toEqual([
      `new: make it larger\n\nReply with ${sessionReplyCall('neo:root')}, not SendMessage.`,
    ]);
    expect(result).toMatchObject({
      value: { receipt: { executionId: 'new', inputId: uuids[0] } },
    });
  });

  test('start opens the session on the model Neo picked', async () => {
    const result = await adapter().start?.(
      { place: place('/focus/notes'), title: 'essay', message: 'write it', model: 'GLM 5.3' },
      from
    );
    expect(events[0]).toBe('create /focus/notes on glm-5.3');
    expect(result).toMatchObject({ ok: true, value: { model: 'glm-5.3' } });
    expect(handed).toEqual([
      `new: write it\n\nReply with ${sessionReplyCall('neo:root')}, not SendMessage.`,
    ]);
  });

  test('starts HyperNeo work with the requested effort applied before delivery', async () => {
    const result = await adapter({ effort: () => 'high' }).start!(
      { place: place('/focus/notes'), title: 'task', message: 'write it', effort: 'high' },
      from
    );
    expect(result).toMatchObject({ ok: true, value: { effort: 'high' } });
    expect(handed).toHaveLength(1);
  });

  test.each([
    [' high ', 'high'],
    ['extra  high', 'extra high'],
    [' THINK24K ', 'high'],
  ])('normalizes effort %s before applying it', async (effort, confirmed) => {
    const result = await adapter({ effort: () => confirmed }).start!(
      { place: place('/focus/notes'), title: 'task', message: 'write it', effort },
      from
    );
    expect(result).toMatchObject({ ok: true, value: { effort: confirmed } });
    expect(handed).toHaveLength(1);
  });

  test('keeps input unsent when the session does not confirm the requested effort', async () => {
    const result = await adapter({ effort: () => 'low' }).start!(
      { place: place('/focus/notes'), title: 'task', message: 'write it', effort: 'high' },
      from
    );
    expect(result).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(handed).toEqual([]);
  });

  test.each([{ model: 'unavailable' }, { effort: 'unknown' }])(
    'refuses unsupported configuration before creating a session: %j',
    async (configuration) => {
      expect(
        await adapter().start!(
          { place: place('/focus/notes'), title: 'essay', message: 'write it', ...configuration },
          from
        )
      ).toMatchObject({
        ok: false,
        reason: 'model' in configuration ? 'unsupported_model' : 'unsupported_effort',
      });
      expect(events).toEqual([]);
      expect(handed).toEqual([]);
    }
  );

  test.each(['gpt-6-luna', null])(
    'keeps the first message unsent for observed model %s',
    async (model) => {
      const result = await adapter({ model: () => model }).start!(
        { place: place('/focus/notes'), title: 'essay', message: 'write it', model: 'glm-5.3' },
        from
      );
      expect(result).toMatchObject({ ok: false, reason: 'not_delivered' });
      expect(handed).toEqual([]);
      expect(events).toContain('create /focus/notes on glm-5.3');
    }
  );

  test('reports a model that becomes unavailable during creation as a typed refusal', async () => {
    const result = await adapter({
      create: async () => {
        throw new ModelUnavailableError('Model became unavailable.');
      },
    }).start!(
      { place: place('/focus/notes'), title: 'essay', message: 'write it', model: 'glm-5.3' },
      from
    );
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_model' });
    expect(handed).toEqual([]);
  });

  test('start refuses work with no folder instead of using the Neo folder', async () => {
    expect(
      await adapter().start?.({ place: place(), title: 'essay', message: 'write it' }, from)
    ).toMatchObject({ ok: false, reason: 'invalid_place' });
    expect(events).toEqual([]);
  });

  test('start refuses a Space, another machine or a missing folder', async () => {
    const start = (request: { place: Record<string, string> }) =>
      adapter().start?.({ title: 't', message: 'm', ...request } as never, from);
    expect(await start({ place: { machine: 'imac', name: 's', spaceId: 'sp1' } })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(
      await start({ place: { machine: 'laptop', name: 'd', folder: '/focus/d' } })
    ).toMatchObject({ ok: false, reason: 'invalid_place' });
    expect(await start({ place: place('/focus/missing') })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(events).toEqual([]);
  });

  test('stop interrupts a session waiting out a rate limit', async () => {
    db.exec(
      `UPDATE sessions SET processing_state = '{"status":"rate_limit_cooldown"}' WHERE id = 'idle'`
    );
    expect(await adapter().stop?.({ adapter: 'hyperneo', id: 'idle' }, from)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(events).toEqual(['interrupt idle']);
  });

  test('stop interrupts a running session and leaves an idle one alone', async () => {
    expect(await adapter().stop?.({ adapter: 'hyperneo', id: 'busy' }, from)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await adapter().stop?.({ adapter: 'hyperneo', id: 'idle' }, from)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(events).toEqual(['interrupt busy']);
  });

  test('stop waits for an asynchronous interruption result', async () => {
    let finish: (stopped: boolean) => void = () => {};
    const interrupted = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    const stopping = adapter({ interrupt: () => interrupted }).stop!(
      { adapter: 'hyperneo', id: 'busy' },
      from
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(false);
    expect(await stopping).toEqual({ ok: true, value: { stopped: false } });
  });

  test('stop preserves interruption errors instead of reporting success', async () => {
    const driver = adapter({
      interrupt: async () => {
        throw new Error('SDK interrupt failed');
      },
    });
    await expect(driver.stop!({ adapter: 'hyperneo', id: 'busy' }, from)).rejects.toThrow(
      'SDK interrupt failed'
    );
  });
});
