import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoSessionNotice } from '../../../../src/lib/neo/session-watch.ts';
import { neoSessionKey } from '../../../../src/lib/neo/session-watch.ts';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op.ts';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

type Input = { askId: string; todoId: string; notice: NeoSessionNotice; now: number };
type Receipt =
  | { ok: false; reason: string }
  | {
      ok: true;
      root: string;
      messageId: string;
      ask: NeoAsk;
      todo: NeoTodo;
      ref: NeoSessionNotice['ref'];
      link: string | null;
    };

describe('Atomic Track admission build', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let changes: string[];
  const ref = { adapter: 'codex-desktop', id: 'synthetic-human-worker' };
  const input = (id = 'one'): Input => ({
    askId: `ask-${id}`,
    todoId: `todo-${id}`,
    now: 123,
    notice: {
      key: neoSessionKey(ref),
      ref,
      title: 'Human work 🦊',
      kind: 'needs_you',
      at: 1,
      link: 'codex://threads/synthetic',
    },
  });
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    new NeoRepository(db).reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (events) => {
      changes.push(...events.map((event) => event.table));
    };
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const run = (args = input()) => {
    const op = DB_OPS.get('neo.sessionTrackWrites') as DbOp<Input, Receipt> | undefined;
    expect(op, 'register the data-only Track command without activating callers').toBeDefined();
    if (!op) throw new Error('Track writer command unavailable');
    expect(op.mode).toBe('write');
    return gateway.run(op, args);
  };
  const snapshot = () => ({
    asks: store.listOpenAsks(),
    todo: store.getTodo('todo-one'),
    refs: store.followedRefs(),
    target: sessions.get('todo-one'),
    anchor: sessions.readFollowAnchor('todo-one'),
  });
  test('creates the entire adopted card and preserves complete notice text', async () => {
    const args = input();
    args.notice.title = '完整的人类工作 🦊\n'.repeat(12000);
    const result = await run(args);
    expect(result).toMatchObject({
      ok: true,
      root: 'neo:root',
      messageId: `neo-track:${args.notice.key}:ask-one`,
      ask: {
        id: 'ask-one',
        sessionId: 'neo:root',
        title: args.notice.title,
        request: `See ${args.notice.title} through.`,
      },
      todo: { id: 'todo-one', state: 'doing', startedAt: 123, check: null },
      ref: args.notice.ref,
      link: args.notice.link,
    });
    expect(sessions.get('todo-one')).toEqual({ verb: 'adopt', ref });
    expect(sessions.readRef('todo-one')).toEqual(ref);
    expect(sessions.readFollowAnchor('todo-one')).toBe(123);
    expect(sessions.readLinks('todo-one').link).toBe(args.notice.link);
    expect(store.getAsk('ask-one')?.title).toBe(args.notice.title);
    expect(changes).toContain('neo_asks');
    expect(changes).toContain('neo_todos');
    expect(changes).toContain('neo_todo_sessions');
  });
  test('two concurrent taps produce one card and the existing duplicate refusal', async () => {
    const results = await Promise.all([run(input('one')), run(input('two'))]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'A Neo card already follows this session.' },
    ]);
    expect(store.listOpenAsks()).toHaveLength(1);
    expect(store.followedRefs()).toEqual([ref]);
  });
  test('a late anchor failure rolls back the ask, todo, binding and changes', async () => {
    const before = snapshot();
    db.exec(
      "CREATE TRIGGER refuse_track_anchor BEFORE UPDATE OF follow_anchor ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic Track anchor failure'); END"
    );
    await expect(run()).rejects.toThrow('synthetic Track anchor failure');
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
    db.exec('DROP TRIGGER refuse_track_anchor');
    expect(await run()).toMatchObject({ ok: true, todo: { state: 'doing' } });
  });
  test('missing Neo refuses without a partial card or notification', async () => {
    db.exec('DELETE FROM neo_session_bindings');
    const before = snapshot();
    expect(await run()).toEqual({
      ok: false,
      reason: 'Neo has not started yet; open Neo once, then tap Track.',
    });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });
  test('uses the current root selected beside the write', async () => {
    db.exec('DELETE FROM neo_session_bindings');
    new NeoRepository(db).reserveBinding({
      sessionId: 'neo:replacement',
      kind: 'neo',
      projectId: null,
    });
    expect(await run()).toMatchObject({
      ok: true,
      root: 'neo:replacement',
      ask: { sessionId: 'neo:replacement' },
    });
  });
  test('a different worker remains independently trackable', async () => {
    await run();
    const other = input('two');
    other.notice.ref = { ...ref, id: 'other-worker' };
    other.notice.key = neoSessionKey(other.notice.ref);
    expect(await run(other)).toMatchObject({ ok: true });
    expect(store.listOpenAsks()).toHaveLength(2);
    expect(store.followedRefs()).toHaveLength(2);
  });
});
