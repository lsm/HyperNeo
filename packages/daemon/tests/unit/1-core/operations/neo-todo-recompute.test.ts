import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoPack,
  NeoTodoCheckResult,
  NeoTodoJudgement,
} from '../../../../src/lib/neo/pack-contract.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0).reverse()) close();
});

function fixture(legacyCheck = false, legacyResult?: NeoTodoCheckResult) {
  const directory = mkdtempSync(join(tmpdir(), 'neo-todo-plan-'));
  closing.push(() => rmSync(directory, { recursive: true, force: true }));
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  const starts: string[] = [];
  let activity = 1;
  const facts = new Map<string, NeoTodoJudgement>();
  const receipt = { executionId: 'synthetic-worker', inputId: 'dispatched-input' };
  const pack = {
    id: 'synthetic',
    describe: 'Synthetic facts',
    readFacts: async (todo: NeoTodo) => facts.get(todo.id) ?? { state: 'no_opinion' },
    judge: (_todo: NeoTodo, read: unknown) => read as NeoTodoJudgement,
    todos: {
      schema: () => {},
      check: async (todo: NeoTodo) => {
        if (legacyResult) return legacyResult;
        const read = facts.get(todo.id);
        return {
          done: read?.state === 'done',
          evidence: read?.state === 'done' ? read.evidence : null,
          ...(read?.state === 'failed' ? { failed: read.reason } : {}),
          ...(read?.state === 'blocked'
            ? { blocked: { reason: read.reason, nextAction: 'Resolve the synthetic blocker' } }
            : {}),
        };
      },
      statusLine: () => null,
    },
  } satisfies NeoPack;
  const open = () => {
    db = new Database(join(directory, 'plan.db'));
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    if (!store.getAsk('ask'))
      store.openAsk({
        id: 'ask',
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: 'Complete ordered plan',
        request: 'Do every step',
        createdAt: 1,
      });
    return createNeoTodoRunner({
      store,
      sessions,
      packs: () => [legacyCheck ? { ...pack, readFacts: undefined, judge: undefined } : pack],
      invoke: async (_caller, name, input) => {
        if (name === 'work.start') {
          starts.push(String(input.message));
          return {
            kind: 'completed',
            value: {
              ok: true,
              value: {
                ref: { adapter: 'hyperneo', id: 'synthetic-worker' },
                receipt,
                lastActivityAt: Date.now(),
              },
            },
          };
        }
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: {
              status: activity === 1 ? 'stopped' : 'done',
              lastActivityAt: activity,
              ...(activity > 1
                ? {
                    inputEvidence: {
                      receipt,
                      state: 'observed',
                      exchangeCut: false,
                      exchange: [
                        { at: activity, role: 'agent', text: 'Complete synthetic report' },
                      ],
                    },
                    exchange: [
                      { at: activity - 1, role: 'user', text: starts.at(-1)! },
                      { at: activity, role: 'agent', text: 'Complete synthetic report' },
                    ],
                  }
                : {}),
              lastReply: 'Complete synthetic report',
            },
          },
        };
      },
      tell: async () => {},
      changed: () => {},
    });
  };
  let runner = open();
  closing.push(() => db.close());
  return {
    facts,
    starts,
    progress: () => {
      activity = Date.now() + 1;
    },
    get store() {
      return store;
    },
    get runner() {
      return runner;
    },
    add(id: string, state: NeoTodo['state'] = 'todo') {
      const todo = store.addTodo(
        id,
        'ask',
        {
          title: id,
          doneWhen: 'Synthetic facts met',
          check: { pack: 'synthetic', kind: 'met', params: {} },
          instruction: `Perform ${id}`,
          named: null,
        },
        1
      );
      sessions.create(id, {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'laptop', name: 'synthetic', folder: '/synthetic' },
      });
      if (state !== 'todo') store.updateTodo(todo, { state, report: 'Retain these bytes 🦊' }, 2);
    },
    restart() {
      db.close();
      runner = open();
    },
    refresh: () =>
      runner.refresh((message, error) => {
        throw new Error(message, { cause: error });
      }),
  };
}

