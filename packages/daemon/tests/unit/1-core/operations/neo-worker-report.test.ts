import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import { createTestDb } from '../../../helpers/database.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  createSendMessageOperation,
  type SessionSent,
} from '../../../../src/lib/messaging/message-send.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { WorkRefSchema, WorkSummarySchema } from '../../../../src/lib/drivers/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expireMailboxEntries } from '../../../../src/lib/mailbox/expire.ts';
import { MAX_IMAGE_BASE64_SIZE } from '../../../../src/lib/session/message-persistence.ts';
import { vi } from 'vitest';

async function setup() {
  const db = await createTestDb();
  const ref = { adapter: 'hyperneo', id: 'worker' };
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.status',
      description: 'Synthetic worker',
      inputSchema: z.object({ ref: WorkRefSchema }),
      resultSchema: z.object({ ok: z.literal(true), value: WorkSummarySchema }),
      policy: { safetyClass: 'read' },
      execute: async () => ({
        ok: true as const,
        value: {
          ref,
          title: 'Quiet worker',
          place: { machine: 'test', name: 'Test' },
          status: 'stopped',
          lastActivityAt: 1,
        },
      }),
    }),
  ]);
  const service = createNeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.repo.reserveBinding({ sessionId: 'neo', projectId: null, kind: 'neo' });
  service.todos.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Plan',
    request: 'Plan',
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    { title: 'Build', doneWhen: 'Done', instruction: 'Stay quiet', check: null, named: null },
    1
  );
  service.todoSessions.bind(todo.id, ref, 2);
  service.todos.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const observed: SessionSent[] = [];
  const operation = () =>
    createSendMessageOperation(
      db.getJobQueueRepo(),
      () => 'active',
      undefined,
      undefined,
      undefined,
      async (sent) => {
        observed.push(sent);
      },
      (id) => id === 'neo',
      (...args) => service.handleWorkerQuestion(...args)
    );
  const send = (input: unknown, sender = 'worker') =>
    invokeOperation(createOperationRegistry([operation()]), 'message.send', input, {
      source: 'mcp',
      sessionId: sender,
    });
  return { db, service, send, observed };
}

const input = {
  to: 'neo',
  kind: 'blocked',
  text: 'Original blocker report',
  question: {
    todoId: 'todo',
    title: 'Choose a destination',
    options: ['Staging', 'Production'],
    language: 'en',
  },
};

test('oversized images are rejected by input projection before either handled or ordinary delivery', async () => {
  const { db, service, send } = await setup();
  try {
    const message = {
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'a'.repeat(MAX_IMAGE_BASE64_SIZE + 1),
            },
          },
        ],
      },
      parent_tool_use_id: null,
    };
    for (const sessionId of ['neo', 'ordinary'])
      expect(await send({ sessionId, kind: 'blocked', message })).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(service.todos.getTodo('todo')?.state).toBe('doing');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(0);
  } finally {
    service.dispose();
    db.close();
  }
});

test.each([false, true])(
  'consumed report recurrence keeps card-bound=%s semantics after cleanup',
  async (cardBound) => {
    const { db, service, send } = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      db.getDatabase()
        .prepare(
          "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('neo','Neo','/synthetic','2026-10-25','2026-10-25','active','{}','{}')"
        )
        .run();
      const { question: _question, ...legacy } = input;
      const report = cardBound ? input : legacy;
      const first = await send(report);
      if (first.kind !== 'completed' || first.value.kind !== 'accepted')
        throw new Error(JSON.stringify(first));
      const job = db.getJobQueueRepo().dequeue('mailbox')[0];
      await db.saveUserMessage(
        'neo',
        {
          type: 'user',
          uuid: first.value.messageId,
          session_id: 'neo',
          parent_tool_use_id: null,
          message: { role: 'user', content: input.text },
        },
        'consumed'
      );
      db.getJobQueueRepo().complete(job.id, {});
      clock.mockReturnValue(now + 9 * 60_000);
      expect(await send(report)).toEqual(first);
      db.getJobQueueRepo().cleanup(Date.now());
      expect(await send(report)).toEqual(first);
      clock.mockReturnValue(now + 11 * 60_000);
      const repeated = await send(report);
      if (cardBound) expect(repeated).toEqual(first);
      else {
        expect(repeated).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
        expect(repeated).not.toEqual(first);
        expect(await send(report)).toEqual(repeated);
        expect(
          db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
        ).toHaveLength(1);
      }
    } finally {
      clock.mockRestore();
      service.dispose();
      db.close();
    }
  }
);

