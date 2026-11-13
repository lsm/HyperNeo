import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoAskRecordOperations,
  neoAskMatterRefusal,
} from '../../../../src/lib/neo/ask-record-operations.ts';
import { codingAskMatter } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  createTodoCheckPacks,
  existingTodoTarget,
  pendingTodoCheck,
} from '../../helpers/todo-check-packs.ts';

type Receipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] } | { ok: false; reason: string };

const as = (sessionId: string): OperationCaller => ({ source: 'mcp', sessionId, role: 'neo' });
const pull = 'https://github.com/synthetic/proof/pull/7';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const unused = async () => ({ ok: false as const, reason: 'unused' });
  const ops = Object.fromEntries(
    createNeoAskRecordOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        resolveTarget: existingTodoTarget,
        start: unused,
        recompute: async (todo) => todo,
        proceed: unused,
        retry: unused,
        stop: async () => null,
      },
      () => null,
      () => true,
      () => [],
      () =>
        createTodoCheckPacks(db).map((pack) =>
          pack.id === 'coding' ? { ...pack, matter: codingAskMatter } : pack
        ),
      () => null,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller = as('neo-a')) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  const open = (title: string, request: string, caller?: OperationCaller) =>
    call('neo.ask.open', { title, request }, caller);
  return { db, store, call, open };
}

describe('codingAskMatter', () => {
  test('one pull request or issue is the key, however the ask writes it', () => {
    const key = 'synthetic/proof#7';
    expect(codingAskMatter({ title: 'Review', request: `Please review ${pull}` })).toBe(key);
    expect(codingAskMatter({ title: 'Check Synthetic/Proof#7', request: 'Look at it' })).toBe(key);
    expect(
      codingAskMatter({ title: 'Review synthetic/proof#7', request: `It is ${pull} again` })
    ).toBe(key);
    expect(
      codingAskMatter({
        title: 'Triage',
        request: 'See https://github.com/synthetic/proof/issues/9',
      })
    ).toBe('synthetic/proof#9');
  });

  test('an ask that names no reference, or several, has no key', () => {
    expect(codingAskMatter({ title: 'Tidy the notes', request: 'Step #7 is stale' })).toBeNull();
    expect(
      codingAskMatter({ title: 'Compare', request: `${pull} against synthetic/proof#8` })
    ).toBeNull();
  });

  test('a short form names the pull request in the ask’s own repository', () => {
    const repos = ['synthetic/proof'];
    for (const request of ['Review proof#7', 'Merge Proof#7 now', 'Merge #7', 'Look at PR #7'])
      expect(codingAskMatter({ title: 'Handle it', request }, repos)).toBe('synthetic/proof#7');
    expect(codingAskMatter({ title: 'Review proof#7', request: `It is ${pull}` }, repos)).toBe(
      'synthetic/proof#7'
    );
  });

  test('a short form that fits no project repository, or more than one, has no key', () => {
    const ask = (request: string) => ({ title: 'Handle it', request });
    expect(codingAskMatter(ask('Merge #7'), [])).toBeNull();
    expect(codingAskMatter(ask('Merge #7'), ['synthetic/proof', 'synthetic/other'])).toBeNull();
    expect(codingAskMatter(ask('Review other#7'), ['synthetic/proof'])).toBeNull();
    expect(codingAskMatter(ask('Review proof#7'), ['synthetic/proof', 'mirror/proof'])).toBeNull();
    expect(codingAskMatter(ask(`Merge #8 after ${pull}`), ['synthetic/proof'])).toBeNull();
  });
});