describe('ordered ask progression from facts', () => {
  test('failure wins when a legacy check also reports done', async () => {
    const f = fixture(true, {
      done: true,
      failed: 'Observed failure',
      evidence: 'Conflicting success',
    });
    f.add('first', 'doing');
    await f.runner.checkNow(['first'], (_message, error) => {
      throw error;
    });
    expect(f.store.getTodo('first')).toMatchObject({ state: 'failed', reason: 'Observed failure' });
    expect(f.starts).toHaveLength(0);
  });
  test('a legacy pack check also supersedes a stale human hold', async () => {
    const f = fixture(true);
    f.add('first');
    f.store.updateTodo(
      f.store.getTodo('first')!,
      {
        state: 'blocked',
        blockedBy: 'needs-human',
        blockedReason: 'Old question',
        nextAction: 'Answer',
      },
      2
    );
    f.facts.set('first', { state: 'done', evidence: 'Observed completion' });
    await f.runner.checkNow(['first'], (_message, error) => {
      throw error;
    });
    expect(f.store.getTodo('first')).toMatchObject({
      state: 'done',
      blockedBy: null,
      evidence: 'Observed completion',
    });
  });
  test('done starts the next recorded todo through the existing dispatch path', async () => {
    const f = fixture();
    f.add('first');
    f.add('next');
    await f.runner.start('first');
    f.facts.set('first', { state: 'done', evidence: 'Observed completion' });
    await f.runner.checkNow(['first'], (_message, error) => {
      throw error;
    });
    expect(f.store.getTodo('first')?.state).toBe('done');
    expect(f.store.getTodo('next')?.state).toBe('doing');
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]).toContain('Perform next');
  });

  test.each(['done', 'closed_unverified'] as const)(
    'a %s close does not answer the next start card',
    async (state) => {
      const f = fixture();
      f.add('first');
      f.add('next');
      f.store.askQuestion(
        'start-next',
        'ask',
        {
          text: 'Start next?',
          kind: 'start',
          startTodos: ['next'],
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
        },
        Date.now()
      );
      await f.runner.recompute(f.store.getTodo('first')!, { state });
      expect(f.starts).toHaveLength(0);
      expect(f.store.getTodo('next')?.state).not.toBe('doing');
      expect(f.store.getQuestion('start-next')).toMatchObject({ state: 'open', answer: null });
    }
  );

  test('the final step completes without another start', async () => {
    const f = fixture();
    f.add('final');
    await f.runner.start('final');
    f.facts.set('final', { state: 'done', evidence: 'Final evidence' });
    await f.refresh();
    expect(f.store.getTodo('final')?.state).toBe('done');
    expect(f.starts).toHaveLength(1);
  });

  test('an unverified close advances the recorded next step without calling it done', async () => {
    const f = fixture();
    f.add('first');
    f.add('next');
    await f.runner.recompute(f.store.getTodo('first')!, {
      state: 'closed_unverified',
      reason: 'Outcome not checked',
    });
    expect(f.store.getTodo('first')?.state).toBe('closed_unverified');
    expect(f.store.getTodo('next')?.state).toBe('doing');
    expect(f.starts).toHaveLength(1);
  });

  test.each(['done', 'closed_unverified'] as const)(
    'restart completes a %s handoff exactly once across repeated facts',
    async (state) => {
      const f = fixture();
      f.add('first', state);
      f.add('next');
      f.restart();
      await f.refresh();
      await f.refresh();
      f.restart();
      await f.refresh();
      expect(f.store.getTodo('next')?.state).toBe('doing');
      expect(f.starts).toHaveLength(1);
      expect(f.store.getTodo('first')?.report).toBe('Retain these bytes 🦊');
    }
  );

  test.each(['failed', 'blocked'] as const)(
    '%s does not advance to a later todo',
    async (state) => {
      const f = fixture();
      f.add('previous', 'done');
      f.add('first', state);
      f.add('next');
      f.facts.set(
        'first',
        state === 'failed'
          ? { state: 'failed', reason: 'Synthetic failure' }
          : { state: 'blocked', reason: 'Synthetic blocker' }
      );
      await f.refresh();
      expect(f.store.getTodo('first')?.state).toBe(state);
      expect(f.store.getTodo('next')?.state).toBe('todo');
      expect(f.starts).toHaveLength(0);
    }
  );

  test('an ask question holds pending work without pausing an already dispatched worker', async () => {
    const f = fixture();
    f.add('running');
    f.add('pending');
    await f.runner.start('running');
    f.store.askQuestion(
      'question',
      'ask',
      {
        text: 'Choose the later step',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      Date.now()
    );
    await f.runner.checkNow(['running', 'pending'], (_message, error) => {
      throw error;
    });
    expect(f.store.getTodo('running')?.state).toBe('doing');
    expect(f.store.getTodo('pending')?.state).toBe('blocked');
    f.progress();
    await f.refresh();
    expect(f.store.getTodo('running')?.report).toContain('Complete synthetic report');
    expect(f.starts).toHaveLength(1);
  });

  test('removed stays removed despite done facts and restart', async () => {
    const f = fixture();
    f.add('removed', 'removed');
    f.facts.set('removed', { state: 'done', evidence: 'Late completion' });
    f.restart();
    await f.refresh();
    expect(f.store.getTodo('removed')?.state).toBe('removed');
    expect(f.store.getTodo('removed')?.report).toBe('Retain these bytes 🦊');
    expect(f.starts).toHaveLength(0);
  });
});
