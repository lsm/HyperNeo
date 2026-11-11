import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import type { WorkAdapter, WorkStatus } from '../../../../src/lib/drivers/types.ts';
import { createWorkerInputDelivery } from '../../../../src/lib/drivers/worker-input-delivery.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: 'synthetic-neo' };

function fixture(adapterId = 'codex-desktop', overrides: Partial<WorkAdapter> = {}) {
  const ref = { adapter: adapterId, id: 'synthetic-worker' };
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db, () => {});
  createTables(db);
  let status: WorkStatus = 'running';
  let question = false;
  const sent: string[] = [];
  const reports: string[] = [];
  let reportUnavailable = false;
  const adapter = {
    id: ref.adapter,
    capabilities: ['send', 'steer', 'queue', 'status'],
    find: () => [],
    status: async () => ({
      ok: true,
      value: {
        ref,
        title: 'Synthetic worker',
        place: {
          machine: 'synthetic',
          name: 'Synthetic workspace',
          folder: '/tmp/synthetic-worker',
        },
        status,
        lastActivityAt: 1,
        ...(question
          ? { turnQuestion: { id: 'synthetic-question', at: 1, text: 'Proceed?', actions: [] } }
          : {}),
      },
    }),
    send: async (_ref: unknown, text: string) => {
      sent.push(text);
      return { ok: true, value: { delivered: true, confirmedAt: Date.now() } };
    },
    steer: async (_ref: unknown, text: string) => {
      sent.push(text);
      return { ok: true, value: { delivered: true } };
    },
    ...overrides,
  } as unknown as WorkAdapter;
  const deps = {
    adapters: () => [adapter],
    remote: { list: () => [], invoke: async () => ({}) },
    daemonName: 'synthetic',
    isOpenTodo: () => true,
  };
  const delivery = createWorkerInputDelivery(db, deps, async (_id, detail) => {
    if (reportUnavailable) throw new Error('Synthetic report receiver is unavailable');
    reports.push(detail);
  });
  const registry = createOperationRegistry(
    createWorkVerbOperations({ ...deps, queueInput: delivery.accept })
  );
  const jobs = new JobQueueRepository(db);
  const tick = async () => {
    db.prepare("UPDATE job_queue SET run_at = 0 WHERE queue = 'worker_input'").run();
    for (const job of jobs.dequeue('worker_input', 10)) await delivery.run(job);
  };
  const send = (message: string, mode?: 'steer') =>
    invokeOperation(
      registry,
      'work.send',
      { ref, notice: true, message, ...(mode ? { mode } : {}) },
      caller
    );
  return {
    db,
    sent,
    reports,
    setReportUnavailable: (value: boolean) => {
      reportUnavailable = value;
    },
    jobs,
    send,
    tick,
    delivery,
    adapter,
    registry,
    ref,
    seedTodo: () => {
      const store = new NeoAskTodoRepository(db);
      store.openAsk({
        id: 'synthetic-ask',
        title: 'Queue follow-ups',
        request: 'Synthetic queue proof',
        sessionId: caller.sessionId,
        projectId: null,
        originMessageId: null,
        createdAt: 1,
      });
      const todo = store.addTodo(
        'synthetic-todo',
        'synthetic-ask',
        {
          title: 'Synthetic todo',
          instruction: 'Original instruction',
          approvedAt: 1,
          dependsOn: [],
          named: null,
          check: null,
          doneWhen: 'Synthetic result observed',
        },
        1
      );
      const sessions = new NeoTodoSessionRepository(db);
      sessions.create(todo.id, { verb: 'start', adapter: adapterId });
      const runner = createNeoTodoRunner({
        store,
        sessions,
        write: gatewayFor(db).run.bind(gatewayFor(db)),
        invoke: (caller, name, input) => invokeOperation(registry, name, input, caller),
        packs: () => [],
        tell: async () => {},
        changed: () => {},
        limits: () => ({ running: 1, perGroup: 1 }),
        queueFollowUp: (todoId, message, origin, ref) =>
          delivery.accept({ todoId, message, ref, continuation: true }, origin, caller),
      });
      return { store, sessions, todo, runner };
    },
    setStatus: (next: WorkStatus, asks = false) => {
      status = next;
      question = asks;
    },
  };
}

