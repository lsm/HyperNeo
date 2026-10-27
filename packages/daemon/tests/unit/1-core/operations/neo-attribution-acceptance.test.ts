import { readHyperneoTurnEnds } from '../../../../src/storage/hyperneo-turn-ends-read.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createSpaceAdapter } from '../../../../src/lib/drivers/space-adapter.ts';
import type { WorkDelivery } from '../../../../src/lib/drivers/types.ts';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns.ts';
import { readDriverSettlement } from '../../../../src/lib/neo/driver-work.ts';

type Receipt = NonNullable<WorkDelivery['receipt']>;

const receipt: Receipt = { executionId: 's-code', inputId: 'own-input' };
const opening = 'Own task input';
const work: NeoWork = Object.freeze({
  id: 'card-1',
  requestKey: 'root:card-1',
  originSessionId: 'neo:root',
  originMessageId: null,
  projectId: null,
  title: 'Font size',
  instruction: opening,
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
});

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)`);
  db.exec(`CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, task_number INTEGER,
    title TEXT, status TEXT, updated_at INTEGER, result TEXT, reported_summary TEXT,
    block_reason TEXT, workflow_run_id TEXT, completed_at INTEGER)`);
  db.exec(`CREATE TABLE node_executions (id TEXT PRIMARY KEY, workflow_run_id TEXT, agent_name TEXT,
    workflow_node_id TEXT, agent_session_id TEXT, status TEXT, last_activity_at INTEGER,
    updated_at INTEGER)`);
  db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, space_id TEXT,
    handle TEXT, display_name TEXT, status TEXT, session_id TEXT, updated_at INTEGER)`);
  db.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, processing_state TEXT, last_active_at TEXT)`
  );
  db.exec(`CREATE TABLE sdk_messages (session_id TEXT, task_id TEXT, sdk_uuid TEXT,
    message_type TEXT, sdk_message TEXT, timestamp TEXT, parent_tool_use_id TEXT,
    send_status TEXT, consumed_seq INTEGER, is_terminal INTEGER)`);
  db.exec(`INSERT INTO spaces VALUES ('sp1', 'dev-neokai')`);
  db.exec(`INSERT INTO space_tasks VALUES
    ('t1', 'sp1', 7, 'font size', 'done', 10, 'Aggregate from every node', NULL, NULL, 'run-1', 3000)`);
  db.exec(`INSERT INTO node_executions VALUES
    ('n1', 'run-1', 'coder', 'node-code', 's-code', 'completed', 40, 40)`);
  write('own-input', 'user', 10, opening);
  write('own-result', 'result', 11, 'Raised the body font to 16px.');
  write('pr-event', 'user', 12, 'PR #42 has a failing check.');
  write('pr-result', 'result', 13, 'Fixed the check on #42.');
});

afterEach(() => db.close());

function write(id: string, type: string, seq: number | null, text: string, session = 's-code') {
  db.prepare(
    `INSERT INTO sdk_messages (session_id,task_id,sdk_uuid,message_type,sdk_message,timestamp,parent_tool_use_id,send_status,consumed_seq,is_terminal) VALUES (?, 't1', ?, ?, ?, ?, NULL, 'consumed', ?, 1)`
  ).run(
    session,
    id,
    type,
    JSON.stringify(
      type === 'user'
        ? { type, message: { content: text }, inputKind: 'task' }
        : { type, result: text }
    ),
    new Date(1000 + (seq ?? 0)).toISOString(),
    seq
  );
}

async function status(input: Receipt | undefined = receipt) {
  const adapter = createSpaceAdapter({
    readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
    db: () => {
      fillSdkMessageFixtureColumns(db);
      return db;
    },
    machine: 'imac',
    searchChats: async () => [],
    tasks: {
      create: async () => ({ reason: 'unused' }),
      cancel: async () => ({ reason: 'unused' }),
      message: async () => ({ delivered: true }),
      messageAgent: async () => ({ accepted: true }),
    },
  });
  const result = await adapter.status!({ adapter: 'space', id: 't1' }, undefined, input);
  return { kind: 'completed' as const, value: result };
}

describe('readDriverSettlement', () => {
  test("reports the card's own reply, not a later PR event's reply or the task aggregate", async () => {
    expect(readDriverSettlement(work, await status(), 10_000, 5, true, opening, receipt)).toEqual({
      status: 'reported',
      report: 'Agent: Raised the body font to 16px.',
    });
  });

  test('keeps the same reply after the node and run are replaced', async () => {
    db.exec("UPDATE node_executions SET agent_session_id = 's-new', status = 'cancelled'");
    db.exec("UPDATE space_tasks SET workflow_run_id = 'run-2'");
    write('new-input', 'user', 14, 'Replacement input', 's-new');
    write('new-result', 'result', 15, 'Replacement reply', 's-new');
    expect(
      readDriverSettlement(work, await status(), 10_000, 5, true, opening, receipt)?.report
    ).toBe('Agent: Raised the body font to 16px.');
  });

  test('a continue settles from its own input once its receipt replaces the first', async () => {
    const continued = { ...receipt, inputId: 'pr-event' };
    expect(
      readDriverSettlement(work, await status(continued), 10_000, 5, true, opening, continued)
    ).toEqual({
      status: 'reported',
      report: 'Agent: Fixed the check on #42.',
    });
  });

  test('never settles an input the agent has not read', async () => {
    db.exec(
      "UPDATE sdk_messages SET send_status = 'deferred', consumed_seq = NULL WHERE sdk_uuid = 'own-input'"
    );
    expect(
      readDriverSettlement(work, await status(), 10_000, 5, true, opening, receipt)
    ).toBeNull();
  });

  test('says when later replies were cut', async () => {
    db.exec("DELETE FROM sdk_messages WHERE sdk_uuid <> 'own-input'");
    for (let n = 0; n < 45; n++) write(`result-${n}`, 'result', 11 + n, `Step ${n}`);
    expect(
      readDriverSettlement(work, await status(), 10_000, 5, true, opening, receipt)?.report
    ).toEndWith('(Later replies were not read; this is not the whole exchange.)');
  });

  test('an adopted card without a receipt cannot borrow the latest reply', async () => {
    expect(readDriverSettlement(work, await status(undefined), 10_000, 5)).toBeNull();
  });
});
