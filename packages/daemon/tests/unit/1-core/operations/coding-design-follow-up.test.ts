import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoAskSettleRefusal } from '../../../../src/lib/neo/pack-contract.ts';
import { wakeCodingDesignFollowUps } from '../../../../src/lib/neo/packs/coding/design-follow-up.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';

const DESIGN_URL = 'https://github.com/example/project/pull/7';
const merged = (design: boolean): NeoWorkPr => ({
  url: DESIGN_URL,
  state: 'MERGED',
  checks: 'passing',
  review: 'approved',
  title: 'Design: cache layer',
  ...(design ? { design: true as const } : {}),
});

function setup(design = true) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const packs = createTodoCheckPacks(db);
  const store = new NeoAskTodoRepository(db);
  const prs = new CodingTodoPrRepository(db);
  const ask = store.openAsk({
    id: 'ask-1',
    title: 'Cache layer',
    request: 'Design and build the cache layer',
    sessionId: 'neo-a',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const draft = { doneWhen: 'PR merged', check: null, named: null, instruction: null };
  const designTodo = store.addTodo('todo-design', ask.id, { ...draft, title: 'Design doc' }, 1);
  store.updateTodo(designTodo, { state: 'done' }, 2);
  prs.record(designTodo.id, [merged(design)], 2);
  const wakes: { key: string; text: string }[] = [];
  const wake = async (key: string, text: string) => {
    wakes.push({ key, text });
    return true;
  };
  return { db, packs, store, prs, ask, draft, wakes, wake };
}

describe('wakeCodingDesignFollowUps', () => {
  test('wakes Neo with one stable key when a merged design PR has no later todo', async () => {
    const h = setup();
    await wakeCodingDesignFollowUps(h.prs, h.wake);
    await wakeCodingDesignFollowUps(h.prs, h.wake);
    expect(h.wakes).toHaveLength(2);
    expect(h.wakes[0].key).toBe(h.wakes[1].key);
    expect(h.wakes[0].text).toContain(DESIGN_URL);
    expect(h.wakes[0].text).toContain('Change section');
    expect(h.wakes[0].text).toContain('ask-1');
  });

  test('stays quiet once a follow-up todo exists, even an unstarted one', async () => {
    const h = setup();
    h.store.addTodo('todo-build', h.ask.id, { ...h.draft, title: 'Build it' }, 3);
    await wakeCodingDesignFollowUps(h.prs, h.wake);
    expect(h.wakes).toEqual([]);
  });

  test('stays quiet for a merged PR that changes no design docs', async () => {
    const h = setup(false);
    await wakeCodingDesignFollowUps(h.prs, h.wake);
    expect(h.wakes).toEqual([]);
  });

  test('stays quiet once the ask is settled', async () => {
    const h = setup();
    h.store.settleAsk(h.ask, 'dropped', 'Not needed', 3);
    await wakeCodingDesignFollowUps(h.prs, h.wake);
    expect(h.wakes).toEqual([]);
  });
});

describe('neoAskSettleRefusal', () => {
  test('refuses a merged design with no later todo and allows it after a follow-up is added', () => {
    const h = setup();
    expect(neoAskSettleRefusal(h.packs, h.store.listTodos(h.ask.id))).toContain(
      'design_follow_up_missing'
    );
    h.store.addTodo('todo-build', h.ask.id, { ...h.draft, title: 'Build it' }, 3);
    expect(neoAskSettleRefusal(h.packs, h.store.listTodos(h.ask.id))).toBeNull();
  });

  test('a removed follow-up does not count', () => {
    const h = setup();
    const later = h.store.addTodo('todo-build', h.ask.id, { ...h.draft, title: 'Build it' }, 3);
    h.store.updateTodo(later, { state: 'removed', reason: 'dropped' }, 4);
    expect(neoAskSettleRefusal(h.packs, h.store.listTodos(h.ask.id))).toContain(
      'design_follow_up_missing'
    );
  });
});