describe('durable worker follow-ups', () => {
  test('busy worker follow-up is kept and delivered after the turn', async () => {
    const h = fixture();
    const accepted = await h.send('Keep this exact follow-up');
    expect(accepted).toMatchObject({
      kind: 'completed',
      value: { ok: true, value: { delivered: false, inputId: expect.any(String) } },
    });
    await h.tick();
    expect(h.sent).toEqual([]);
    expect(h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get()).toEqual({
      message: 'Keep this exact follow-up',
      outcome: null,
    });
    h.setStatus('done');
    await h.tick();
    expect(h.sent.join('\n')).toContain('Keep this exact follow-up');
    expect(h.jobs.listJobs({ queue: 'worker_input' })[0].status).toBe('completed');
  });

  test('question-stop answer is delivered immediately', async () => {
    const h = fixture();
    h.setStatus('needs_you', true);
    await h.send('Yes, proceed');
    await h.tick();
    expect(h.sent.join('\n')).toContain('Yes, proceed');
  });

  test('steer is still immediate', async () => {
    const h = fixture();
    await h.send('Correct the current turn', 'steer');
    expect(h.sent.join('\n')).toContain('Correct the current turn');
    expect(h.jobs.listJobs({ queue: 'worker_input' })).toEqual([]);
  });

  test('two different follow-ups retain their order and do not expire while waiting', async () => {
    const h = fixture();
    await h.send('First follow-up');
    await h.send('Second follow-up');
    await h.tick();
    expect(new WorkDeliveryInputRepository(h.db).due(Date.now() + 60_000)).toEqual([]);
    h.setStatus('done');
    await h.tick();
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toContain('First follow-up');
    expect(h.sent[1]).toContain('Second follow-up');
  });
  test('a live human prompt is refused and the input is retained', async () => {
    const h = fixture();
    h.setStatus('needs_you');
    await h.send('This cannot answer a permission prompt');
    await h.tick();
    expect(h.sent).toEqual([]);
    expect(h.reports).toHaveLength(1);
    expect(h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get()).toMatchObject({
      message: 'This cannot answer a permission prompt',
      outcome: expect.stringContaining('needs_you'),
    });
  });

  test('a dispatched input recovered without confirmation is reported once and never replayed', async () => {
    const h = fixture();
    h.setStatus('done');
    await h.send('Keep the uncertain original');
    const job = h.jobs.dequeue('worker_input', 1)[0];
    h.db
      .prepare(
        "UPDATE job_queue SET payload = json_set(payload, '$.dispatched', json('true')) WHERE id = ?"
      )
      .run(job.id);
    h.jobs.requeueWaiting(job.id, 0, job.claimToken!);
    await h.tick();
    await h.tick();
    expect(h.sent).toEqual([]);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toContain('may not have reached');
    expect(h.db.prepare('SELECT message FROM work_delivery_inputs').get()).toEqual({
      message: 'Keep the uncertain original',
    });
  });

  test('input acceptance rolls back when inserting its job fails', async () => {
    const h = fixture();
    h.db.exec(
      "CREATE TRIGGER reject_worker_input BEFORE INSERT ON job_queue WHEN NEW.queue = 'worker_input' BEGIN SELECT RAISE(ABORT, 'synthetic acceptance failure'); END"
    );
    const result = await h.send('Must not be partially accepted');
    expect(result).toMatchObject({ kind: 'failed' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get()).toEqual({ n: 0 });
    expect(h.sent).toEqual([]);
  });

  test.each(['codex-desktop', 'claude-desktop', 'claude-code', 'hyperneo'])(
    '%s waits only while running or queued',
    async (adapter) => {
      const h = fixture(adapter);
      h.setStatus('queued');
      await h.send('Retain this follow-up');
      await h.tick();
      expect(h.sent).toEqual([]);
      h.setStatus('done');
      await h.tick();
      expect(h.sent).toHaveLength(1);
    }
  );

  test('a follow-up saved before startup follows the original instruction after binding', async () => {
    const h = fixture();
    const { todo, sessions, runner } = h.seedTodo();
    h.setStatus('done');
    const accepted = await runner.proceed(todo.id, 'Follow-up before startup');
    expect(accepted).toMatchObject({ ok: true, records: [expect.stringContaining('queued:')] });
    await h.tick();
    expect(h.sent).toEqual([]);
    sessions.recordRef(todo.id, h.ref);
    await h.delivery.accept(
      { todoId: todo.id, ref: h.ref, message: 'Original instruction' },
      'neo:synthetic-neo',
      caller
    );
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toContain('Original instruction');
    expect(h.sent[1]).toContain('Follow-up before startup');
  });
  test('continue keeps the current report until its saved follow-up is dispatched', async () => {
    const h = fixture();
    const { todo, sessions, store, runner } = h.seedTodo();
    sessions.recordRef(todo.id, h.ref, 1);
    store.updateTodo(
      todo,
      { state: 'doing', report: 'Retained earlier report', evidence: 'Earlier evidence' },
      Date.now()
    );
    const accepted = await runner.proceed(todo.id, 'Continue the same todo');
    expect(accepted).toMatchObject({ ok: true, records: [expect.stringContaining('queued:')] });
    await h.tick();
    expect(store.getTodo(todo.id)?.report).toBe('Retained earlier report');
    expect(h.sent).toEqual([]);
    h.setStatus('done');
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(store.getTodo(todo.id)?.report).toBeNull();
  });

  test('continue refuses a live human prompt before accepting an input', async () => {
    const h = fixture();
    const { todo, sessions, store, runner } = h.seedTodo();
    sessions.recordRef(todo.id, h.ref, 1);
    store.updateTodo(todo, { state: 'doing' }, Date.now());
    h.setStatus('needs_you');
    const result = await runner.proceed(todo.id, 'Cannot answer this live prompt');
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('needs_you') });
    expect(h.jobs.listJobs({ queue: 'worker_input' })).toEqual([]);
  });
  test('unreachable status retains the input and reason without spending retries', async () => {
    const h = fixture('codex-desktop', {
      status: async () => ({
        ok: false,
        reason: 'unreachable',
        detail: 'Synthetic receiver is offline',
      }),
    });
    await h.send('Wait for this receiver');
    await h.tick();
    await h.tick();
    expect(h.sent).toEqual([]);
    expect(h.jobs.listJobs({ queue: 'worker_input' })[0]).toMatchObject({
      status: 'pending',
      retryCount: 0,
      error: 'Synthetic receiver is offline',
    });
  });

  test.each(['unreachable', 'unknown'] as const)(
    'an input for an %s worker is kept and its reason is reported once',
    async (state) => {
      let recovered = false;
      const h = fixture('codex-desktop', {
        status: async () =>
          recovered
            ? {
                ok: true,
                value: {
                  ref: { adapter: 'codex-desktop', id: 'synthetic-worker' },
                  title: 'Synthetic worker',
                  place: { machine: 'synthetic', name: 'Synthetic workspace' },
                  status: 'done',
                  lastActivityAt: 1,
                },
              }
            : state === 'unreachable'
              ? { ok: false, reason: 'unreachable', detail: 'Synthetic receiver is offline' }
              : ({ ok: true, value: {} } as never),
      });
      await h.send('Retain this waiting input');
      h.setReportUnavailable(true);
      await h.tick();
      expect(h.reports).toEqual([]);
      h.setReportUnavailable(false);
      await h.tick();
      expect(h.reports).toEqual([
        state === 'unreachable' ? 'Synthetic receiver is offline' : 'Worker status is unavailable.',
      ]);
      await h.tick();
      expect(h.reports).toHaveLength(1);
      expect(h.sent).toEqual([]);
      expect(h.jobs.listJobs({ queue: 'worker_input' })[0]).toMatchObject({
        status: 'pending',
        retryCount: 0,
      });
      expect(h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get()).toMatchObject(
        {
          message: 'Retain this waiting input',
          outcome: null,
        }
      );
      recovered = true;
      await h.tick();
      expect(h.sent).toHaveLength(1);
      expect(h.reports).toHaveLength(1);
    }
  );

  test('work.queue retains an input and releases it through ordinary send after the turn', async () => {
    const h = fixture('codex-desktop', {
      queue: async () => {
        throw new Error('Unexpected native queue submission');
      },
    });
    const result = await invokeOperation(
      h.registry,
      'work.queue',
      { ref: h.ref, notice: true, message: 'Queued through the daemon' },
      caller
    );
    expect(result).toMatchObject({
      value: { ok: true, value: { delivered: false, inputId: expect.any(String) } },
    });
    await h.tick();
    expect(h.sent).toEqual([]);
    h.setStatus('done');
    await h.tick();
    expect(h.sent).toHaveLength(1);
  });
  test('continue can reopen a completed todo after its accepted follow-up is dispatched', async () => {
    const h = fixture();
    const { todo, sessions, store, runner } = h.seedTodo();
    sessions.recordRef(todo.id, h.ref, 1);
    store.updateTodo(todo, { state: 'done', report: 'Previous result' }, Date.now());
    h.setStatus('done');
    expect(await runner.proceed(todo.id, 'One more change')).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)?.state).toBe('done');
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(store.getTodo(todo.id)?.state).toBe('doing');
  });
  test('a deferred native refusal is retained and reported to Neo', async () => {
    let attempts = 0;
    const h = fixture('claude-desktop', {
      send: async () => {
        attempts++;
        return { ok: false, reason: 'claude_cli_login_expired', detail: 'Synthetic login expired' };
      },
    });
    h.setStatus('done');
    await h.send('Refused native input');
    await h.tick();
    expect(h.reports).toEqual(['claude_cli_login_expired: Synthetic login expired']);
    expect(h.jobs.listJobs({ queue: 'worker_input' })[0].status).toBe('completed');
    expect(h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get()).toMatchObject({
      message: 'Refused native input',
      outcome: expect.stringContaining('claude_cli_login_expired'),
    });
    await h.tick();
    expect(attempts).toBe(1);
  });

  test.each(['prompt', 'interrupted', 'throw'] as const)(
    'a %s failure survives unavailable reporting and is reported after recovery',
    async (failure) => {
      let attempts = 0;
      const h = fixture(
        'codex-desktop',
        failure === 'throw'
          ? {
              send: async () => {
                attempts++;
                throw new Error('Synthetic transport disconnected');
              },
            }
          : {}
      );
      h.setReportUnavailable(true);
      h.setStatus(failure === 'prompt' ? 'needs_you' : 'done');
      await h.send('Retain failed input');
      if (failure === 'interrupted') {
        const job = h.jobs.dequeue('worker_input', 1)[0];
        h.db
          .prepare(
            "UPDATE job_queue SET payload = json_set(payload, '$.dispatched', json('true')) WHERE id = ?"
          )
          .run(job.id);
        h.jobs.requeueWaiting(job.id, 0, job.claimToken!);
      }
      await h.tick();
      const retained = h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get();
      expect(retained).toMatchObject({
        message: 'Retain failed input',
        outcome: expect.any(String),
      });
      expect(h.jobs.listJobs({ queue: 'worker_input' })[0]).toMatchObject({
        status: 'pending',
        retryCount: 0,
      });
      await h.tick();
      expect(h.jobs.listJobs({ queue: 'worker_input' })[0]).toMatchObject({
        status: 'pending',
        retryCount: 0,
      });
      h.setReportUnavailable(false);
      h.setStatus('done');
      await h.tick();
      await h.tick();
      expect(h.reports).toHaveLength(1);
      expect(h.sent).toEqual([]);
      expect(attempts).toBe(failure === 'throw' ? 1 : 0);
      expect(h.jobs.listJobs({ queue: 'worker_input' })[0].status).toBe('completed');
      expect(h.db.prepare('SELECT message, outcome FROM work_delivery_inputs').get()).toEqual(
        retained
      );
    }
  );
});