test.each(['dead', 'expired', 'cleaned'] as const)(
  'an undelivered %s incident wake can recover without another card',
  async (mode) => {
    const { db, service, send } = await setup();
    try {
      const first = await send(input);
      const jobs = db.getJobQueueRepo();
      const old = jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })[0];
      if (mode === 'expired')
        await expireMailboxEntries({ jobQueue: jobs, now: Date.now() + 25 * 60 * 60_000 });
      else jobs.markDead(old.id, 'synthetic delivery failure');
      if (mode === 'cleaned') jobs.cleanup(Date.now() + 1);
      const recovered = await send(input);
      expect(recovered).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
      expect(recovered).not.toEqual(first);
      expect(service.todos.listQuestions('ask')).toHaveLength(1);
      expect(service.todos.getTodo('todo')?.blockedBy).toBe('needs-human');
      expect(jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })).toHaveLength(1);
      expect(await send(input)).toEqual(recovered);
      const second = jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })[0];
      jobs.markDead(second.id, 'second synthetic delivery failure');
      const third = await send(input);
      expect(third).not.toEqual(recovered);
      expect(jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })).toHaveLength(1);
    } finally {
      service.dispose();
      db.close();
    }
  }
);

test('handled card reports still notify the sent observer with the original report', async () => {
  const { db, service, send, observed } = await setup();
  try {
    expect(await send(input)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(observed).toEqual([
      expect.objectContaining({ fromSession: 'worker', toSession: 'neo', text: input.text }),
    ]);
  } finally {
    service.dispose();
    db.close();
  }
});

test('a dead ambiguous triage wake can be replaced without creating a card', async () => {
  const { db, service, send } = await setup();
  try {
    const { question: _question, ...legacy } = input;
    const first = await send(legacy);
    const jobs = db.getJobQueueRepo();
    jobs.markDead(
      jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })[0].id,
      'synthetic triage failure'
    );
    const recovered = await send(legacy);
    expect(recovered).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(recovered).not.toEqual(first);
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(jobs.listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })).toHaveLength(1);
    expect(await send(legacy)).toEqual(recovered);
  } finally {
    service.dispose();
    db.close();
  }
});

test('distinct image-only envelope reports retain their media and receive different incident receipts', async () => {
  const { db, service, send } = await setup();
  try {
    const image = (data: string) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data },
    });
    const report = (data: string) => ({
      sessionId: 'neo',
      kind: 'blocked',
      message: { type: 'user', message: { content: [image(data)] }, parent_tool_use_id: null },
    });
    const first = await send(report('aGVsbG8='));
    const second = await send(report('d29ybGQ='));
    expect(first).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(second).not.toEqual(first);
    const jobs = db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].payload.message).toMatchObject({
      message: { content: expect.arrayContaining([image('aGVsbG8=')]) },
    });
    expect(jobs[1].payload.message).toMatchObject({
      message: { content: expect.arrayContaining([image('d29ybGQ=')]) },
    });
    expect(await send(report('aGVsbG8='))).toEqual(first);
  } finally {
    service.dispose();
    db.close();
  }
});

test('quiet worker blockers immediately create a held card with one durable wake across repeats and operation reconstruction', async () => {
  const { db, service, send } = await setup();
  try {
    const first = await send(input);
    expect(first).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(service.todos.listQuestions('ask')).toHaveLength(1);
    expect(service.todos.getTodo('todo')).toMatchObject({
      state: 'blocked',
      blockedBy: 'needs-human',
    });
    const repeats = await Promise.all(
      Array.from({ length: 8 }, () => send({ ...input, text: 'Repeated blocker' }))
    );
    expect(
      repeats.every(
        (r) =>
          r.kind === 'completed' &&
          JSON.stringify(r.value) ===
            JSON.stringify(first.kind === 'completed' ? first.value : null)
      )
    ).toBe(true);
    expect(service.todos.listQuestions('ask')).toHaveLength(1);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});

test('a worker cannot place a hold or create a card for another assigned worker', async () => {
  const { db, service, send } = await setup();
  try {
    expect(await send(input, 'stranger')).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected' },
    });
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(service.todos.getTodo('todo')?.state).toBe('doing');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(0);
  } finally {
    service.dispose();
    db.close();
  }
});