describe('neoAskMatterRefusal', () => {
  const packs = [{}, { matter: (ask: { title: string }) => ask.title.split(' ')[0] || null }];
  const stored = (id: string, title: string, createdAt: number) => ({
    id,
    title,
    request: 'Synthetic request',
    createdAt,
  });

  test('names the oldest open ask with the same key and its id', () => {
    const open = [stored('late', 'alpha again', 3), stored('first', 'alpha one', 1)];
    const reason = neoAskMatterRefusal({ title: 'alpha two', request: 'More' }, open, packs);
    expect(reason).toStartWith('ask_open: "alpha one" (first) is already open for alpha.');
    expect(reason).not.toContain('late');
  });

  test('a different key, or no pack with a key, refuses nothing', () => {
    const open = [stored('first', 'alpha one', 1)];
    expect(neoAskMatterRefusal({ title: 'beta one', request: 'More' }, open, packs)).toBeNull();
    expect(neoAskMatterRefusal({ title: 'alpha two', request: 'More' }, open, [{}])).toBeNull();
    expect(neoAskMatterRefusal({ title: 'alpha two', request: 'More' }, [], packs)).toBeNull();
  });
});

describe('neo.ask.open', () => {
  test('a second ask for the same pull request is refused with the first one’s id', async () => {
    const { open, store } = setup();
    const first = await open('Review the fix', `Review ${pull} and merge it`);
    if (!first.ok) throw new Error(first.reason);
    const second = await open('Deploy the fix', 'Deploy synthetic/proof#7 once it is merged');
    expect(second).toEqual({
      ok: false,
      reason: `ask_open: "Review the fix" (${first.ask.id}) is already open for synthetic/proof#7. Add the todos to that ask with neo.todo.add; open another only after it is settled.`,
    });
    expect(store.listOpenAsks().map((ask) => ask.id)).toEqual([first.ask.id]);
  });

  test('two asks for the same pull request opened at once leave one open ask', async () => {
    const { call, store } = setup();
    const step = {
      after: [],
      title: 'Review it',
      doneWhen: 'Reviewed',
      check: pendingTodoCheck,
      instruction: 'Review the pull request.',
      target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'dev-1' } },
    };
    const both = await Promise.all(
      ['Review the fix', 'Deploy the fix'].map((title) =>
        call('neo.ask.open', { title, request: `Handle ${pull}`, todos: [step] })
      )
    );
    const [opened] = store.listOpenAsks();
    expect(store.listOpenAsks()).toHaveLength(1);
    expect(both.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(both.find((result) => !result.ok)).toEqual({
      ok: false,
      reason: expect.stringContaining(`(${opened.id}) is already open for synthetic/proof#7`),
    });
  });

  test('a retry with the same title still returns the same ask', async () => {
    const { open } = setup();
    const first = await open('Review the fix', `Review ${pull}`);
    const retry = await open('Review the fix', `Review ${pull}`);
    if (!first.ok || !retry.ok) throw new Error('refused');
    expect(retry.ask.id).toBe(first.ask.id);
  });

  test('another pull request, an ask that names none, and another session all open', async () => {
    const { open, store } = setup();
    expect((await open('Review the fix', `Review ${pull}`)).ok).toBe(true);
    expect((await open('Review the next', 'Review synthetic/proof#8')).ok).toBe(true);
    expect((await open('Tidy the notes', 'No reference here')).ok).toBe(true);
    expect((await open('Their review', `Review ${pull}`, as('neo-b'))).ok).toBe(true);
    expect(store.listOpenAsks()).toHaveLength(4);
  });

  test('the pull request can be asked about again once the first ask is settled', async () => {
    const { call, open } = setup();
    const first = await open('Review the fix', `Review ${pull}`);
    if (!first.ok) throw new Error(first.reason);
    expect((await open('Deploy the fix', `Deploy ${pull}`)).ok).toBe(false);
    const settled = await call('neo.ask.settle', {
      askId: first.ask.id,
      status: 'dropped',
      outcome: 'Not needed',
    });
    expect(settled.ok).toBe(true);
    const again = await open('Deploy the fix', `Deploy ${pull}`);
    if (!again.ok) throw new Error(again.reason);
    expect(again.ask.id).not.toBe(first.ask.id);
  });
});
