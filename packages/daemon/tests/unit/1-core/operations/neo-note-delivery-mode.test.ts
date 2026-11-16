import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import { vi } from 'vitest';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { wakeStalledAsks } from '../../../../src/lib/neo/stalled-asks.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const rootId = 'neo:10000000-0000-4000-8000-000000000002';

describe('Neo daemon notes', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let workerStatus: string;
  let turnEnds: { id: string; at: number; message: string; notify?: false }[];
  let reopen: () => void;
  let sends: unknown[];

  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    await db.createSession({ ...createTestSession(rootId), workspacePath: null });
    turnEnds = [];
    sends = [];
    workerStatus = 'running';
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.send',
        description: 'Synthetic worker send',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'write' },
        execute: async (input) => {
          sends.push(input);
          return { ok: true, value: { delivered: true } };
        },
      }),
      defineOperation({
        name: 'work.status',
        description: 'Synthetic worker status',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          ok: true,
          value: { status: workerStatus, lastActivityAt: Date.now(), turnEnds },
        }),
      }),
    ]);
    reopen = () => {
      service = createNeoService(
        db,
        { getOperationRegistry: () => registry } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        events
      );
    };
    reopen();
    service.repo.reserveBinding({ sessionId: rootId, projectId: null, kind: 'neo' });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const turnReports = (queue: 'mailbox' | 'neo_notes') =>
    db
      .getJobQueueRepo()
      .listActiveByPayload(queue, { 'to.sessionId': rootId })
      .filter((job) =>
        /"content":"(Worker turn report|Focused discussion status only) /.test(
          JSON.stringify(job.payload.message)
        )
      );

  const queued = (messageId: string) =>
    db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': rootId, messageUuid: messageId })
      .map((job) => job.payload.deliveryMode);

  test('a stalled-ask nudge is persisted as a synthetic input and a finished todo adds no note', async () => {
    const now = Date.now();
    const ask = service.todos.openAsk({
      id: 'stalled-synthetic',
      sessionId: rootId,
      projectId: null,
      originMessageId: null,
      title: 'Stalled work',
      request: 'Complete the work',
      createdAt: now - 3 * 3_600_000,
    });
    await wakeStalledAsks(service.todos, service.deliverForward.bind(service), now);
    vi.spyOn(service, 'installedPacks').mockReturnValue([
      {
        id: 'synthetic-proof',
        describe: 'Synthetic completion fixture',
        todos: {
          schema: () => {},
          check: async () => ({ done: true, evidence: 'Observed' }),
          statusLine: () => null,
        },
      },
    ]);
    service.todos.addTodo(
      'synthetic-done',
      ask.id,
      {
        title: 'Synthetic task',
        doneWhen: 'Observed',
        instruction: null,
        named: null,
        check: { pack: 'synthetic-proof', kind: 'observed', params: {} },
      },
      now
    );
    await service.todoRunner.refresh((message, error) => {
      throw new Error(message, { cause: error });
    });
    const rows = db.getSDKMessages(rootId).messages;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: expect.stringMatching(/^neo-stalled-ask:/),
          inputKind: 'system',
          isSynthetic: true,
        }),
      ])
    );
    expect(service.todos.getTodo('synthetic-done')?.state).toBe('done');
    expect(JSON.stringify([rows, db.getJobQueueRepo().listJobs({})])).not.toContain('is done');
  });

  test('the last todo finishing is told once by the ask, with no done note', async () => {
    const now = Date.now();
    const ask = service.todos.openAsk({
      id: 'finished-synthetic',
      sessionId: rootId,
      projectId: null,
      originMessageId: null,
      title: 'Finished work',
      request: 'Complete the work',
      createdAt: now,
    });
    vi.spyOn(service, 'installedPacks').mockReturnValue([
      {
        id: 'synthetic-proof',
        describe: 'Synthetic completion fixture',
        instructions: () => null,
        todos: {
          schema: () => {},
          check: async () => ({ done: true, evidence: 'Observed' }),
          statusLine: () => null,
        },
      },
    ]);
    service.todos.addTodo(
      'synthetic-last',
      ask.id,
      {
        title: 'Synthetic task',
        doneWhen: 'Observed',
        instruction: null,
        named: null,
        check: { pack: 'synthetic-proof', kind: 'observed', params: {} },
      },
      now
    );
    const told = () =>
      db
        .getSDKMessages(rootId)
        .messages.map((row) => String((row as { message: { content: unknown } }).message.content));
    await wakeStalledAsks(service.todos, service.deliverForward.bind(service), now);
    expect(told()).toEqual([]);
    await service.todoRunner.refresh((message, error) => {
      throw new Error(message, { cause: error });
    });
    expect(service.todos.getTodo('synthetic-last')?.state).toBe('done');
    const finished = Date.now();
    await wakeStalledAsks(service.todos, service.deliverForward.bind(service), finished);
    await wakeStalledAsks(service.todos, service.deliverForward.bind(service), finished + 60_000);
    expect(told()).toEqual([
      'Ask: Finished work (finished-synthetic)\nAll todos are finished: write the outcome with neo.ask.settle, or add the next todo.',
    ]);
  });

  test('wakeNeo keeps structured PR events immediate', async () => {
    await service.wakeNeo('structured-pr', 'PR requires action.');
    expect(queued('structured-pr')).toEqual(['immediate']);
    const job = db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': rootId, messageUuid: 'structured-pr' })[0];
    expect((job.payload.message as { neoWakeEvent?: boolean }).neoWakeEvent).toBe(true);
  });

  test('sendToRef reaches a local HyperNeo worker through work.send', async () => {
    const ref = { adapter: 'hyperneo', id: rootId };
    expect(await service.sendToRef(ref, 'nudge-key', 'PR requires action.', 'todo')).toBe(true);
    expect(await service.sendToRef(ref, 'notice-key', 'FYI')).toBe(true);
    expect(sends).toEqual([
      { ref, message: 'PR requires action.', idempotencyKey: 'nudge-key', todoId: 'todo' },
      { ref, message: 'FYI', idempotencyKey: 'notice-key', notice: true },
    ]);
    expect(queued('nudge-key')).toEqual([]);
  });

  test('a burst of 20 unstructured worker notes does not start Neo', async () => {
    for (let i = 0; i < 20; i++)
      await service.deliverForward(rootId, `chatty-${i}`, `chatty-${i}`, 'worker');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': rootId })
    ).toHaveLength(0);
  });

  test('notes to busy and idle Neo both use immediate ordinary mailbox delivery', async () => {
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward(rootId, 'note-busy', 'A card reported.', rootId, 'event');
    expect(queued('note-busy')).toEqual(['immediate']);
    await events.publish('session.updated', {
      sessionId: rootId,
      processingState: { status: 'idle' } as never,
    });
    await service.deliverForward(rootId, 'note-idle', 'A card reported.', rootId, 'event');
    expect(queued('note-idle')).toEqual(['immediate']);
  });

  test.each(['focused', 'heartbeat', 'failed', 'needs_you'])(
    '%s status uses its wake policy',
    async (kind) => {
      const now = Date.now();
      const ref = { adapter: 'hyperneo', id: 'discussion' };
      const ask = service.todos.openAsk({
        id: 'focused-ask',
        projectId: null,
        sessionId: rootId,
        originMessageId: 'human-request',
        title: 'Discuss',
        request: 'Prepare a discussion',
        createdAt: now,
      });
      if (kind !== 'heartbeat')
        service.todos.focusAsk(
          ask.id,
          {
            ...ref,
            name: 'Discussion',
            label: 'Discussion',
            provider: 'Anthropic',
            link: '/session/discussion',
          },
          now
        );
      const todo = service.todos.addTodo(
        'focused-todo',
        ask.id,
        {
          title: 'Discuss',
          doneWhen: 'Human decides',
          instruction: null,
          named: null,
          check: null,
        },
        now
      );
      service.todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
      service.todoSessions.bind(todo.id, ref, now);
      const dispatch = await service.todoSessions.inputs.accept(
        todo.id,
        rootId,
        { verb: 'send', ref },
        'Prepare a discussion',
        now
      );
      await service.todoSessions.inputs.recordOutcome(dispatch, { ref }, now);
      turnEnds = [
        {
          id: 'discussion-turn',
          at: now + 1,
          message: 'Prepared the discussion.',
          ...(kind === 'heartbeat' ? { notify: false as const } : {}),
        },
      ];
      if (['failed', 'needs_you'].includes(kind)) workerStatus = kind;
      await service.todoRunner.refresh((message, error) => {
        throw new Error(message, { cause: error });
      });
      const reportJobs = () => [...turnReports('mailbox'), ...turnReports('neo_notes')];
      if (kind === 'focused') {
        expect(reportJobs()).toEqual([]);
        return;
      }
      const wakes = kind !== 'heartbeat';
      expect(turnReports(wakes ? 'mailbox' : 'neo_notes')).toHaveLength(1);
      expect(reportJobs()).toHaveLength(1);
      expect(JSON.stringify(reportJobs()[0].payload.message)).toContain('Prepared the discussion.');
      if (wakes) {
        expect(reportJobs()[0].payload.deliveryMode).toBe('immediate');
        expect(JSON.stringify(reportJobs()[0].payload.message)).toContain(
          'Do not act, reply, forward or treat this as approval.'
        );
      }
      if (kind === 'heartbeat') {
        for (const [id, message, status, count] of [
          ['different-id', 'Prepared the discussion.', 'running', 1],
          ['discussion-turn', 'Prepared the discussion. New reason.', 'running', 2],
          ['different-status', 'Prepared the discussion. New reason.', 'needs_you', 3],
          ['whitespace', 'Prepared the discussion. New reason. ', 'needs_you', 4],
          ['empty', '', 'needs_you', 5],
          ['literal', 'worker ended its turn with no reply', 'needs_you', 5],
        ] as const) {
          workerStatus = status;
          turnEnds = [{ id, at: Date.now() + 1, message, notify: false }];
          await service.todoRunner.refresh((message, error) => {
            throw new Error(message, { cause: error });
          });
          expect(reportJobs()).toHaveLength(count);
        }
        service.dispose();
        reopen();
        await service.todoRunner.refresh((message, error) => {
          throw new Error(message, { cause: error });
        });
        expect(reportJobs()).toHaveLength(5);
        const second = service.todos.addTodo(
          'other-todo',
          ask.id,
          {
            title: 'Other',
            doneWhen: 'Human decides',
            instruction: null,
            named: null,
            check: null,
          },
          now
        );
        service.todos.updateTodo(second, { state: 'doing', startedAt: now }, now);
        service.todoSessions.bind(second.id, ref, now);
        const secondDispatch = await service.todoSessions.inputs.accept(
          second.id,
          rootId,
          { verb: 'send', ref },
          'Other',
          now
        );
        await service.todoSessions.inputs.recordOutcome(secondDispatch, { ref }, now);
        for (let read = 0; read < 2; read++)
          await service.todoRunner.refresh((message, error) => {
            throw new Error(message, { cause: error });
          });
        expect(reportJobs()).toHaveLength(6);
        expect(
          reportJobs().filter((job) => JSON.stringify(job.payload.message).includes('other-todo'))
        ).toHaveLength(1);
      }
    }
  );

  test('a history read at once tells its newest turn and never skips a later report', async () => {
    const now = Date.now();
    const before = now - 60_000;
    const ref = { adapter: 'hyperneo', id: 'replayed-worker' };
    const ask = service.todos.openAsk({
      id: 'upgrade-ask',
      projectId: null,
      sessionId: rootId,
      originMessageId: 'upgrade-human',
      title: 'Upgrade',
      request: 'Keep working',
      createdAt: before,
    });
    const todo = service.todos.addTodo(
      'upgrade-todo',
      ask.id,
      {
        title: 'Upgrade',
        doneWhen: 'New work arrives',
        instruction: null,
        named: null,
        check: null,
      },
      before
    );
    service.todos.updateTodo(todo, { state: 'doing', startedAt: before }, before);
    service.todoSessions.bind(todo.id, ref, before);
    const dispatch = await service.todoSessions.inputs.accept(
      todo.id,
      rootId,
      { verb: 'send', ref },
      'Keep working',
      before
    );
    await service.todoSessions.inputs.recordOutcome(dispatch, { ref }, before);
    turnEnds = Array.from({ length: 20 }, (_, i) => ({
      id: `historical-${i}`,
      at: before + i + 1,
      message: `Previously handled ${i}`,
    }));
    const told = () =>
      [...turnReports('neo_notes'), ...turnReports('mailbox')].map((job) =>
        JSON.stringify(job.payload.message)
      );
    const refresh = () =>
      service.todoRunner.refresh((message, error) => {
        throw new Error(message, { cause: error });
      });
    await refresh();
    expect(turnReports('mailbox')).toHaveLength(0);
    expect(told()).toHaveLength(1);
    expect(told()[0]).toContain('Previously handled 19');
    workerStatus = 'done';
    service.todos.focusAsk(
      ask.id,
      {
        ...ref,
        name: 'Worker',
        label: 'Worker',
        provider: 'Synthetic',
        link: '/session/replayed-worker',
      },
      now
    );
    await refresh();
    expect(told()).toHaveLength(1);
    workerStatus = 'needs_you';
    turnEnds.push({
      id: 'after-history',
      at: now + 1,
      message: 'A new question after the history',
    });
    service.dispose();
    reopen();
    await refresh();
    expect(told()).toHaveLength(2);
    expect(told()[1]).toContain('A new question after the history');
    workerStatus = 'running';
    await refresh();
    expect(told()).toHaveLength(2);
    service.dispose();
    reopen();
    await refresh();
    expect(told()).toHaveLength(2);
    turnEnds[20].message = 'Changed report under the same transport ID';
    await refresh();
    expect(told()).toHaveLength(3);
    turnEnds.push({ id: 'different-id-same-report', at: now + 2, message: turnEnds[20].message });
    workerStatus = 'needs_you';
    await refresh();
    expect(told()).toHaveLength(3);
    workerStatus = 'failed';
    turnEnds.push({ id: 'retry-after-failure', at: now + 3, message: 'Keep this new report' });
    const entry = service as unknown as {
      attention(event: NeoAttentionEvent, at: number): Promise<unknown>;
    };
    const tell = entry.attention;
    const attention = vi.spyOn(entry, 'attention').mockImplementation(async (event, at) => {
      if (String(event.facts.text).includes('Keep this new report'))
        throw new Error('Synthetic admission failure');
      return tell(event, at);
    });
    await expect(refresh()).rejects.toThrow('Todo session refresh pending');
    expect(told()).toHaveLength(3);
    attention.mockRestore();
    workerStatus = 'running';
    await refresh();
    expect(told()).toHaveLength(4);
    expect(told()[3]).toContain('Keep this new report');
    expect(told()[3]).toContain('status failed');
  });

  const storedCount = (messageId: string) =>
    (
      db
        .getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
        .get(rootId, messageId) as { n: number }
    ).n;

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s retry preserves one pending urgent delivery',
    async (kind) => {
      const id = 'pending-urgent';
      const urgent = service.deliverForward(rootId, id, 'Worker failed.', rootId, 'event');
      await service.deliverForward(rootId, id, 'Quiet retry.', rootId, kind);
      await urgent;
      expect(storedCount(id)).toBe(0);
      expect(queued(id)).toEqual(['immediate']);
    }
  );

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s retry preserves one queued urgent delivery',
    async (kind) => {
      const id = 'queued-urgent';
      await service.deliverForward(rootId, id, 'Worker failed.', rootId, 'event');
      await service.deliverForward(rootId, id, 'Quiet retry.', rootId, kind);
      expect(storedCount(id)).toBe(0);
      expect(queued(id)).toEqual(['immediate']);
    }
  );

  test.each(['focused_status', 'quiet_heartbeat'] as const)(
    '%s concurrent retries record one history row without a wake',
    async (kind) => {
      const id = 'concurrent-quiet';
      await Promise.all(
        Array.from({ length: 10 }, () =>
          service.deliverForward(rootId, id, 'Quiet report.', rootId, kind)
        )
      );
      expect(storedCount(id)).toBe(1);
      expect(queued(id)).toEqual([]);
    }
  );

  test('a message to a busy ordinary chat is not deferred', async () => {
    await db.createSession(createTestSession('chat-1'));
    await events.publish('session.updated', {
      sessionId: 'chat-1',
      processingState: { status: 'processing' } as never,
    });
    await service.deliverForward('chat-1', 'brief-1', 'Do the work.', rootId);
    expect(
      db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': 'chat-1', messageUuid: 'brief-1' })
        .map((job) => job.payload.deliveryMode)
    ).toEqual(['immediate']);
  });
});
