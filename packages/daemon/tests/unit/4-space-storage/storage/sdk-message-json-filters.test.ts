import { beforeEach, describe, expect, test } from 'bun:test';
import { BACKGROUND_TASK_METADATA_SQL } from '../../../../src/lib/live-query/queries/messages';
import { readSpaceStartReceipt } from '../../../../src/lib/drivers/space-adapter';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

type Row = {
  id: string;
  type: string;
  subtype?: string;
  body: Record<string, unknown>;
  at: number;
  status?: string;
  uuid?: string;
  consumedSeq?: number;
  terminal?: boolean;
  taskId?: string;
};

let db: Database;
let repo: SDKMessageRepository;

function insert(row: Row): void {
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp,
       send_status, sdk_uuid, consumed_seq, is_terminal, task_id)
     VALUES (?, 's1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.type,
    row.subtype ?? null,
    JSON.stringify({ type: row.type, ...row.body }),
    new Date(Date.UTC(2026, 9, 20, 0, 0, row.at)).toISOString(),
    row.status ?? 'consumed',
    row.uuid ?? null,
    row.consumedSeq ?? null,
    row.terminal ? 1 : 0,
    row.taskId ?? null
  );
}

const result = (
  id: string,
  consumedSeq: number,
  body: Record<string, unknown>,
  subtype = 'success'
) => insert({ id, type: 'result', subtype, body, at: consumedSeq, consumedSeq, terminal: true });

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys = OFF');
  repo = new SDKMessageRepository(db);
  insert({ id: 'p', type: 'user', body: {}, at: 1, uuid: 'prompt', consumedSeq: 1 });
});

describe('SDKMessageRepository.hasTerminalResultAfter', () => {
  test('ignores compaction turns and non-billing recovery intercepts, counts a plain success', () => {
    result('r1', 2, { internal_compaction_turn: 1 });
    result('r2', 3, { is_error: 1, recovery_intercepted: 1, recovery_billing_terminal: 0 });
    expect(repo.hasTerminalResultAfter('s1', 'prompt')).toBe(false);
    result('r3', 4, { is_error: 1, recovery_intercepted: 1, recovery_billing_terminal: 1 });
    expect(repo.hasTerminalResultAfter('s1', 'prompt')).toBe(true);
  });
});

describe('SDKMessageRepository.getTurnErrorResultSubtype', () => {
  test('reads an is_error success as error and skips non-billing recovery intercepts', () => {
    result('r1', 2, { recovery_intercepted: 1 }, 'error_max_turns');
    expect(repo.getTurnErrorResultSubtype('s1', 'prompt')).toBeNull();
    result('r2', 3, { is_error: 1 });
    expect(repo.getTurnErrorResultSubtype('s1', 'prompt')).toBe('error');
  });
});

describe('SDKMessageRepository.hasRecoveryInterceptedResultAfter', () => {
  test('is true only for an intercepted result that is not billing-terminal', () => {
    result('r1', 2, { recovery_intercepted: 1, recovery_billing_terminal: 1 });
    expect(repo.hasRecoveryInterceptedResultAfter('s1', 'prompt')).toBe(false);
    result('r2', 3, { recovery_intercepted: 1 });
    expect(repo.hasRecoveryInterceptedResultAfter('s1', 'prompt')).toBe(true);
  });
});

describe('SDKMessageRepository.lastConsumedInputSeq', () => {
  test('skips consumed user rows without an input kind', () => {
    insert({ id: 'a', type: 'user', body: { inputKind: 'system' }, at: 5 });
    insert({ id: 'b', type: 'user', body: {}, at: 6 });
    const seq = db.prepare("SELECT seq FROM sdk_messages WHERE id = 'a'").get() as { seq: number };
    expect(repo.lastConsumedInputSeq('s1')).toBe(seq.seq);
  });
});

describe('SDKMessageRepository.lastHumanPromptAt', () => {
  test('returns the latest human input, not a later system input', () => {
    insert({ id: 'h', type: 'user', body: { inputKind: 'human' }, at: 5 });
    insert({ id: 's', type: 'user', body: { inputKind: 'system' }, at: 6 });
    expect(repo.lastHumanPromptAt('s1')).toBe(Date.UTC(2026, 9, 20, 0, 0, 5));
  });
});

