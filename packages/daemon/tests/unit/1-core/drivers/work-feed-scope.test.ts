import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeFeed } from '../../../../src/lib/drivers/claude-feed';
import { ownClaudeSessions } from '../../../../src/lib/rpc-handlers/family-operations/drivers';
import { ownCodexSessions, runCodexFeed } from '../../../../src/lib/drivers/codex-feed';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter } from '../../../../src/lib/drivers/types';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createFeedTurnIndex,
  createWorkFeedOffsetsTable,
} from '../../../../src/storage/schema/m302-work-index-kinds';
import { runMigration455 } from '../../../../src/storage/schema/m455-work-started-sessions';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readStartedWork, recordStartedWork } from '../../../../src/storage/work-started-sessions';

const at = '2026-10-24T05:00:00.000Z';
const place = { machine: 'imac', folder: '/Users/me/focus/heron', name: 'heron' };
const STARTED_THREAD = '11111111-1111-4111-8111-111111111111';
const TODO_THREAD = '22222222-2222-4222-8222-222222222222';
const FOREIGN_THREAD = '33333333-3333-4333-8333-333333333333';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-feed-scope-'));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
    message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
    message_type TEXT, title TEXT, body TEXT, timestamp INTEGER, UNIQUE (kind, source_id))`);
  db.exec('CREATE TABLE sessions (id TEXT, sdk_session_id TEXT)');
  db.exec('CREATE TABLE neo_todo_sessions (todo_id TEXT PRIMARY KEY, target TEXT, ref TEXT)');
  createWorkFeedOffsetsTable(db);
  createFeedTurnIndex(db);
  runMigration455(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function startThroughWorkStart(adapter: string, id: string) {
  const starter: WorkAdapter = {
    id: adapter,
    capabilities: ['find', 'start'],
    find: () => [],
    start: async (request) => ({
      ok: true,
      value: {
        ref: { adapter, id },
        title: request.title,
        place,
        status: 'running',
        lastActivityAt: 1,
      },
    }),
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [starter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      recordStarted: (ref) => recordStartedWork(db, ref),
    })
  );
  const outcome = await invokeOperation(
    registry,
    'work.start',
    { adapter, place, title: 'heron', message: 'go' },
    { source: 'rpc' }
  );
  if (outcome.kind !== 'completed') throw new Error(JSON.stringify(outcome));
  expect(outcome.value).toMatchObject({ ok: true });
}

function startedForTodo(todoId: string, adapter: string, id: string) {
  db.prepare('INSERT INTO neo_todo_sessions VALUES (?, ?, ?)').run(
    todoId,
    '{}',
    JSON.stringify({ adapter, id })
  );
}

const feedSessions = (kind: string) =>
  (
    db
      .prepare(
        'SELECT DISTINCT session_id AS id FROM message_search_content WHERE kind = ? ORDER BY id'
      )
      .all(kind) as Array<{ id: string }>
  ).map((row) => row.id);

const queue = { enqueueUniquePending: () => {} } as never;

describe('work feed scope', () => {
  function writeCodexRollout(threadId: string) {
    const day = join(root, '2026', '10', '24');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-10-24T05-00-00-${threadId}.jsonl`),
      [
        { type: 'session_meta', payload: { id: threadId, cwd: '/Users/me/focus/heron' } },
        {
          type: 'response_item',
          timestamp: at,
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );
  }

  function writeClaudeTranscript(base: string, sessionId: string) {
    const project = join(base, '-Users-me-focus-heron');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: `u-${sessionId}`,
        timestamp: at,
        cwd: '/Users/me/focus/heron',
        message: { content: 'plan the heron rollout' },
      })}\n`
    );
  }

  test("'own' Codex feed keeps threads this instance started, with or without a todo", async () => {
    await startThroughWorkStart('codex-desktop', STARTED_THREAD);
    startedForTodo('todo-1', 'codex-desktop', TODO_THREAD);
    for (const thread of [STARTED_THREAD, TODO_THREAD, FOREIGN_THREAD]) writeCodexRollout(thread);

    await runCodexFeed(queue, db, root, Date.now(), ownCodexSessions(readStartedWork(db)));

    expect(feedSessions('codex')).toEqual([STARTED_THREAD, TODO_THREAD]);
  });

  test("'all' Codex feed still shows every thread on the machine", async () => {
    for (const thread of [STARTED_THREAD, TODO_THREAD, FOREIGN_THREAD]) writeCodexRollout(thread);

    await runCodexFeed(queue, db, root, Date.now(), null);

    expect(feedSessions('codex')).toEqual([STARTED_THREAD, TODO_THREAD, FOREIGN_THREAD]);
  });

  test("'own' Claude feed keeps sessions this instance started, including Desktop ones", async () => {
    const desktop = join(root, 'desktop', 'account', 'scope');
    mkdirSync(desktop, { recursive: true });
    writeFileSync(
      join(desktop, 'local_desk.json'),
      JSON.stringify({ sessionId: 'local_desk', cliSessionId: 'cli-desk' })
    );
    await startThroughWorkStart('claude-code', 'cli-started');
    startedForTodo('todo-2', 'claude-desktop', 'local_desk');
    const transcripts = join(root, 'projects');
    for (const session of ['cli-started', 'cli-desk', 'cli-foreign'])
      writeClaudeTranscript(transcripts, session);

    const own = await ownClaudeSessions(readStartedWork(db), join(root, 'desktop'));
    await runClaudeFeed(queue, db, transcripts, Date.now(), undefined, own);

    expect(feedSessions('claude')).toEqual(['cli-desk', 'cli-started']);
  });

  test("'all' Claude feed still shows every session on the machine", async () => {
    for (const session of ['cli-started', 'cli-desk', 'cli-foreign'])
      writeClaudeTranscript(root, session);

    await runClaudeFeed(queue, db, root, Date.now(), undefined, null);

    expect(feedSessions('claude')).toEqual(['cli-desk', 'cli-foreign', 'cli-started']);
  });
});
