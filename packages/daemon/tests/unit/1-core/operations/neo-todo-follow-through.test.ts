import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const MIN = 60_000;
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function world() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  for (const [id, originMessageId] of [
    ['ask', 'm1'],
    ['tracked', 'neo-track:session:tracked'],
  ])
    store.openAsk({
      id,
      projectId: null,
      sessionId: 'neo',
      originMessageId,
      title: 'Ship it',
      request: 'Ship it',
      createdAt: 1,
    });
  const base = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
  const workers = new Map<string, { lastActivityAt: number; replies: boolean; status?: string }>();
  const knobs = {
    stopRefused: false,
    tellRefused: false,
    placeKnown: true,
    startRefused: false,
    sendRefused: false,
    onSend: null as null | (() => void),
    onTell: null as null | (() => void),
    onStatus: null as null | (() => void),
  };
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: string[] = [];
  let started = 0;
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 6, perGroup: 3 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      calls.push({ name, input });
      const id = (input.ref as { id?: string } | undefined)?.id ?? '';
      if (name === 'work.start' && knobs.startRefused)
        return completed({ ok: false, reason: 'invalid_place', detail: 'synthetic place refusal' });
      if (name === 'work.start') {
        const ref = { adapter: 'hyperneo', id: `worker-${++started}` };
        workers.set(ref.id, { lastActivityAt: Date.now(), replies: false });
        return completed({
          ok: true,
          value: { ref, receipt: { executionId: ref.id, inputId: `in-${started}` } },
        });
      }
      if (name === 'work.send') {
        const worker = workers.get(id);
        knobs.onSend?.();
        if (knobs.sendRefused)
          return completed({
            ok: false,
            reason: 'not_delivered',
            detail: 'thread-follower-steer-turn-timeout',
            notSent: true,
          });
        if (worker?.replies) worker.lastActivityAt = Date.now();
        return completed({ ok: true, value: { delivered: true } });
      }
      if (name === 'work.find')
        return completed({
          unreachable: [],
          places: knobs.placeKnown
            ? [
                {
                  place: { machine: 'laptop', name: 'repo', folder: '/repo' },
                  work: [
                    {
                      ref: { adapter: 'hyperneo', id: input.id },
                      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
                    },
                  ],
                },
              ]
            : [],
        });
      if (name === 'work.stop')
        return completed(
          knobs.stopRefused
            ? { ok: false, reason: 'refused', detail: 'synthetic stop refusal' }
            : { ok: true, value: {} }
        );
      const worker = workers.get(id);
      knobs.onStatus?.();
      return completed({
        ok: true,
        value: {
          status: worker?.status ?? 'done',
          lastActivityAt: worker?.lastActivityAt ?? base,
          lastReplyAt: worker?.lastActivityAt ?? base,
        },
      });
    },
    packs: () => [],
    tell: async (_ask, _todo, note) => {
      if (knobs.tellRefused) throw new Error('synthetic notification refusal');
      knobs.onTell?.();
      told.push(note);
    },
    changed: () => {},
  });
  const add = (instruction: string | null = 'Build the rows.') => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Rows', doneWhen: 'PR merged', check: null, instruction, named: null },
      base
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    return todo;
  };
  const adopt = (instruction: string | null, askId = 'ask') => {
    const ref = { adapter: 'hyperneo', id: 'adopted-session' };
    workers.set(ref.id, { lastActivityAt: base, replies: false });
    const todo = store.addTodo(
      crypto.randomUUID(),
      askId,
      { title: 'Watch it', doneWhen: 'PR merged', check: null, instruction, named: null },
      base
    );
    sessions.create(todo.id, { verb: 'adopt', ref });
    sessions.recordRef(todo.id, ref, base);
    store.updateTodo(todo, { state: 'doing', startedAt: base }, base);
    return todo;
  };
  const at = async (minutes: number) => {
    clock.mockReturnValue(base + minutes * MIN);
    await runner.refresh(() => {});
  };
  const named = (name: string) => calls.filter((call) => call.name === name);
  const todo = (id: string) => store.getTodo(id) as NeoTodo;
  return { db, store, sessions, runner, workers, knobs, told, add, adopt, at, named, todo, clock };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.clock.mockRestore();
  current?.db.close();
  current = null;
});

