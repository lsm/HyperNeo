import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  createNeoOperations,
  requireNeoExecutionChoice,
} from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { requireNeoWorkTargetSession } from '../../../../src/lib/neo/work-target.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo existing chat work', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let sessions: SessionManager;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let createSession: ReturnType<typeof mock>;
  let getSessionAsync: ReturnType<typeof mock>;
  const human: OperationCaller = { source: 'rpc', principal: 'local' };
  const source = (messageId: string): OperationCaller => ({
    source: 'mcp',
    sessionId: 'root',
    role: 'neo',
    neoTurn: { messageId, human: true, isLive: () => true },
  });

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'ordinary', 'project', 'manager', 'holder', 'archived'])
      db.createSession({
        ...createTestSession(id),
        workspacePath: id === 'project' ? '/projects/owned-by-user' : null,
        status: id === 'archived' ? 'archived' : 'active',
      });
    db.getDatabase()
      .prepare(`INSERT INTO spaces(id, slug, name, workspace_path, created_at, updated_at)
      VALUES ('space-a', 'space-a', 'Existing project', '/projects/owned-by-user', 1, 1)`)
      .run();
    db.getDatabase()
      .prepare(`INSERT INTO space_long_horizon_agents(id, space_id, handle, display_name,
      session_id, instructions, created_at, updated_at)
      VALUES ('manager-a', 'space-a', 'manager', 'Manager', 'manager', 'Existing responsibilities', 1, 1)`)
      .run();
    createSession = mock(async () => {
      throw new Error('Existing chats must not create another session');
    });
    getSessionAsync = mock(async () => {
      throw new Error('This adapter must not load or interrupt the SDK');
    });
    sessions = { createSession, getSessionAsync } as unknown as SessionManager;
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
    service.repo.saveConcern(
      { id: 'research', title: 'Research', summary: 'Learn', context: 'Private context' },
      0
    );
    service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function invoke(name: string, input: unknown, caller = human) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      caller
    );
  }
  function input(requestKey = 'A', targetSessionId: string | null = 'project') {
    return {
      requestKey,
      targetSessionId,
      title: `Work ${requestKey}`,
      instruction: 'Draft a bounded answer. Do not send, publish or modify files.',
    };
  }
  async function propose(requestKey = 'A', targetSessionId = 'project'): Promise<NeoWork> {
    const result = await invoke(
      'neo.work.propose',
      input(requestKey, targetSessionId),
      source(`ask-${requestKey}`)
    );
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    return (result as { value: { work: NeoWork } }).value.work;
  }
  function resources() {
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
  function jobs(sessionId: string, workId?: string) {
    return db.getJobQueueRepo().listActiveByPayload('mailbox', {
      'to.sessionId': sessionId,
      ...(workId ? { messageUuid: workId } : {}),
    });
  }
  function content(job: ReturnType<typeof jobs>[number]): string {
    return (job.payload.message as { message: { content: string } }).message.content;
  }

  test.each(['ordinary', 'project'])(
    'approved %s work reuses its exact unchanged execution context',
    async (target) => {
      const before = resources();
      const work = await propose('A', target);
      expect(work).toMatchObject({
        targetSessionId: target,
        sessionId: null,
        status: 'proposed',
        originMessageId: 'ask-A',
      });
      expect(jobs(target)).toEqual([]);
      expect(await invoke('neo.work.start', { id: work.id }, source('ask-A'))).toMatchObject({
        value: { ok: false },
      });
      await Promise.all([invoke('neo.work.start', { id: work.id }), service.start(work.id)]);
      await service.start(work.id);
      expect(service.repo.getWork(work.id)).toMatchObject({
        status: 'queued',
        sessionId: target,
        targetSessionId: target,
      });
      const deliveries = jobs(target, work.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].payload).toMatchObject({
        origin: 'session:root',
        messageUuid: work.id,
        message: { inputKind: 'system' },
      });
      expect(content(deliveries[0])).toContain('neo.work.report');
      expect(content(deliveries[0])).toContain(
        JSON.stringify({ workId: work.id, title: work.title, instruction: work.instruction })
      );
      expect(resources()).toBe(before);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
    }
  );

  test('carries the goal and done checklist with the brief and in the snapshot', async () => {
    const proposed = await invoke(
      'neo.work.propose',
      {
        ...input('G', 'project'),
        goal: 'A full-featured native iOS app for Neo',
        doneWhen: '- chat, work cards and settings screens\n- builds and runs in the simulator',
      },
      source('ask-G')
    );
    const work = (proposed as { value: { work: NeoWork } }).value.work;
    await invoke('neo.work.start', { id: work.id });
    await service.start(work.id);

    const brief = content(jobs('project', work.id)[0]);
    expect(brief).toContain('Goal: A full-featured native iOS app for Neo');
    expect(brief).toContain('builds and runs in the simulator');
    expect(brief).toContain('If you stop before this is done, say what remains and why.');
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: {
        workGoals: [
          {
            workId: work.id,
            goal: 'A full-featured native iOS app for Neo',
            doneWhen: '- chat, work cards and settings screens\n- builds and runs in the simulator',
          },
        ],
      },
    });
  });

  test('a re-proposal refused for another target leaves the existing work without a goal', async () => {
    await propose('R', 'project');
    expect(
      await invoke(
        'neo.work.propose',
        { ...input('R', 'ordinary'), goal: 'Something else entirely' },
        source('ask-R')
      )
    ).toMatchObject({ value: { ok: false } });
    expect(await invoke('neo.snapshot', {})).toMatchObject({ value: { workGoals: [] } });
  });

  test.each([
    ['missing', 'target_session_not_found'],
    ['archived', 'target_session_not_active'],
    ['root', 'target_owned_context'],
    ['holder', 'target_owned_context'],
  ])(
    'proposal refuses %s before storing a work or inventing another executor',
    async (target, reason) => {
      const before = resources();
      expect(await invoke('neo.work.propose', input('A', target), source('ask-A'))).toMatchObject({
        value: { ok: false, reason: expect.stringMatching(new RegExp(`^${reason}`)) },
      });
      expect(service.repo.listWork()).toEqual([]);
      expect(resources()).toBe(before);
      expect(createSession).not.toHaveBeenCalled();
    }
  );

  test('proposal to a Space agent session id becomes a send to that agent', async () => {
    const reply = (await invoke('neo.work.propose', input('A', 'manager'), source('ask-A'))) as {
      value: { ok: boolean; work: { id: string } };
    };
    expect(reply.value.ok).toBe(true);
    expect(service.driverTargets.get(reply.value.work.id)).toEqual({
      verb: 'send',
      ref: { adapter: 'space', id: 'agent:manager-a' },
    });
  });

  test('target admission keeps scope-owned runtime integrity without inventing working modes', () => {
    const target = { id: 'A', targetSessionId: 'project' };
    expect(
      requireNeoWorkTargetSession(target, { id: 'project', status: 'active', neoBound: 1 })
    ).toEqual({
      reason: { accepted: false, reason: 'target_owned_context' },
    });
    expect(
      requireNeoWorkTargetSession(target, { id: 'project', status: 'active', scopeOwned: 0 })
    ).toEqual({ value: target });
    expect(
      requireNeoWorkTargetSession(target, { id: 'project', status: 'active', scopeOwned: 1 })
    ).toEqual({ reason: { accepted: false, reason: 'target_owned_context' } });
    expect(
      requireNeoWorkTargetSession(target, { id: 'project', status: 'archived', scopeOwned: 1 })
    ).toEqual({ reason: { accepted: false, reason: 'target_session_not_active' } });
    expect(neoPrompt(null)).toContain('pass that targetSessionId to neo.work.propose');
    expect(neoPrompt('research')).toContain(
      'a work proposal always shows targetSessionId null because its target is the work field'
    );
  });

  test('request retries cannot change the chosen target or input lineage', async () => {
    const work = await propose();
    expect(await invoke('neo.work.propose', input(), source('ask-A'))).toMatchObject({
      value: { work },
    });
    expect(await invoke('neo.work.propose', input('A', 'ordinary'), source('ask-A'))).toMatchObject(
      {
        value: { ok: false, reason: 'This request key belongs to another execution target.' },
      }
    );
    expect(await invoke('neo.work.propose', input('A', null), source('ask-A'))).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('no standalone scratch session') },
    });
    expect(await invoke('neo.work.propose', input(), source('ask-B'))).toMatchObject({
      value: { ok: false, reason: 'This request key belongs to another input.' },
    });
    expect(service.repo.listWork()).toEqual([work]);
    expect(jobs('project')).toEqual([]);
  });

  test('proposals without a target reject before storage from Neo and the human alike', async () => {
    const { targetSessionId: _target, ...withoutTarget } = input();
    for (const choice of [{}, { targetSessionId: null }])
      expect(requireNeoExecutionChoice(choice, source('ask-A'))).toMatchObject({
        reason: {
          ok: false,
          reason: expect.stringContaining('ask the human where the work belongs'),
        },
      });
    expect(
      requireNeoExecutionChoice({ targetSessionId: 'project' }, source('ask-A'))
    ).toMatchObject({ value: { sessionId: 'root' } });
    expect(requireNeoExecutionChoice(withoutTarget, human)).toMatchObject({
      reason: { ok: false },
    });
    expect(await invoke('neo.work.propose', withoutTarget, source('ask-A'))).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('Choose where the work runs') },
    });
    expect(service.repo.listWork()).toEqual([]);
    expect(await invoke('neo.work.propose', withoutTarget)).toMatchObject({
      value: { ok: false },
    });
    expect(service.repo.listWork()).toEqual([]);
    expect(jobs('project')).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  test.each(['', ' '.repeat(161)])(
    'malformed target %j fails before proposal execution',
    async (target) => {
      expect(await invoke('neo.work.propose', input('A', target), source('ask-A'))).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
      expect(service.repo.listWork()).toEqual([]);
    }
  );

  test('unknown whitespace target is never trimmed into another session', async () => {
    expect(
      await invoke('neo.work.propose', input('A', ' project '), source('ask-A'))
    ).toMatchObject({ value: { ok: false, reason: 'target_session_not_found' } });
    expect(service.repo.listWork()).toEqual([]);
  });

  test('proposal rechecks immutable live input immediately before the repository write', async () => {
    let checks = 0;
    const caller: OperationCaller = {
      ...source('ask-A'),
      neoTurn: { messageId: 'ask-A', human: true, isLive: () => ++checks === 1 },
    };
    expect(await invoke('neo.work.propose', input(), caller)).toMatchObject({
      value: { ok: false },
    });
    expect(checks).toBe(2);
    expect(service.repo.listWork()).toEqual([]);
  });

  test('Start revalidates archived targets without queueing or scratch fallback', async () => {
    const work = await propose();
    db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'").run();
    expect(await invoke('neo.work.start', { id: work.id })).toMatchObject({
      value: { ok: false, reason: 'target_session_not_active' },
    });
    expect(service.repo.getWork(work.id)).toEqual(work);
    expect(jobs('project')).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  test('a lost Start reservation never dispatches a cancelled brief', async () => {
    const work = await propose();
    const transition = service.repo.transitionWork.bind(service.repo);
    const race = spyOn(service.repo, 'transitionWork').mockImplementation((id, expected) => {
      race.mockRestore();
      expect(transition(id, expected, { status: 'cancelled' })).not.toBeNull();
      return null;
    });
    await service.start(work.id);
    expect(service.repo.getWork(work.id)?.status).toBe('cancelled');
    expect(jobs('project')).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  test.each(['archived', 'deleted', 'owned'])(
    'queued work reports an unavailable %s target once across recovery',
    async (change) => {
      const work = await propose();
      await service.start(work.id);
      if (change === 'archived')
        db.getDatabase()
          .prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'")
          .run();
      if (change === 'deleted')
        db.getDatabase().prepare("DELETE FROM sessions WHERE id = 'project'").run();
      if (change === 'owned')
        db.getDatabase()
          .prepare(
            "UPDATE space_long_horizon_agents SET session_id = 'project' WHERE id = 'manager-a'"
          )
          .run();
      const reason =
        change === 'deleted'
          ? 'target_session_not_found'
          : change === 'archived'
            ? 'target_session_not_active'
            : 'target_owned_context';
      await service.recover();
      await service.recover();
      expect(service.repo.getWork(work.id)).toMatchObject({
        status: 'failed',
        sessionId: 'project',
        originMessageId: 'ask-A',
        report: expect.stringContaining(reason),
      });
      expect(jobs('root', work.id)).toHaveLength(1);
      expect(content(jobs('root', work.id)[0])).toContain('"originMessageId":"ask-A"');
      expect(jobs('project', work.id)).toHaveLength(1);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
    }
  );

  test('reconcile fails an inadmissible shared target without reading its SDK output', async () => {
    const work = await propose();
    await service.start(work.id);
    db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'").run();
    const messages = db.getSDKMessageRepo();
    spyOn(db, 'getSDKMessageRepo').mockReturnValue(messages);
    const terminal = spyOn(messages, 'hasTerminalResultAfter');
    await service.reconcile(work.id);
    expect(service.repo.getWork(work.id)?.status).toBe('failed');
    expect(jobs('root', work.id)).toHaveLength(1);
    expect(terminal).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });

  test('a target lost after reservation fails before dispatch with no scratch fallback', async () => {
    const work = await propose();
    const resolve = service.resolveWorkTarget;
    let reads = 0;
    spyOn(service, 'resolveWorkTarget').mockImplementation((id) => {
      if (++reads === 2)
        db.getDatabase()
          .prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'")
          .run();
      return resolve(id);
    });
    await service.start(work.id);
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'failed',
      report: expect.stringContaining('target_session_not_active'),
    });
    expect(jobs('project', work.id)).toHaveLength(0);
    expect(jobs('root', work.id)).toHaveLength(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  test('a lost failure CAS cannot overwrite cancellation or return another result', async () => {
    const work = await propose();
    await service.start(work.id);
    db.getDatabase().prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project'").run();
    const transition = service.repo.transitionWork.bind(service.repo);
    const race = spyOn(service.repo, 'transitionWork').mockImplementation((id, expected) => {
      race.mockRestore();
      expect(transition(id, expected, { status: 'cancelled' })).not.toBeNull();
      return null;
    });
    await service.start(work.id);
    expect(service.repo.getWork(work.id)?.status).toBe('cancelled');
    expect(jobs('root', work.id)).toHaveLength(0);
    expect(getSessionAsync).not.toHaveBeenCalled();
  });

  test('restart recovery preserves each exact request and deduplicates its pending handoff', async () => {
    const a = await propose('A');
    const b = await propose('B');
    await Promise.all([service.start(a.id), service.start(b.id)]);
    const before = resources();
    service.dispose();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    await service.recover();
    await service.recover();
    expect(jobs('project')).toHaveLength(2);
    expect(jobs('project', a.id)).toHaveLength(1);
    expect(jobs('project', b.id)).toHaveLength(1);
    expect(resources()).toBe(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });

  test('shared recipient reports B then A through the actual operations adapter to the matching asks', async () => {
    const a = await propose('A');
    const b = await propose('B');
    await Promise.all([service.start(a.id), service.start(b.id)]);
    const registry = createOperationRegistry(createNeoOperations(service));
    const report = createOperationMcpHandler(registry, () => ({ sessionId: 'project' }));
    const foreign = createOperationMcpHandler(registry, () => ({ sessionId: 'ordinary' }));
    const request = (work: NeoWork) => ({
      name: 'neo.work.report',
      input: { id: work.id, status: 'reported', report: `Evidence ${work.title}` },
    });
    expect(JSON.parse((await foreign(request(a))).content[0].text)).toMatchObject({
      accepted: false,
      reason: 'recipient_mismatch',
    });
    for (const work of [b, a]) {
      expect(JSON.parse((await report(request(work))).content[0].text)).toMatchObject({
        accepted: true,
        workId: work.id,
        replayed: false,
      });
      expect(JSON.parse((await report(request(work))).content[0].text)).toMatchObject({
        accepted: true,
        replayed: true,
      });
      const returned = jobs('root', work.id);
      expect(returned).toHaveLength(1);
      expect(content(returned[0])).toContain(
        `"originMessageId":"ask-${work.requestKey.split(':').at(-1)}"`
      );
      expect(content(returned[0])).toContain(`Evidence ${work.title}`);
    }
    expect(jobs('root')).toHaveLength(2);
    expect(service.repo.getWork(a.id)?.report).toBe('Evidence Work A');
    expect(service.repo.getWork(b.id)?.report).toBe('Evidence Work B');
    expect(createSession).not.toHaveBeenCalled();
  });

  test('Stop waiting closes only A and leaves the shared execution and B available', async () => {
    const a = await propose('A');
    const b = await propose('B');
    await Promise.all([service.start(a.id), service.start(b.id)]);
    const before = resources();
    await invoke('neo.work.cancel', { id: a.id });
    expect(
      await invoke(
        'neo.work.report',
        { id: a.id, status: 'reported', report: 'Too late' },
        { source: 'mcp', sessionId: 'project' }
      )
    ).toMatchObject({ value: { accepted: false } });
    expect(
      await invoke(
        'neo.work.report',
        { id: b.id, status: 'reported', report: 'B is ready' },
        { source: 'mcp', sessionId: 'project' }
      )
    ).toMatchObject({ value: { accepted: true } });
    expect(service.repo.getWork(a.id)?.status).toBe('cancelled');
    expect(service.repo.getWork(b.id)?.status).toBe('reported');
    expect(resources()).toBe(before);
    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