describe('SDKMessageRepository.readRestartRecoveryEvidence', () => {
  test('takes the last consumed prompt that is not a tool result', () => {
    insert({
      id: 'q',
      type: 'user',
      body: { message: { content: [{ type: 'text', text: 'go' }] } },
      at: 5,
      uuid: 'q',
    });
    insert({
      id: 't',
      type: 'user',
      body: { message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      at: 6,
      uuid: 't',
    });
    insert({ id: 'w', type: 'assistant', body: {}, at: 7 });
    expect(repo.readRestartRecoveryEvidence('s1')).toEqual({ promptUuid: 'q', workedAfter: true });
  });
});

describe('SDKMessageRepository.hasConsumedTaskInputForSession', () => {
  test('counts task inputs and synthetic inputs without a kind, not system inputs', () => {
    insert({
      id: 'sys',
      type: 'user',
      body: { inputKind: 'system' },
      at: 5,
      consumedSeq: 5,
      taskId: 'k',
    });
    expect(repo.hasConsumedTaskInputForSession('s1', 'k')).toBe(false);
    insert({
      id: 'syn',
      type: 'user',
      body: { isSynthetic: true },
      at: 6,
      consumedSeq: 6,
      taskId: 'k',
    });
    expect(repo.hasConsumedTaskInputForSession('s1', 'k')).toBe(true);
    insert({
      id: 'task',
      type: 'user',
      body: { inputKind: 'task' },
      at: 7,
      consumedSeq: 7,
      taskId: 'm',
    });
    expect(repo.hasConsumedTaskInputForSession('s1', 'm')).toBe(true);
  });
});

describe('SDKMessageRepository.getUserMessageIdsByStatus', () => {
  test('leaves out replayed user rows and keeps isReplay false or absent', () => {
    insert({ id: 'r', type: 'user', body: { isReplay: true }, at: 5, status: 'enqueued' });
    insert({ id: 'f', type: 'user', body: { isReplay: false }, at: 6, status: 'enqueued' });
    insert({ id: 'n', type: 'user', body: {}, at: 7, status: 'enqueued' });
    expect(repo.getUserMessageIdsByStatus('s1', 'enqueued').map((row) => row.dbId)).toEqual([
      'f',
      'n',
    ]);
  });
});

describe('SDKMessageRepository.hasUnresolvedHyperNeoAction', () => {
  test('follows the resolved flag of the action message', () => {
    insert({ id: 'act', type: 'hyperneo_action', subtype: 'resume', body: { resolved: 1 }, at: 5 });
    expect(repo.hasUnresolvedHyperNeoAction('s1', 'resume')).toBe(false);
    insert({
      id: 'open',
      type: 'hyperneo_action',
      subtype: 'resume',
      body: { resolved: 0 },
      at: 6,
    });
    expect(repo.hasUnresolvedHyperNeoAction('s1', 'resume')).toBe(true);
  });
});

describe('readSpaceStartReceipt', () => {
  test('starts at the first real task input, skipping replays, compaction turns and tool results', () => {
    const task = (id: string, at: number, body: Record<string, unknown>) =>
      insert({ id, type: 'user', body, at, uuid: id, taskId: 'k' });
    task('replay', 2, { isReplay: true });
    task('compact', 3, { internal_compaction_turn: 1 });
    task('tool', 4, { message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } });
    expect(readSpaceStartReceipt(db, 'k')).toBeNull();
    task('start', 5, {});
    task('later', 6, { message: { content: [{ type: 'text', text: 'more' }] } });
    expect(readSpaceStartReceipt(db, 'k')).toEqual({ executionId: 's1', inputId: 'start' });
  });
});

function seedBackgroundTasks(): void {
  const task = (
    id: string,
    subtype: string,
    at: number,
    body: Record<string, unknown>,
    taskId?: string
  ) => insert({ id, type: 'system', subtype, body: { ...body, mark: id }, at, taskId });
  task('start', 'task_started', 2, { task_id: 'k' });
  task('col', 'task_updated', 3, {}, 'j');
  task('old', 'task_progress', 4, { task_id: 'k', tool_use_id: 'u' });
  task('new', 'task_progress', 5, { task_id: 'k', tool_use_id: 'u' });
  task('colp', 'task_progress', 6, { tool_use_id: 'v' }, 'j');
  task('gone', 'task_progress', 7, { task_id: 'z', tool_use_id: 'w' });
}

describe('SDKMessageRepository.getBackgroundTaskMessages', () => {
  test('keys background tasks by the JSON task id or the task_id column, keeping only the latest progress per tool use', () => {
    seedBackgroundTasks();
    const marks = repo
      .getBackgroundTaskMessages('s1')
      .map((message) => (message as unknown as { mark: string }).mark);
    expect(new Set(marks)).toEqual(new Set(['start', 'col', 'new', 'colp', 'gone']));
  });
});

describe('BACKGROUND_TASK_METADATA_SQL', () => {
  test('returns the same background task rows as the repository read', () => {
    seedBackgroundTasks();
    const rows = db.prepare(BACKGROUND_TASK_METADATA_SQL).all(...Array(7).fill('s1')) as {
      id: string;
    }[];
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(['start', 'col', 'new', 'colp', 'gone'])
    );
  });
});
