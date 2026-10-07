import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKResultSuccess, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('NeoService shared recipient lifecycle', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let interrupt: ReturnType<typeof mock>;
  let createSession: ReturnType<typeof mock>;
  let getSessionAsync: ReturnType<typeof mock>;

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'ordinary', 'project', 'manager', 'holder', 'dedicated'])
      db.createSession({
        ...createTestSession(id),
        workspacePath: id === 'project' ? '/projects/existing' : null,
      });
    const sql = db.getDatabase();
    sql
      .prepare(`INSERT INTO spaces(id, slug, name, workspace_path, created_at, updated_at)
      VALUES ('space-a', 'space-a', 'Existing project', '/projects/existing', 1, 1)`)
      .run();
    sql
      .prepare(`INSERT INTO space_long_horizon_agents(id, space_id, handle, display_name,
      session_id, instructions, created_at, updated_at)
      VALUES ('manager-a', 'space-a', 'manager', 'Manager', 'manager', 'Existing role', 1, 1)`)
      .run();
    interrupt = mock(async () => {});
    createSession = mock(async () => {
      throw new Error('Must not create a scratch worker for a shared target');
    });
    getSessionAsync = mock(async () => ({ handleInterrupt: interrupt }));
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
    service.repo.saveConcern(
      { id: 'research', title: 'Research', summary: 'Learn', context: 'Private context' },
      0
    );
    service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
    service.repo.reserveBinding({ sessionId: 'dedicated', kind: 'worker', concernId: null });
  });

  afterEach(() => {
    service.dispose();
    db.close();
  });

  function propose(id: string, targetSessionId: string | null = 'project'): NeoWork {
    return service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: id,
      concernId: null,
      originSessionId: 'root',
      originMessageId: `ask-${id}`,
      targetSessionId,
      title: `Approved ${id}`,
      instruction: 'Read existing state; do not modify files.',
    });
  }

  function queue(id: string, targetSessionId: string | null = 'project'): NeoWork {
    const work = propose(id, targetSessionId);
    const queued = service.repo.transitionWork(work.id, work, {
      status: 'queued',
      sessionId: targetSessionId ?? 'dedicated',
    });
    if (!queued) throw new Error('Fixture reservation failed');
    return queued;
  }

  function captureResources(): string {
    return JSON.stringify(
      [
        'sessions',
        'spaces',
        'space_long_horizon_agents',
        'neo_concerns',
        'neo_session_bindings',
        'sdk_messages',
      ].map((table) => db.getDatabase().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    );
  }

  function jobs() {
    return db.getDatabase().prepare('SELECT * FROM job_queue ORDER BY rowid').all();
  }

  function saveLaterResponse(work: NeoWork): void {
    const sessionId = work.sessionId!;
    const sdk = db.getSDKMessageRepo();
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as SDKResultSuccess['usage'];
    for (const uuid of [work.id, crypto.randomUUID()]) {
      expect(
        sdk.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: uuid as SDKUserMessage['uuid'],
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { role: 'user', content: uuid },
          },
          'enqueued'
        )
      ).not.toBeNull();
      expect(sdk.markDeliveryConsumedByUuid(sessionId, uuid)).not.toBeNull();
    }
    expect(
      sdk.saveSDKMessage(sessionId, {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: 'fixture-assistant',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          container: null,
          context_management: null,
          diagnostics: null,
          stop_details: null,
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'Unrelated answer B', citations: null }],
          usage,
        },
      })
    ).toBe(true);
    expect(
      sdk.saveSDKMessage(sessionId, {
        type: 'result',
        subtype: 'success',
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        is_error: false,
        result: 'Unrelated answer B',
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage,
        modelUsage: {},
        permission_denials: [],
      })
    ).toBe(true);
    expect(sdk.hasTerminalResultAfter(sessionId, work.id)).toBe(true);
    expect(sdk.getAssistantMessagesSince(sessionId, null).at(-1)?.text).toBe('Unrelated answer B');
  }

  function expectNoExecution() {
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  }

  test.each(['manager', 'holder', 'missing'])(
    'Start never reserves or reconfigures inadmissible existing target %s',
    async (target) => {
      const work = propose('A', target);
      const before = captureResources();
      await Promise.all([service.start(work.id), service.start(work.id)]);
      expect(service.repo.getWork(work.id)).toEqual(work);
      expect(captureResources()).toBe(before);
      expect(jobs()).toEqual([]);
      expectNoExecution();
    }
  );

  test.each(['manager'])(
    'recovery does not deliver through the scratch-worker path for protected %s',
    async (target) => {
      const work = queue('A', target);
      const before = captureResources();
      await service.recover();
      await service.recover();
      expect(service.repo.getWork(work.id)).toMatchObject({
        ...work,
        status: 'failed',
        report: expect.stringContaining('target_owned_context'),
        updatedAt: expect.any(Number),
      });
      expect(captureResources()).toBe(before);
      expect(jobs()).toHaveLength(1);
      expectNoExecution();
    }
  );

  test.each(['ordinary', 'project', 'manager'])(
    'later terminal output in %s cannot finish an unrelated receipt',
    async (target) => {
      const a = queue('A', target);
      const b = queue('B', target);
      saveLaterResponse(a);
      const before = captureResources();
      const sdk = db.getSDKMessageRepo();
      const readSdk = spyOn(db, 'getSDKMessageRepo').mockReturnValue(sdk);
      const terminal = spyOn(sdk, 'hasTerminalResultAfter');
      const failure = spyOn(sdk, 'getErrorTerminalResultSubtypeAfter');
      const text = spyOn(sdk, 'getAssistantMessagesSince');
      try {
        await Promise.all([service.reconcile(a.id), service.reconcile(b.id)]);
        await events.publish('session.updated', {
          sessionId: target,
          processingState: { status: 'idle' },
        });
        for (const work of [a, b])
          expect(service.repo.getWork(work.id)).toEqual(
            target === 'manager'
              ? {
                  ...work,
                  status: 'failed',
                  report: 'The chosen execution chat is no longer available: target_owned_context.',
                  updatedAt: expect.any(Number),
                }
              : work
          );
        expect(captureResources()).toBe(before);
        expect(jobs()).toHaveLength(target === 'manager' ? 2 : 0);
        expect(terminal).not.toHaveBeenCalled();
        expect(failure).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
        expectNoExecution();
      } finally {
        terminal.mockRestore();
        failure.mockRestore();
        text.mockRestore();
        readSdk.mockRestore();
      }
    }
  );

  test.each(['ordinary', 'project', 'manager', 'holder', 'missing'])(
    'cancel closes only its receipt without interrupting %s',
    async (target) => {
      const a = queue('A', target);
      const b = queue('B', target);
      const before = captureResources();
      await Promise.all([service.cancel(a.id), service.cancel(a.id)]);
      const cancelled = service.repo.getWork(a.id);
      expect(cancelled).toMatchObject({ ...a, status: 'cancelled', updatedAt: expect.any(Number) });
      await service.cancel(a.id);
      await service.reconcile(a.id);
      expect(service.repo.getWork(a.id)).toEqual(cancelled);
      expect(service.repo.getWork(b.id)).toEqual(b);
      expect(captureResources()).toBe(before);
      expect(jobs()).toEqual([]);
      expectNoExecution();
    }
  );

  test('inactive shared recipients still cancel without SDK loading', async () => {
    const work = queue('A');
    db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'").run();
    const before = captureResources();
    await service.cancel(work.id);
    expect(service.repo.getWork(work.id)?.status).toBe('cancelled');
    expect(captureResources()).toBe(before);
    expectNoExecution();
  });

  test('missing target metadata does not become dedicated-worker authority', async () => {
    const proposed = propose('proposed');
    const queued = queue('queued');
    const read = spyOn(service.repo, 'getWorkTarget').mockReturnValue(null);
    try {
      await service.start(proposed.id);
      await service.reconcile(queued.id);
      await service.cancel(queued.id);
      expect(service.repo.getWork(proposed.id)).toEqual(proposed);
      expect(service.repo.getWork(queued.id)).toMatchObject({
        status: 'failed',
        report: expect.stringContaining('work_not_found'),
      });
      expect(jobs()).toHaveLength(1);
      expectNoExecution();
    } finally {
      read.mockRestore();
    }
  });

  test('target storage faults propagate without another executor or receipt completion', async () => {
    const proposed = propose('proposed');
    const queued = queue('queued');
    const read = spyOn(service.repo, 'getWorkTarget').mockImplementation(() => {
      throw new Error('Target storage unavailable');
    });
    try {
      await expect(service.start(proposed.id)).rejects.toThrow('Target storage unavailable');
      await expect(service.reconcile(queued.id)).rejects.toThrow('Target storage unavailable');
      expect(service.repo.getWork(proposed.id)).toEqual(proposed);
      expect(service.repo.getWork(queued.id)).toEqual(queued);
      expect(read).toHaveBeenCalledTimes(2);
      expect(jobs()).toEqual([]);
      expectNoExecution();
    } finally {
      read.mockRestore();
    }
  });

  test('a lost cancellation CAS never interrupts even a dedicated worker', async () => {
    const queued = queue('A', null);
    const transition = service.repo.transitionWork.bind(service.repo);
    const race = spyOn(service.repo, 'transitionWork').mockImplementation((id, expected) => {
      race.mockRestore();
      expect(
        transition(id, expected, { status: 'reported', report: 'Already settled' })
      ).not.toBeNull();
      return null;
    });
    await service.cancel(queued.id);
    expect(service.repo.getWork(queued.id)).toMatchObject({
      status: 'reported',
      report: 'Already settled',
    });
    expectNoExecution();
  });

  test('settled explicit reports retain attributed deduplicated returns after recovery', async () => {
    const queued = queue('A');
    const settled = service.repo.transitionWork(queued.id, queued, {
      status: 'reported',
      report: 'Recorded scoped evidence for A, not unrelated B.',
    });
    const before = captureResources();
    await service.reconcile(queued.id);
    await service.recover();
    await service.reconcile(queued.id);
    expect(service.repo.getWork(queued.id)).toEqual(settled);
    const returns = db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: queued.id });
    expect(returns).toHaveLength(1);
    expect(returns[0].payload).toMatchObject({
      to: { kind: 'session', sessionId: 'root' },
      origin: 'session:project',
      messageUuid: queued.id,
    });
    const message = returns[0].payload.message as { message: { content: string } };
    expect(message.message.content).toContain('"originMessageId":"ask-A"');
    expect(message.message.content).toContain('Recorded scoped evidence for A');
    expect(captureResources()).toBe(before);
    expectNoExecution();
  });
});
