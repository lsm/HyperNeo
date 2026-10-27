import { readHyperneoTurnEnds } from '../../../../src/storage/hyperneo-turn-ends-read.ts';
import { runMigration418 } from '../../../../src/storage/schema/m418-sdk-message-bodies';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { spaceTaskControl } from '../../../../src/lib/rpc-handlers/family-operations/drivers';
import { readDriverFollowUp, readDriverSettlement } from '../../../../src/lib/neo/driver-work';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createSpaceAdapter,
  spaceTaskCaller,
  taskOperationRejection,
} from '../../../../src/lib/drivers/space-adapter';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readSessionInputEvidence } from '../../../../src/lib/drivers/space-input-evidence';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns';

describe('taskOperationRejection', () => {
  test('reads a task or an accepted job as success and anything else as a reason', () => {
    expect(taskOperationRejection({ id: 't1', status: 'cancelled' })).toBeNull();
    expect(taskOperationRejection({ accepted: true, jobId: null })).toBeNull();
    expect(taskOperationRejection('invalid_transition')).toBe('invalid_transition');
    expect(taskOperationRejection({ accepted: false, reason: 'busy', detail: 'run active' })).toBe(
      'busy: run active'
    );
    expect(taskOperationRejection(null)).toBe('No task came back.');
  });
});

describe('spaceTaskCaller', () => {
  test('lets Neo act on any Space and keeps every other agent in its own Space', () => {
    expect(spaceTaskCaller({ source: 'mcp', sessionId: 'neo:root', role: 'neo' })).toEqual({
      source: 'internal',
      sessionId: 'neo:root',
      role: 'neo',
    });
    const worker = { source: 'mcp' as const, sessionId: 'w1', role: 'workflow_worker' as const };
    expect(spaceTaskCaller(worker)).toBe(worker);
    expect(spaceTaskCaller({ source: 'rpc' })).toEqual({ source: 'rpc' });
  });
});

