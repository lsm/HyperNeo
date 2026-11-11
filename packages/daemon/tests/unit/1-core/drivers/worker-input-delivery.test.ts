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
const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: 'synthetic-neo' };

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  createTables(db);
  runMigrations(db);
  let status: WorkStatus = 'running';
  let question = false;
  const sent: string[] = [];
  const reports: string[] = [];
  const adapter = {
    id: ref.adapter,
    capabilities: ['send', 'steer', 'queue', 'status'],
    find: () => [],
    status: async () => ({
      ok: true,
      value: {
        ref,
        status,
        lastActivityAt: 1,
        ...(question ? { turnQuestion: { id: 'synthetic-question', text: 'Proceed?' } } : {}),
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
  } as unknown as WorkAdapter;
  const deps = {
    adapters: () => [adapter],
    remote: { list: () => [], invoke: async () => ({}) },
    daemonName: 'synthetic',
    isOpenTodo: () => true,
  };
  const delivery = createWorkerInputDelivery(db, deps, async (_id, detail) => {
    reports.push(detail);
  });
  const registry = createOperationRegistry(
    createWorkVerbOperations({ ...deps, queueInput: delivery.accept })
  );
  const jobs = new JobQueueRepository(db);
  const tick = async () => {
    db.prepare("UPDATE job_queue SET run_at = 0 WHERE queue = 'worker_input'").run();
    const job = jobs.dequeue('worker_input', 1)[0];
    if (job) await delivery.run(job);
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
    jobs,
    send,
    tick,
    delivery,
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
});