test('an old open card is reused and a failed wake rolls the new card and hold back', async () => {
  const { db, service, send } = await setup();
  try {
    db.getDatabase().exec(
      "CREATE TRIGGER fail_wake BEFORE INSERT ON message_send_receipts BEGIN SELECT RAISE(ABORT, 'wake failed'); END"
    );
    const failed = await send(input);
    expect(failed.kind).not.toBe('completed');
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(service.todos.getTodo('todo')?.state).toBe('doing');
    db.getDatabase().exec('DROP TRIGGER fail_wake');
    const old = service.todos.askQuestion(
      'old-card',
      'ask',
      {
        todoId: 'todo',
        text: 'Old question',
        kind: 'choice',
        options: ['One', 'Two'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    expect(await send(input)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(service.todos.listQuestions('ask').map((q) => q.id)).toEqual([old.id]);
    expect(service.todos.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});

test('a hold arriving during the runner status lookup prevents a stale reminder', async () => {
  const { db, service } = await setup();
  const sends: string[] = [];
  try {
    const ref = { adapter: 'hyperneo', id: 'worker' };
    db.getDatabase()
      .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
      .run(
        JSON.stringify({
          verb: 'start',
          adapter: 'hyperneo',
          place: { machine: 'test', name: 'Test' },
        }),
        'todo'
      );
    const runner = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db.getDatabase()).run.bind(gatewayFor(db.getDatabase())),
      store: service.todos,
      sessions: service.todoSessions,
      packs: () => [],
      changed: () => {},
      invoke: async (_caller, name, args) => {
        if (name === 'work.send') sends.push(name);
        if (name === 'work.status' && !('since' in args))
          service.todos.updateTodo(
            service.todos.getTodo('todo')!,
            {
              state: 'blocked',
              blockedBy: 'needs-human',
              blockedReason: 'Choose',
              nextAction: 'Answer',
            },
            Date.now()
          );
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: {
              ref,
              title: 'Worker',
              place: { machine: 'test', name: 'Test' },
              status: 'since' in args ? 'running' : 'stopped',
              lastActivityAt: Date.now() - 25 * 60_000,
            },
          },
        };
      },
      tell: async () => {
        sends.push('tell');
      },
    });
    await runner.refresh((message, error) => {
      throw new Error(`${message}: ${error}`);
    });
    expect(service.todos.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(sends).toEqual([]);
  } finally {
    service.dispose();
    db.close();
  }
});

test('legacy ambiguous blockers wake triage once and malformed card reports have no effects', async () => {
  const { db, service, send } = await setup();
  try {
    expect(
      await send({ ...input, question: { ...input.question, options: ['Only'] } })
    ).toMatchObject({ kind: 'completed', value: { kind: 'rejected' } });
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    const { question: _question, ...legacy } = input;
    expect(await send(legacy)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(await send(legacy)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});

test('repeating a large ambiguous report shares one wake despite fresh published references', async () => {
  const before = process.env.HYPERNEO_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'worker-report-files-'));
  process.env.HYPERNEO_DATA_DIR = root;
  const { db, service, send } = await setup();
  try {
    const legacy = { to: 'neo', kind: 'blocked', text: 'Original blocker\n'.repeat(400) };
    const first = await send(legacy);
    expect(first).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'accepted',
        files: [expect.objectContaining({ byteLength: Buffer.byteLength(legacy.text) })],
      },
    });
    const wake = db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })[0];
    expect(JSON.stringify(wake.payload)).not.toContain(JSON.stringify(legacy.text).slice(1, -1));
    expect(JSON.stringify(wake.payload)).toContain('handoff.read');
    expect(await send(legacy)).toEqual(first);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
    if (before === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});