describe('space adapter start, status and stop', () => {
  let db: Database;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    db = new Database(':memory:');
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)`);
    db.exec(`CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER,
      title TEXT, status TEXT, updated_at INTEGER, result TEXT, reported_summary TEXT, block_reason TEXT, completed_at INTEGER)`);
    db.exec(`CREATE TABLE sdk_messages (session_id TEXT, task_id TEXT, sdk_uuid TEXT,
      message_type TEXT, sdk_message TEXT, timestamp TEXT, parent_tool_use_id TEXT)`);
    db.exec(`INSERT INTO spaces VALUES ('sp1', 'dev-neokai')`);
    db.exec(`INSERT INTO space_tasks (id, space_id, task_number, title, status, updated_at, result, reported_summary, block_reason) VALUES
      ('t1', 'sp1', 7, 'font size', 'blocked', 10, NULL, NULL, 'human_input_requested'),
      ('t2', 'sp1', 8, 'shipped', 'done', 20, 'Merged in #5600', NULL, NULL)`);
  });

  afterEach(() => db.close());

  function adapter(refuse?: string) {
    fillSdkMessageFixtureColumns(db);
    return createSpaceAdapter({
      readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      tasks: {
        create: async (spaceId, title, description, caller) => {
          calls.push(`create ${spaceId} ${title}: ${description} as ${caller.source}`);
          if (refuse) return { reason: refuse };
          db.exec(
            `INSERT INTO space_tasks (id, space_id, task_number, title, status, updated_at, result, reported_summary, block_reason) VALUES ('t3', '${spaceId}', 9, '${title}', 'open', 30, NULL, NULL, NULL)`
          );
          return { taskId: 't3' };
        },
        cancel: async (taskId, caller) => {
          calls.push(`cancel ${taskId} as ${caller.source}`);
          return refuse ? { reason: refuse } : { cancelled: true };
        },
        message: async () => ({ reason: 'unused' }),
        messageAgent: async () => ({ reason: 'unused' }),
      },
    });
  }

  const ref = (id: string) => ({ adapter: 'space', id });
  const rpc = { source: 'rpc' as const };
  const space = { machine: 'imac', spaceId: 'sp1', name: 'dev-neokai' };

  test('status names the first input of a task as its start receipt once it has one', async () => {
    const status = async () => {
      const result = await adapter().status!(ref('t1'));
      if (!result.ok) throw new Error(result.detail);
      return result.value;
    };
    expect('startReceipt' in (await status())).toBe(false);
    const write = db.prepare(
      'INSERT INTO sdk_messages (session_id,task_id,sdk_uuid,message_type,sdk_message,timestamp,parent_tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
    write.run(
      's-code',
      't1',
      'replay',
      'user',
      JSON.stringify({ type: 'user', isReplay: true }),
      '2026-10-14T09:00:00.000Z',
      null
    );
    write.run('s-code', 't1', 'tool', 'user', user('x'), '2026-10-14T09:00:01.000Z', 'call-1');
    write.run(
      's-code',
      't1',
      'kickoff',
      'user',
      user('font size'),
      '2026-10-14T09:00:02.000Z',
      null
    );
    write.run(
      's-review',
      't1',
      'later',
      'user',
      user('review it'),
      '2026-10-14T09:05:00.000Z',
      null
    );
    write.run(
      's-other',
      't2',
      'other',
      'user',
      user('other task'),
      '2026-10-14T08:00:00.000Z',
      null
    );
    expect((await status()).startReceipt).toEqual({ executionId: 's-code', inputId: 'kickoff' });
  });

  test('start creates a task in the Space with the message as its description', async () => {
    expect(
      await adapter().start?.(
        { place: space, title: 'bigger font', message: 'raise it to 16px' },
        { from: 'chat', caller: rpc }
      )
    ).toEqual({
      ok: true,
      value: {
        ref: ref('t3'),
        title: '#9 bigger font',
        place: space,
        status: 'queued',
        lastActivityAt: 30,
        link: '/space/sp1/task/t3',
      },
    });
    expect(calls).toEqual(['create sp1 bigger font: raise it to 16px as rpc']);
  });

  test.each([
    [{ model: 'sonnet' }, 'unsupported_model'],
    [{ effort: 'medium' }, 'unsupported_effort'],
    [{ model: 'sonnet', effort: 'medium' }, 'unsupported_model'],
  ] as const)('refuses configuration %j without creating a task', async (configuration, reason) => {
    expect(
      await adapter().start?.(
        { place: space, title: 'bigger font', message: 'raise it to 16px', ...configuration },
        { from: 'chat', caller: rpc }
      )
    ).toMatchObject({ ok: false, reason });
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT id FROM space_tasks ORDER BY id').all()).toEqual([
      { id: 't1' },
      { id: 't2' },
    ]);
  });

  test('start needs a Space on this machine and passes a refusal through', async () => {
    const start = (place: Record<string, string>, refuse?: string) =>
      adapter(refuse).start?.(
        { place: place as never, title: 't', message: 'm' },
        { from: 'chat', caller: rpc }
      );
    expect(await start({ machine: 'imac', name: 'x', folder: '/x' })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(await start({ ...space, machine: 'laptop' })).toMatchObject({ reason: 'invalid_place' });
    expect(await start(space, 'Space is archived')).toEqual({
      ok: false,
      reason: 'invalid_place',
      detail: 'Space is archived',
    });
  });

  test('status reports the task with its result or block reason', async () => {
    expect(await adapter().status?.(ref('t1'))).toMatchObject({
      ok: true,
      value: { status: 'needs_you', lastReply: 'human_input_requested' },
    });
    expect(await adapter().status?.(ref('t2'))).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'Merged in #5600' },
    });
    expect(await adapter().status?.(ref('nope'))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('metadata edits do not make an old completion a fresh reply', async () => {
    db.exec(
      "UPDATE space_tasks SET completed_at = 20, title = 'renamed', updated_at = 40 WHERE id = 't2'"
    );
    const outcome = { kind: 'completed' as const, value: await adapter().status!(ref('t2')) };
    expect(outcome.value).toMatchObject({
      value: { lastActivityAt: 40, lastReplyAt: 20, lastReply: 'Merged in #5600' },
    });
    expect(readDriverSettlement({ updatedAt: 30 }, outcome, 50, 30, true, 'new ask')).toBeNull();
    expect(readDriverFollowUp(outcome, 30)).toBeNull();
    expect(
      readDriverSettlement({ updatedAt: 10 }, outcome, 50, 10, true, 'original ask')
    ).toBeNull();
    db.exec(
      "UPDATE space_tasks SET completed_at = 60, updated_at = 60, result = 'New completion' WHERE id = 't2'"
    );
    const next = { kind: 'completed' as const, value: await adapter().status!(ref('t2')) };
    expect(readDriverFollowUp(next, 40)).toBeNull();
    expect(readDriverSettlement({ updatedAt: 40 }, next, 70, 40, true, 'new ask')).toBeNull();
  });

  test('missing completion metadata is not replaced by the task activity time', async () => {
    const result = await adapter().status!(ref('t2'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.lastReply).toBe('Merged in #5600');
    expect(result.value.lastReplyAt).toBeUndefined();
    expect(result.value.exchange).toBeUndefined();
  });

  test('stop leaves a draft alone because it never started', async () => {
    db.exec(
      `INSERT INTO space_tasks (id, space_id, task_number, title, status, updated_at, result, reported_summary, block_reason) VALUES ('t4', 'sp1', 10, 'idea', 'draft', 40, NULL, NULL, NULL)`
    );
    expect(await adapter().stop?.(ref('t4'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(calls).toEqual([]);
  });

  test('stop cancels open tasks and leaves finished ones alone', async () => {
    expect(await adapter().stop?.(ref('t1'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await adapter().stop?.(ref('t2'), { from: 'chat', caller: rpc })).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(
      await adapter('invalid_transition').stop?.(ref('t1'), { from: 'chat', caller: rpc })
    ).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'invalid_transition',
    });
    expect(calls).toEqual(['cancel t1 as rpc', 'cancel t1 as rpc']);
  });
});

describe('space adapter send', () => {
  let db: Database;
  let sent: string[];

  beforeEach(() => {
    sent = [];
    db = new Database(':memory:');
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)`);
    db.exec(`CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER,
      title TEXT, status TEXT, updated_at INTEGER, result TEXT, reported_summary TEXT,
      block_reason TEXT, workflow_run_id TEXT, completed_at INTEGER)`);
    db.exec(`CREATE TABLE node_executions (id TEXT PRIMARY KEY, workflow_run_id TEXT, agent_name TEXT,
      workflow_node_id TEXT, agent_session_id TEXT, status TEXT, last_activity_at INTEGER,
      updated_at INTEGER)`);
    db.exec(`INSERT INTO spaces VALUES ('sp1', 'dev-neokai')`);
    db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, space_id TEXT,
      handle TEXT, display_name TEXT, status TEXT, session_id TEXT, updated_at INTEGER)`);
    db.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, processing_state TEXT, last_active_at TEXT)`
    );
    db.exec(`INSERT INTO sessions VALUES ('s1', '{"status":"processing"}', NULL)`);
    db.exec(`INSERT INTO space_long_horizon_agents VALUES
      ('a1', 'sp1', 'ui-ux', 'Designer', 'active', 's1', 40),
      ('a2', 'sp1', 'docs', 'Writer', 'active', NULL, 30),
      ('a3', 'sp1', 'old', 'Retired', 'archived', NULL, 20)`);
    db.exec(`INSERT INTO space_tasks (id, space_id, task_number, title, status, updated_at, result, reported_summary, block_reason, workflow_run_id) VALUES
      ('t1', 'sp1', 7, 'font size', 'in_progress', 10, NULL, NULL, NULL, 'run-1'),
      ('t2', 'sp1', 8, 'shipped', 'done', 20, NULL, NULL, NULL, 'run-2'),
      ('t3', 'sp1', 9, 'idea', 'open', 30, NULL, NULL, NULL, NULL),
      ('t4', 'sp1', 10, 'paused', 'open', 40, NULL, NULL, NULL, 'run-4')`);
    db.exec(`INSERT INTO node_executions VALUES
      ('n1', 'run-1', 'coder', 'node-review', 's-review', 'cancelled', 50, 50),
      ('n2', 'run-1', 'coder', 'node-code', 's-code', 'in_progress', 40, 40),
      ('n3', 'run-4', 'coder', 'node-code', 's-old', 'cancelled', 60, 60),
      ('n4', 'run-4', 'reviewer', 'node-review', NULL, 'pending', 70, 70)`);
  });

  afterEach(() => db.close());

  function adapter() {
    fillSdkMessageFixtureColumns(db);
    return createSpaceAdapter({
      readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
      db: () => db,
      machine: 'imac',
      searchChats: async () => [],
      tasks: {
        create: async () => ({ reason: 'unused' }),
        cancel: async () => ({ reason: 'unused' }),
        message: async (taskId, node, message, fromHuman) => {
          sent.push(
            `${taskId} ${node.agentName}@${node.workflowNodeId} ${message} ${fromHuman ? 'from you' : 'from an agent'}`
          );
          return { delivered: !message.startsWith('later') };
        },
        messageAgent: async (agent, message, context) => {
          sent.push(`${agent.spaceId}/${agent.id} ${message} from ${context.from}`);
          return message === 'refuse' ? { reason: 'agent session is gone' } : { accepted: true };
        },
      },
    });
  }

  const ref = (id: string) => ({ adapter: 'space', id });
  const neo = {
    from: 'session:neo%3Aroot',
    caller: { source: 'mcp' as const, sessionId: 'neo:root', role: 'neo' as const },
  };

  describe('receipt-bound task evidence', () => {
    const receipt = { executionId: 's-code', inputId: 'own-input' };
    const write = (
      id: string,
      type: string,
      seq: number | null,
      text: string,
      session = 's-code',
      task = 't1'
    ) => {
      db.prepare(
        `INSERT INTO sdk_messages (session_id,task_id,sdk_uuid,message_type,sdk_message,timestamp,parent_tool_use_id,send_status,consumed_seq,is_terminal) VALUES (?, ?, ?, ?, ?, ?, NULL, 'consumed', ?, 1)`
      ).run(
        session,
        task,
        id,
        type,
        JSON.stringify(
          type === 'user'
            ? { type, message: { content: text }, inputKind: 'task' }
            : { type, result: text }
        ),
        new Date(1000).toISOString(),
        seq
      );
      fillSdkMessageFixtureColumns(db);
    };
    const read = async (id = 't1', input = receipt) => {
      const result = await adapter().status!(ref(id), undefined, input);
      if (!result.ok) throw new Error(result.detail);
      return result.value;
    };
    beforeEach(() => {
      db.exec(`CREATE TABLE sdk_messages (session_id TEXT, task_id TEXT, sdk_uuid TEXT,
        message_type TEXT, sdk_message TEXT, timestamp TEXT, parent_tool_use_id TEXT,
        send_status TEXT, consumed_seq INTEGER, is_terminal INTEGER)`);
      write('own-input', 'user', 10, 'Own task input');
      write('own-result', 'result', 11, 'Own task reply');
      write('event', 'user', 12, 'Unrelated PR event');
      write('event-result', 'result', 13, 'Other reply');
    });

    describe('readSessionInputEvidence', () => {
      test('reads a plain session input by its receipt, and only for that session', () => {
        const plain = { executionId: 's-plain', inputId: 'plain-input' };
        write('plain-input', 'user', 20, 'Raise the font', 's-plain', null as unknown as string);
        write('plain-result', 'result', 21, 'Raised it', 's-plain', null as unknown as string);
        expect(readSessionInputEvidence(db, 's-plain', plain)).toMatchObject({
          state: 'observed',
          exchange: [
            { role: 'user', text: 'Raise the font' },
            { role: 'agent', text: 'Raised it' },
          ],
        });
        expect(readSessionInputEvidence(db, 's-other', plain)).toEqual({
          receipt: plain,
          state: 'unavailable',
        });
        expect(readSessionInputEvidence(db, 's-code', receipt)).toEqual({
          receipt,
          state: 'unavailable',
        });
      });
    });

    test('uses consumed order despite equal timestamps and preserves the task aggregate separately', async () => {
      db.exec("UPDATE space_tasks SET result = 'Aggregate from multiple nodes' WHERE id = 't1'");
      expect(await read()).toMatchObject({
        lastReply: 'Aggregate from multiple nodes',
        inputEvidence: {
          receipt,
          state: 'observed',
          exchangeCut: false,
          exchange: [
            { at: 1000, role: 'user', text: 'Own task input' },
            { at: 1000, role: 'agent', text: 'Own task reply' },
          ],
        },
      });
      expect((await read()).exchange).toBeUndefined();
    });

    test('keeps persisted ownership after node/session/run replacement and completion', async () => {
      const original = (await read()).inputEvidence;
      db.exec(
        "UPDATE node_executions SET agent_session_id = 's-replacement', status = 'cancelled'"
      );
      db.exec(
        "UPDATE space_tasks SET workflow_run_id = 'new-run', status = 'done', completed_at = 2000 WHERE id = 't1'"
      );
      write('replacement-input', 'user', 14, 'Replacement input', 's-replacement');
      write('replacement-result', 'result', 15, 'Replacement reply', 's-replacement');
      expect((await read()).inputEvidence).toEqual(original);
      db.exec('DELETE FROM node_executions');
      expect((await read()).inputEvidence).toEqual(original);
    });

    test('rejects task, execution and message mismatches', async () => {
      expect((await read('t2')).inputEvidence).toEqual({ receipt, state: 'unavailable' });
      for (const wrong of [
        { ...receipt, executionId: 'foreign' },
        { ...receipt, inputId: 'missing' },
      ])
        expect((await read('t1', wrong)).inputEvidence).toEqual({
          receipt: wrong,
          state: 'unavailable',
        });
    });

    test.each(['deferred', 'enqueued', 'submitted'])(
      'reports %s input as pending without borrowing the latest result',
      async (status) => {
        db.prepare(
          "UPDATE sdk_messages SET send_status = ?, consumed_seq = NULL WHERE sdk_uuid = 'own-input'"
        ).run(status);
        expect((await read()).inputEvidence).toEqual({ receipt, state: 'pending' });
      }
    );

    test.each([
      "UPDATE sdk_messages SET consumed_seq = NULL WHERE sdk_uuid = 'own-input'",
      "UPDATE sdk_messages SET send_status = 'failed' WHERE sdk_uuid = 'own-input'",
      "UPDATE sdk_messages SET consumed_seq = 10 WHERE sdk_uuid = 'event'",
      "UPDATE sdk_messages SET consumed_seq = NULL WHERE sdk_uuid = 'event'",
      "UPDATE sdk_messages SET sdk_message = 'broken' WHERE sdk_uuid = 'own-input'",
      "UPDATE sdk_messages SET sdk_message = 'broken' WHERE sdk_uuid = 'own-result'",
      "UPDATE sdk_messages SET task_id = NULL WHERE sdk_uuid = 'own-input'",
      "INSERT INTO sdk_messages SELECT * FROM sdk_messages WHERE sdk_uuid = 'own-input'",
      "UPDATE sdk_messages SET parent_tool_use_id = 'tool' WHERE sdk_uuid = 'own-input'",
    ])('fails closed for ambiguous or missing evidence: %s', async (sql) => {
      db.exec(sql);
      expect((await read()).inputEvidence).toEqual({ receipt, state: 'unavailable' });
    });

    test('includes same-turn terminal evidence but excludes nested, compaction and intercepted results', async () => {
      db.exec("UPDATE sdk_messages SET consumed_seq = 10 WHERE sdk_uuid = 'own-result'");
      for (const [id, field] of [
        ['nested', 'nested'],
        ['compact', 'internal_compaction_turn'],
        ['recovery', 'recovery_intercepted'],
      ]) {
        write(id, 'result', 11, 'Must not appear');
        if (field === 'nested')
          db.prepare('UPDATE sdk_messages SET parent_tool_use_id = ? WHERE sdk_uuid = ?').run(
            'tool',
            id
          );
        else
          db.prepare('UPDATE sdk_messages SET sdk_message = ? WHERE sdk_uuid = ?').run(
            JSON.stringify({ result: 'Must not appear', [field]: true }),
            id
          );
      }
      const evidence = (await read()).inputEvidence;
      expect(evidence?.state).toBe('observed');
      if (evidence?.state !== 'observed') throw new Error('Missing observed evidence');
      expect(evidence.exchange.map((entry) => entry.text)).toEqual([
        'Own task input',
        'Own task reply',
      ]);
    });

    test('bounds replies while retaining the exact input anchor', async () => {
      db.exec("DELETE FROM sdk_messages WHERE sdk_uuid <> 'own-input'");
      for (let n = 0; n < 45; n++) write(`result-${n}`, 'result', 11 + n, 'x'.repeat(5000));
      const evidence = (await read()).inputEvidence;
      expect(evidence?.state).toBe('observed');
      if (evidence?.state !== 'observed') throw new Error('Missing observed evidence');
      expect(evidence.exchangeCut).toBe(true);
      expect(evidence.exchange).toHaveLength(40);
      expect(evidence.exchange[0].text).toBe('Own task input');
      expect(evidence.exchange[1].text).toHaveLength(4000);
    });
  });

  test('task aggregate never borrows a node exchange across replacement or completion', async () => {
    db.exec(`CREATE TABLE sdk_messages (session_id TEXT, message_type TEXT, sdk_message TEXT,
      timestamp TEXT, send_status TEXT, parent_tool_use_id TEXT, task_id TEXT, sdk_uuid TEXT)`);
    const at = Date.parse('2026-10-14T10:00:00.000Z');
    const insert = db.prepare(
      `INSERT INTO sdk_messages (session_id, message_type, sdk_message, timestamp, send_status,
        parent_tool_use_id) VALUES (?, ?, ?, ?, ?, NULL)`
    );
    for (const session of ['s-code', 's-review', 's-next']) {
      insert.run(
        session,
        'user',
        JSON.stringify({
          inputKind: 'human',
          message: { content: 'Build the report' },
        }),
        new Date(at + 1).toISOString(),
        'consumed'
      );
      insert.run(
        session,
        'result',
        JSON.stringify({ result: `Worker reply from ${session}` }),
        new Date(at + 2).toISOString(),
        null
      );
    }
    db.prepare(`UPDATE space_tasks SET status = 'done', result = 'Task artifact summary',
      completed_at = ?, updated_at = ? WHERE id = 't1'`).run(at + 10, at + 20);
    const assertTaskResult = async (hasCurrentNode: boolean) => {
      const result = await adapter().status!(ref('t1'), at);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.value.lastReply).toBe('Task artifact summary');
      expect(result.value.lastReplyAt).toBe(at + 10);
      expect(result.value.exchange).toBeUndefined();
      expect(result.value.recentInputs?.map((input) => input.text)).toEqual(
        hasCurrentNode ? ['Build the report'] : []
      );
      const outcome = { kind: 'completed' as const, value: result };
      expect(
        readDriverSettlement({ updatedAt: at }, outcome, at + 30, at + 1, true, 'Build the report')
      ).toBeNull();
      expect(readDriverFollowUp(outcome, at + 15)).toBeNull();
    };
    await assertTaskResult(true);
    db.exec("UPDATE node_executions SET status = 'cancelled' WHERE id = 'n2'");
    db.exec("UPDATE node_executions SET status = 'in_progress' WHERE id = 'n1'");
    await assertTaskResult(true);
    db.exec("UPDATE node_executions SET status = 'idle' WHERE id = 'n1'");
    await assertTaskResult(true);
    db.exec("UPDATE node_executions SET status = 'cancelled' WHERE id = 'n1'");
    await assertTaskResult(false);
    db.exec(`INSERT INTO node_executions VALUES
      ('n5', 'run-next', 'coder', 'node-code', 's-next', 'in_progress', 80, 80)`);
    db.exec("UPDATE space_tasks SET workflow_run_id = 'run-next' WHERE id = 't1'");
    await assertTaskResult(true);
  });

  test('status exposes typed human input for the Space agent after the refusal time', async () => {
    db.exec(`CREATE TABLE sdk_messages (session_id TEXT, message_type TEXT, sdk_message TEXT,
      timestamp TEXT, send_status TEXT, parent_tool_use_id TEXT)`);
    const insert = db.prepare(
      'INSERT INTO sdk_messages (session_id,message_type,sdk_message,timestamp,send_status,parent_tool_use_id) VALUES (?, ?, ?, ?, ?, NULL)'
    );
    for (const [kind, timestamp] of [
      ['task', '2026-10-13T10:00:00.000Z'],
      ['human', '2026-10-13T10:01:00.000Z'],
    ]) {
      insert.run(
        's1',
        'user',
        JSON.stringify({
          inputKind: kind,
          message: { content: [{ type: 'text', text: 'Continue' }] },
        }),
        timestamp,
        'consumed'
      );
    }
    const result = await adapter().status?.(
      ref('agent:a1'),
      Date.parse('2026-10-13T09:00:00.000Z')
    );
    expect(result).toMatchObject({
      ok: true,
      value: { recentInputs: [{ human: false }, { human: true }] },
    });
  });

  test.each(['consumed', 'deferred', 'missing', 'wrong-session', 'failed'])(
    'task send returns only persisted input receipts after session rebinding: %s',
    async (state) => {
      db.exec(`CREATE TABLE sdk_messages (session_id TEXT, sdk_uuid TEXT, message_type TEXT,
        sdk_message TEXT, timestamp TEXT, send_status TEXT)`);
      runMigration418(db);
      const repository = new SDKMessageRepository(db);
      const injections: unknown[] = [];
      const control = spaceTaskControl({
        deps: { db: { getSDKMessageRepo: () => repository } },
        spaceRuntimeService: {
          ensureToolTargetSession: async () => ({ kind: 'resolved', sessionId: 's-rebound' }),
        },
        taskAgentManager: {
          injectSubSessionMessage: async (
            sessionId: string,
            message: string,
            internal: boolean
          ) => {
            injections.push({ sessionId, message, internal });
            if (state === 'failed') throw new Error('injection refused');
            if (state !== 'missing')
              db.prepare(
                'INSERT INTO sdk_messages (session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status) VALUES (?, ?, ?, ?, ?, ?)'
              ).run(
                state === 'wrong-session' ? 's-code' : sessionId,
                'input-123',
                'user',
                JSON.stringify({ message: { content: message } }),
                new Date(100).toISOString(),
                state === 'deferred' ? 'deferred' : 'consumed'
              );
            return 'input-123';
          },
        },
      } as never);
      const actual = createSpaceAdapter({
        readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
        db: () => db,
        machine: 'imac',
        searchChats: async () => [],
        tasks: control,
      });
      const result = await actual.send!(ref('t1'), 'Follow up', neo);
      expect(injections).toEqual([
        { sessionId: 's-rebound', message: 'Follow up', internal: true },
      ]);
      if (state === 'failed') {
        expect(result).toEqual({ ok: false, reason: 'not_delivered', detail: 'injection refused' });
      } else {
        expect(result).toEqual({
          ok: true,
          value: {
            delivered: state !== 'deferred',
            ...(['consumed', 'deferred'].includes(state)
              ? {
                  receipt: { executionId: 's-rebound', inputId: 'input-123' },
                }
              : {}),
          },
        });
      }
    }
  );

  test('sends to the workflow agent that is working on the task', async () => {
    expect(await adapter().send?.(ref('t1'), 'use 16px', neo)).toEqual({
      ok: true,
      value: { delivered: true },
    });
    const relayedNeo = {
      from: 'daemon:imac::session:neo%3Aroot',
      caller: { source: 'rpc' as const },
    };
    expect(await adapter().send?.(ref('t1'), 'go on', relayedNeo)).toMatchObject({ ok: true });
    expect(
      await adapter().send?.(ref('t1'), 'stop there', {
        from: 'chat',
        caller: { source: 'rpc' as const },
      })
    ).toMatchObject({
      ok: true,
    });
    expect(sent).toEqual([
      't1 coder@node-code use 16px from an agent',
      't1 coder@node-code go on from an agent',
      't1 coder@node-code stop there from you',
    ]);
  });

  test('sends to a Space agent through message.send, queued while it is busy', async () => {
    expect(await adapter().send?.(ref('agent:a1'), 'review the header', neo)).toEqual({
      ok: true,
      value: { delivered: false },
    });
    expect(await adapter().send?.(ref('agent:a2'), 'write the notes', neo)).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(await adapter().send?.(ref('agent:a2'), 'refuse', neo)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'agent session is gone',
    });
    expect(sent).toEqual([
      'sp1/a1 review the header from session:neo%3Aroot',
      'sp1/a2 write the notes from session:neo%3Aroot',
      'sp1/a2 refuse from session:neo%3Aroot',
    ]);
  });

  test('refuses archived agents, unknown agents and other agents as senders', async () => {
    const worker = {
      from: 'session:w1',
      caller: { source: 'mcp' as const, sessionId: 'w1', role: 'workflow_worker' as const },
    };
    expect(await adapter().send?.(ref('agent:a3'), 'hi', neo)).toMatchObject({
      reason: 'not_open',
    });
    expect(await adapter().send?.(ref('agent:zz'), 'hi', neo)).toMatchObject({
      reason: 'not_found',
    });
    expect(await adapter().send?.(ref('agent:a2'), 'hi', worker)).toMatchObject({
      reason: 'unsupported',
    });
    expect(sent).toEqual([]);
  });

  test('reports a message the agent will only see after its current turn', async () => {
    expect(await adapter().send?.(ref('t1'), 'later, check the tests', neo)).toEqual({
      ok: true,
      value: { delivered: false },
    });
  });

  test('never wakes a cancelled or pending node', async () => {
    expect(await adapter().send?.(ref('t4'), 'hi', neo)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(sent).toEqual([]);
  });

  test('refuses other agents, finished tasks and tasks without a workflow agent', async () => {
    const worker = {
      from: 'session:w1',
      caller: { source: 'mcp' as const, sessionId: 'w1', role: 'workflow_worker' as const },
    };
    expect(await adapter().send?.(ref('t1'), 'hi', worker)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(await adapter().send?.(ref('t2'), 'hi', neo)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(await adapter().send?.(ref('t3'), 'hi', neo)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(sent).toEqual([]);
  });
});