describe('a doing todo never sits idle without someone on it', () => {
  test('an idle worker is reminded, then the todo goes to a fresh worker once, then stalls loudly', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    expect(w.named('work.send')).toHaveLength(2);
    expect(w.named('work.start')).toHaveLength(2);
    expect(w.named('work.stop').map((call) => call.input.ref)).toEqual([
      { adapter: 'hyperneo', id: 'worker-1' },
    ]);
    expect(w.todo(todo.id).state).toBe('doing');

    for (const minutes of [80, 100, 120]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(2);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
    const stalled = w.told.filter((note) => note.includes('stalled'));
    expect(stalled).toHaveLength(1);

    for (const minutes of [180, 300]) await w.at(minutes);
    expect(w.told.filter((note) => note.includes('stalled'))).toHaveLength(1);
    expect(w.named('work.start')).toHaveLength(2);
  });

  test('a worker that answers every reminder without progress still escalates', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    w.workers.get('worker-1')!.replies = true;
    for (const minutes of [20, 40, 60, 80, 100, 120]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(2);
  });

  for (const instruction of [null, 'Keep an eye on it.'])
    test(`an adopted worker ${instruction ? 'with' : 'without'} an instruction is reminded, then stalls with no fresh worker to take it`, async () => {
      const w = (current = world());
      w.knobs.placeKnown = false;
      const todo = w.adopt(instruction);
      for (const minutes of [20, 40, 60]) await w.at(minutes);
      expect(w.named('work.send')).toHaveLength(2);
      expect(w.named('work.start')).toEqual([]);
      expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
      expect(w.told.filter((note) => note.includes('stalled'))).toHaveLength(1);
    });

  test("the human's own tracked session gets nothing typed into it, and stalls after an hour idle", async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    expect(w.named('work.send')).toEqual([]);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
  });

  test('a stalled todo stays stalled when its state is recomputed with no change', async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    w.store.updateTodo(w.todo(todo.id), {}, Date.now());
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
  });

  test('a started todo without an instruction stalls instead of staying doing', async () => {
    const w = (current = world());
    w.knobs.placeKnown = false;
    const todo = w.add();
    await w.runner.start(todo.id);
    w.db.prepare('UPDATE neo_todos SET instruction = NULL WHERE id = ?').run(todo.id);
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(1);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
  });

  test('a refused stall note leaves the todo doing so the next pass tells Neo again', async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    w.knobs.tellRefused = true;
    await w.at(60);
    expect(w.todo(todo.id).state).toBe('doing');
    w.knobs.tellRefused = false;
    await w.at(61);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
    expect(w.told.filter((note) => note.includes('stalled'))).toHaveLength(1);
  });

  test('an idle worker that cannot be stopped is not doubled; the todo stalls instead', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    w.knobs.stopRefused = true;
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(1);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
    expect(w.told.some((note) => note.includes('moved it to a fresh worker'))).toBe(false);
  });

  test('a stalled todo goes back to doing when its worker runs again, on a fresh ladder', async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    await w.at(60);
    expect(w.todo(todo.id).blockedBy).toBe('stalled');
    Object.assign(w.workers.get('adopted-session')!, { status: 'running' });
    await w.at(65);
    expect(w.todo(todo.id).state).toBe('doing');
    Object.assign(w.workers.get('adopted-session')!, {
      status: 'done',
      lastActivityAt: Date.now(),
    });
    await w.at(100);
    expect(w.todo(todo.id).state).toBe('doing');
    await w.at(126);
    expect(w.todo(todo.id).blockedBy).toBe('stalled');
  });

  test('a todo waiting on an open human card waits on the human, then resumes on a fresh ladder after the answer', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    const card = w.store.askQuestion(
      'outreach-card',
      'ask',
      {
        kind: 'reply',
        text: 'May the outreach go out?',
        todoId: todo.id,
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: null,
      } as unknown as Parameters<typeof w.store.askQuestion>[2],
      Date.now()
    );
    for (const minutes of [20, 40, 60, 80, 120]) await w.at(minutes);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'question' });
    expect(w.named('work.send')).toHaveLength(0);
    expect(w.named('work.start')).toHaveLength(1);
    w.store.answerQuestion(card, [], 'button', Date.now());
    await w.at(130);
    expect(w.todo(todo.id).state).toBe('doing');
    await w.at(149);
    expect(w.named('work.send')).toHaveLength(0);
    await w.at(151);
    expect(w.named('work.send')).toHaveLength(1);
  });

  test('a card that opens while the sweep reads the worker stops the reminder', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    w.knobs.onStatus = () => {
      w.knobs.onStatus = null;
      w.store.askQuestion(
        'late-card',
        'ask',
        {
          kind: 'reply',
          text: 'Which wording?',
          todoId: todo.id,
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
          startTodos: null,
        } as unknown as Parameters<typeof w.store.askQuestion>[2],
        Date.now()
      );
    };
    await w.at(20);
    expect(w.named('work.send')).toHaveLength(0);
  });

  test("the daemon's own stalled card does not make a resumed todo wait on the human", async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    await w.at(60);
    expect(w.todo(todo.id).blockedBy).toBe('stalled');
    Object.assign(w.workers.get('adopted-session')!, { status: 'running' });
    await w.at(65);
    expect(w.todo(todo.id).state).toBe('doing');
    w.sessions.recordProgress(
      todo.id,
      { landed: null, live: { status: 'done', lastActivityAt: Date.now() }, cardStatus: 'done' },
      Date.now()
    );
    expect(w.store.updateTodo(w.todo(todo.id), {}, Date.now()).state).toBe('doing');
  });

  test("a retitled stalled todo still knows its card is the daemon's own", async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    await w.at(60);
    expect(w.todo(todo.id).blockedBy).toBe('stalled');
    w.store.updateTodo(w.todo(todo.id), { title: 'Watch the rollout' }, Date.now());
    await w.at(65);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
  });

  test('a stalled todo with an open human card waits on the human instead', async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    await w.at(60);
    expect(w.todo(todo.id).blockedBy).toBe('stalled');
    w.store.askQuestion(
      'approval-card',
      'tracked',
      {
        kind: 'reply',
        text: 'Approve the outreach?',
        todoId: todo.id,
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: null,
      } as unknown as Parameters<typeof w.store.askQuestion>[2],
      Date.now()
    );
    await w.at(65);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'question' });
    await w.at(200);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'question' });
  });

  test('a backlog of long-idle workers is moved to fresh workers one per sweep', async () => {
    const w = (current = world());
    const ids = [w.add(), w.add(), w.add()].map((todo) => todo.id);
    for (const id of ids) await w.runner.start(id);
    await w.at(90);
    expect(w.named('work.start')).toHaveLength(4);
    await w.at(91);
    expect(w.named('work.start')).toHaveLength(5);
  });

  test('no idle worker is replaced while six todo workers are already running', async () => {
    const w = (current = world());
    for (let index = 0; index < 6; index++) {
      const busy = w.add();
      await w.runner.start(busy.id);
      w.sessions.recordLive(busy.id, 'running', undefined);
      w.workers.get(`worker-${index + 1}`)!.status = 'running';
    }
    const idle = w.add();
    await w.runner.start(idle.id);
    for (const minutes of [20, 40, 60, 61]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(7);
    expect(w.todo(idle.id).state).toBe('doing');
  });

  test('a todo whose old ladder already escalated keeps moving instead of staying doing', async () => {
    const w = (current = world());
    const todo = w.add();
    await w.runner.start(todo.id);
    w.sessions.recordNudge(todo.id, { since: Date.now(), nudges: 3 });
    await w.at(61);
    expect(w.named('work.start')).toHaveLength(2);
  });

  test('a sweep that starts before the last one ends cannot move a second todo the same minute', async () => {
    const w = (current = world());
    for (const todo of [w.add(), w.add(), w.add()]) await w.runner.start(todo.id);
    await w.at(90);
    await w.at(90.5);
    expect(w.named('work.start')).toHaveLength(4);
  });

  test('workers just started or still queued count toward the six-worker cap', async () => {
    const w = (current = world());
    for (let index = 0; index < 6; index++) {
      const busy = w.add();
      await w.runner.start(busy.id);
      w.workers.get(`worker-${index + 1}`)!.status = index % 2 ? 'queued' : 'running';
    }
    const idle = w.add();
    await w.runner.start(idle.id);
    for (const minutes of [20, 40, 60, 61]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(7);
  });

  test('a deferred re-dispatch leaves a ladder the human just restarted alone', async () => {
    const w = (current = world());
    for (let index = 0; index < 6; index++) {
      const busy = w.add();
      await w.runner.start(busy.id);
      w.sessions.recordLive(busy.id, 'running', undefined);
      w.workers.get(`worker-${index + 1}`)!.status = 'running';
    }
    const idle = w.add();
    await w.runner.start(idle.id);
    for (const minutes of [20, 40]) await w.at(minutes);
    const before = w.sessions.readNudge(idle.id);
    await w.at(60);
    expect(w.sessions.readNudge(idle.id)).toEqual(before);
  });

  test('a reminder the worker never receives moves the todo to a fresh worker at once', async () => {
    const w = (current = world());
    const todo = w.adopt(null);
    w.knobs.sendRefused = true;
    await w.at(20);
    expect(w.named('work.send')).toHaveLength(1);
    expect(w.named('work.start')).toHaveLength(1);
    expect(w.todo(todo.id).state).toBe('doing');
  });

  test('a todo finished while its reminder bounced is not reopened as stalled', async () => {
    const w = (current = world());
    const todo = w.adopt(null);
    w.knobs.sendRefused = true;
    w.knobs.onSend = () => {
      w.store.updateTodo(w.todo(todo.id), { state: 'done', evidence: 'Merged.' }, Date.now());
    };
    await w.at(20);
    expect(w.todo(todo.id).state).toBe('done');
    expect(w.told.filter((note) => note.includes('stalled'))).toEqual([]);
  });

  test('a stalled todo whose worker place is known gets a fresh worker there', async () => {
    const w = (current = world());
    const todo = w.adopt(null);
    for (const minutes of [20, 40, 60, 62]) await w.at(minutes);
    expect(w.named('work.start').map((call) => call.input.place)).toEqual([
      { machine: 'laptop', name: 'repo', folder: '/repo' },
    ]);
    expect(w.todo(todo.id).state).toBe('doing');
    expect(w.sessions.get(todo.id)).toMatchObject({ verb: 'start', adapter: 'hyperneo' });
  });

  test('a stalled todo with no known place puts one card in front of the human', async () => {
    const w = (current = world());
    w.knobs.placeKnown = false;
    const todo = w.adopt(null);
    for (const minutes of [20, 40, 60, 62, 64]) await w.at(minutes);
    expect(w.named('work.start')).toEqual([]);
    expect(w.named('work.find')).toHaveLength(1);
    expect(w.store.listQuestions('ask').filter((question) => question.todoId === todo.id)).toEqual([
      expect.objectContaining({ state: 'open', kind: 'reply' }),
    ]);
  });

  test("the human's own tracked session gets a card, not a fresh worker", async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    for (const minutes of [60, 62]) await w.at(minutes);
    expect(w.named('work.start')).toEqual([]);
    expect(
      w.store.listQuestions('tracked').filter((question) => question.todoId === todo.id)
    ).toHaveLength(1);
  });

  test('an answered stalled card is not asked again while the todo is unchanged', async () => {
    const w = (current = world());
    w.knobs.placeKnown = false;
    const todo = w.adopt(null);
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    const card = w.store.listQuestions('ask').find((question) => question.todoId === todo.id)!;
    w.store.answerQuestion(card, 'Leave it for now.', 'chat', Date.now());
    for (const minutes of [62, 64]) await w.at(minutes);
    expect(
      w.store.listQuestions('ask').filter((question) => question.todoId === todo.id)
    ).toHaveLength(1);
  });

  test('a stalled todo whose worker comes back is neither carded nor doubled', async () => {
    const w = (current = world());
    w.knobs.placeKnown = false;
    const todo = w.adopt(null, 'tracked');
    for (const minutes of [20, 40]) await w.at(minutes);
    w.store.updateTodo(
      w.todo(todo.id),
      {
        state: 'blocked',
        blockedBy: 'stalled',
        blockedReason: 'Idle.',
        nextAction: 'Continue it.',
      },
      Date.now()
    );
    Object.assign(w.workers.get('adopted-session')!, { status: 'running' });
    await w.at(41);
    expect(w.todo(todo.id).state).toBe('doing');
    expect(w.store.listQuestions('tracked')).toEqual([]);
  });

  test('a stalled todo whose fresh start is refused stays stalled and asks the human', async () => {
    const w = (current = world());
    w.knobs.startRefused = true;
    const todo = w.adopt(null);
    for (const minutes of [20, 40, 60]) await w.at(minutes);
    expect(w.named('work.start')).toHaveLength(1);
    expect(w.todo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
    expect(
      w.store.listQuestions('ask').filter((question) => question.todoId === todo.id)
    ).toHaveLength(1);
  });

  test('no place lookup runs while the worker cap blocks a rescue', async () => {
    const w = (current = world());
    for (let index = 0; index < 6; index++) {
      const busy = w.add();
      await w.runner.start(busy.id);
      w.sessions.recordLive(busy.id, 'running', undefined);
      w.workers.get(`worker-${index + 1}`)!.status = 'running';
    }
    w.adopt(null);
    for (const minutes of [20, 40, 60, 62]) await w.at(minutes);
    expect(w.named('work.find')).toEqual([]);
  });

  test('a todo finished while the stall note is being sent stays finished', async () => {
    const w = (current = world());
    const todo = w.adopt(null, 'tracked');
    w.knobs.onTell = () =>
      w.store.updateTodo(w.todo(todo.id), { state: 'done', evidence: 'Merged.' }, Date.now());
    await w.at(60);
    expect(w.todo(todo.id).state).toBe('done');
  });
});
