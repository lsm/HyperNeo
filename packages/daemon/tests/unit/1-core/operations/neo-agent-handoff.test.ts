import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  requireNeoProposal,
  requireNeoProposalReceipt,
} from '../../../../src/lib/neo/agent-work-target.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const agent = Object.freeze({
  spaceId: 'space-A',
  agentId: 'manager-A',
  sessionId: 'manager-A-session',
});
const input = Object.freeze({
  requestKey: 'native:ask-A',
  concernId: null,
  title: 'Read existing project evidence',
  instruction: 'Return a bounded draft. No external action.',
  targetSessionId: agent.sessionId,
  targetAgent: agent,
});
const origin = Object.freeze({ originSessionId: 'root', originMessageId: 'ask-A' });
const work: NeoWork = Object.freeze({
  id: 'work-A',
  requestKey: 'root:native:ask-A',
  ...origin,
  concernId: null,
  title: input.title,
  instruction: input.instruction,
  targetSessionId: agent.sessionId,
  sessionId: null,
  status: 'proposed',
  report: null,
  createdAt: 1,
  updatedAt: 1,
});
const target = Object.freeze({ id: 'candidate', targetSessionId: agent.sessionId, agent });
const ok = { value: { ok: true, work } };

describe('requireNeoProposal', () => {
  test('a cross-target reservation rejects before the receipt is compared', () => {
    expect(
      requireNeoProposal(target, origin, {
        receipt: { work: { ...work, originMessageId: 'ask-B' }, agent },
        crossTarget: true,
      })
    ).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another execution target.' },
    });
  });
  test('a same-target reservation defers to the receipt gate', () => {
    expect(
      requireNeoProposal(target, origin, { receipt: { work, agent }, crossTarget: false })
    ).toEqual({ value: { ok: true as const, work } });
    expect(
      requireNeoProposal(target, origin, { receipt: { work, agent: null }, crossTarget: false })
    ).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another native target.' },
    });
  });
});

describe('Neo proposal receipt gate', () => {
  test('exact native and ordinary receipts preserve their original work record', () => {
    expect(requireNeoProposalReceipt(target, origin, { work, agent })).toEqual(ok);
    expect(
      requireNeoProposalReceipt({ ...target, agent: undefined }, origin, { work, agent: null })
    ).toEqual(ok);
  });
  test.each([
    { work: { ...work, originMessageId: 'ask-B' }, agent },
    { work: { ...work, originSessionId: 'other-root' }, agent },
  ])('source mismatch precedes native target checks: %j', (receipt) => {
    expect(requireNeoProposalReceipt(target, origin, receipt)).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another input.' },
    });
  });
  test('session substitution cannot reuse the source receipt', () => {
    expect(
      requireNeoProposalReceipt(target, origin, {
        work: { ...work, targetSessionId: 'other' },
        agent,
      })
    ).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another execution target.' },
    });
  });
  test.each([
    null,
    { ...agent, spaceId: 'other' },
    { ...agent, agentId: 'other' },
    { ...agent, sessionId: 'other' },
  ])('exact native reference cannot change on retry: %j', (recorded) => {
    expect(requireNeoProposalReceipt(target, origin, { work, agent: recorded })).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another native target.' },
    });
  });
  test('native and ordinary reservations cannot be reinterpreted', () => {
    expect(
      requireNeoProposalReceipt({ ...target, agent: undefined }, origin, { work, agent })
    ).toMatchObject({
      reason: { ok: false, reason: 'This request key belongs to another native target.' },
    });
  });
});

describe('Neo existing Space-agent handoff operation', () => {
  let db: Database;
  let service: NeoService;
  let registry: OperationRegistry;
  let agents: SpaceLongHorizonAgentRepository;
  let createSession: ReturnType<typeof mock>;
  let getSessionAsync: ReturnType<typeof mock>;
  const caller: OperationCaller = {
    source: 'mcp',
    sessionId: 'root',
    neoTurn: { messageId: origin.originMessageId, human: true, isLive: () => true },
  };
  const human: OperationCaller = { source: 'rpc', principal: 'local' };
  beforeEach(async () => {
    db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    createSession = mock(async () => {
      throw new Error('Must not create a worker');
    });
    getSessionAsync = mock(async () => {
      throw new Error('Must not load or change the native agent');
    });
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const sql = db.getDatabase();
    for (const id of ['root', agent.sessionId, 'manager-B-session', 'ordinary', 'holder'])
      sql
        .prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
        VALUES (?,?,'/existing-native-repo','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z','active','{}','{}')`)
        .run(id, id);
    sql
      .prepare(
        "INSERT INTO spaces(id,slug,name,workspace_path,created_at,updated_at) VALUES (?,'space-a','Existing Space','/existing-native-repo',1,1)"
      )
      .run(agent.spaceId);
    agents = new SpaceLongHorizonAgentRepository(sql);
    for (const [id, sessionId] of [
      [agent.agentId, agent.sessionId],
      ['manager-B', 'manager-B-session'],
    ])
      agents.create({
        id,
        sessionId,
        spaceId: agent.spaceId,
        handle: id,
        instructions: 'Existing native responsibilities',
      });
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
    service.repo.saveConcern(
      {
        id: 'research',
        title: 'Research',
        summary: 'Existing context',
        context: 'Private context',
      },
      0
    );
    service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
    registry = createOperationRegistry(createNeoOperations(service));
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });
  const invoke = (value: unknown = input, source: OperationCaller = caller) =>
    invokeOperation(registry, 'neo.work.propose', value, source);
  const jobs = (id: string) =>
    db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: id });
  function nativeState() {
    return JSON.stringify(
      [
        'sessions',
        'spaces',
        'space_long_horizon_agents',
        'neo_session_bindings',
        'neo_concerns',
      ].map((table) => db.getDatabase().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    );
  }
  async function proposed(value: unknown = input, source: OperationCaller = caller) {
    const result = await invoke(value, source);
    expect(result).toMatchObject({
      kind: 'completed',
      value: { ok: true, work: { status: 'proposed' } },
    });
    if (result.kind !== 'completed' || !(result.value as { ok: boolean }).ok)
      throw new Error('Proposal rejected');
    return (result.value as { work: NeoWork }).work;
  }

  test('real immutable proposal creates no worker, job, role or native change before approval', async () => {
    const before = nativeState();
    const saved = await proposed();
    expect(saved).toMatchObject({
      ...origin,
      targetSessionId: agent.sessionId,
      sessionId: null,
      report: null,
    });
    expect(service.agentTargets.get(saved.id)).toEqual(agent);
    expect(service.resolveWorkTarget(saved.id)).toEqual({
      accepted: true,
      workId: saved.id,
      targetSessionId: agent.sessionId,
    });
    expect(jobs(saved.id)).toEqual([]);
    expect(nativeState()).toBe(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test('identical retries keep one atomic reservation and settled references', async () => {
    const saved = await proposed();
    expect(await proposed()).toEqual(saved);
    expect(service.repo.listWork()).toHaveLength(1);
    expect(db.getDatabase().prepare('SELECT * FROM neo_agent_work_targets').all()).toHaveLength(1);
    await service.start(saved.id);
    const queued = service.repo.getWork(saved.id)!;
    const result = await invoke();
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true, work: queued } });
    expect(service.agentTargets.get(saved.id)).toEqual(agent);
    expect(jobs(saved.id)).toHaveLength(1);
  });
  test('human approval reuses the same native recipient, tools and immutable source', async () => {
    const before = nativeState();
    const saved = await proposed();
    expect(
      await invokeOperation(registry, 'neo.work.start', { id: saved.id }, caller)
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'This action needs the user.' },
    });
    expect(service.repo.getWork(saved.id)?.status).toBe('proposed');
    expect(jobs(saved.id)).toEqual([]);
    expect(
      await invokeOperation(registry, 'neo.work.start', { id: saved.id }, human)
    ).toMatchObject({
      kind: 'completed',
      value: { ok: true, work: { id: saved.id, status: 'queued', sessionId: agent.sessionId } },
    });
    expect(jobs(saved.id)).toHaveLength(1);
    expect(jobs(saved.id)[0].payload).toMatchObject({
      to: { kind: 'session', sessionId: agent.sessionId },
      messageUuid: saved.id,
    });
    const message = jobs(saved.id)[0].payload.message as { message: { content: string } };
    expect(message.message.content).toContain(
      'Keep your current role, workspace, tools and permissions'
    );
    expect(message.message.content).toContain(JSON.stringify(saved.id));
    expect(message.message.content).toContain('neo.work.report');
    expect(service.repo.getBindingBySession(agent.sessionId)).toBeNull();
    expect(nativeState()).toBe(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test('only the actual recipient report returns the original ask without retargeting a newer one', async () => {
    const saved = await proposed();
    await service.start(saved.id);
    const report = {
      id: saved.id,
      status: 'reported',
      report: 'Evidence: bounded draft NATIVE-41; no external action.',
    };
    expect(
      await invokeOperation(registry, 'neo.work.report', report, {
        source: 'mcp',
        sessionId: 'manager-B-session',
        role: 'long_term_agent',
      })
    ).toMatchObject({
      kind: 'completed',
      value: { accepted: false, reason: 'recipient_mismatch' },
    });
    expect(service.repo.getWork(saved.id)?.status).toBe('queued');
    expect(
      await invokeOperation(registry, 'neo.work.report', report, {
        source: 'mcp',
        sessionId: agent.sessionId,
        role: 'long_term_agent',
      })
    ).toMatchObject({
      kind: 'completed',
      value: { accepted: true, workId: saved.id, replayed: false },
    });
    expect(service.repo.getWork(saved.id)).toMatchObject({
      ...origin,
      status: 'reported',
      sessionId: agent.sessionId,
      report: report.report,
    });
    const returned = jobs(saved.id).find(
      (job) => (job.payload.to as { sessionId: string }).sessionId === 'root'
    )!;
    expect(returned).toBeDefined();
    const message = returned.payload.message as { message: { content: string } };
    expect(message.message.content).toContain(JSON.stringify(origin.originMessageId));
    expect(message.message.content).toContain('untrusted evidence');
    expect(
      await invokeOperation(registry, 'neo.work.report', report, {
        source: 'mcp',
        sessionId: agent.sessionId,
      })
    ).toMatchObject({ kind: 'completed', value: { accepted: true, replayed: true } });
    expect(
      jobs(saved.id).filter((job) => (job.payload.to as { sessionId: string }).sessionId === 'root')
    ).toHaveLength(1);
  });
  test('a reused key cannot change source input or execution recipient', async () => {
    const saved = await proposed();
    expect(
      await invoke(input, { ...caller, neoTurn: { ...caller.neoTurn!, messageId: 'ask-B' } })
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'This request key belongs to another input.' },
    });
    expect(
      await invoke({
        ...input,
        targetSessionId: 'manager-B-session',
        targetAgent: { ...agent, agentId: 'manager-B', sessionId: 'manager-B-session' },
      })
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'This request key belongs to another execution target.' },
    });
    expect(service.repo.getWork(saved.id)).toEqual(saved);
    expect(service.agentTargets.get(saved.id)).toEqual(agent);
    expect(service.repo.listWork()).toHaveLength(1);
  });
  test('an old unbound reservation cannot become a native binding on retry', async () => {
    const legacy = service.repo.proposeWork({
      ...input,
      ...origin,
      id: 'legacy',
      requestKey: 'root:' + input.requestKey,
    });
    expect(await invoke()).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'This request key belongs to another native target.' },
    });
    expect(service.agentTargets.get(legacy.id)).toBeNull();
    expect(service.repo.getWork(legacy.id)).toEqual(legacy);
  });
  test.each([
    { ...input, targetSessionId: 'ordinary' },
    { ...input, targetAgent: { ...agent, spaceId: ' \n' } },
    { ...input, targetAgent: { ...agent, sessionId: 'other' } },
  ])('malformed/mismatched managed refs never reserve work: %j', async (value) => {
    expect(await invoke(value)).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'invalid_agent_reference' },
    });
    expect(service.repo.listWork()).toEqual([]);
  });
  test('a bare Space agent session id is proposed as a send to that agent', async () => {
    const reply = (await invoke({ ...input, targetAgent: undefined })) as {
      value: { ok: boolean; work: { id: string } };
    };
    expect(reply.value.ok).toBe(true);
    expect(service.driverTargets.get(reply.value.work.id)).toEqual({
      verb: 'send',
      ref: { adapter: 'space', id: 'agent:manager-A' },
    });
  });

  test('explicit target selection remains required and ordinary scope ownership is unchanged', async () => {
    expect(await invoke({ ...input, targetSessionId: undefined })).toMatchObject({
      kind: 'completed',
      value: { ok: false },
    });
    expect(
      await invoke({ ...input, targetSessionId: 'holder', targetAgent: undefined })
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringMatching(/^target_owned_context: .*work\.find/) },
    });
    expect(service.repo.listWork()).toEqual([]);
    expect(
      await proposed({ ...input, targetSessionId: 'ordinary', targetAgent: undefined })
    ).toMatchObject({ targetSessionId: 'ordinary' });
    expect(
      await invoke({
        ...input,
        requestKey: 'scratch',
        targetSessionId: null,
        targetAgent: undefined,
      })
    ).toMatchObject({ kind: 'completed', value: { ok: false } });
  });
  test('only current live bound root/holder inputs can reserve a native proposal', async () => {
    for (const source of [
      { ...caller, sessionId: 'impostor', role: 'neo' },
      { ...caller, neoTurn: undefined },
      { ...caller, neoTurn: { ...caller.neoTurn!, isLive: () => false } },
    ] as OperationCaller[])
      expect(await invoke(input, source)).toMatchObject({
        kind: 'completed',
        value: { ok: false },
      });
    expect(service.repo.listWork()).toEqual([]);
    const saved = await proposed(
      { ...input, concernId: 'research' },
      {
        ...caller,
        sessionId: 'holder',
        neoTurn: {
          messageId: 'neo-consult:one:request',
          human: false,
          consultationId: 'one',
          isLive: () => true,
        },
      }
    );
    expect(saved).toMatchObject({
      originSessionId: 'holder',
      originMessageId: 'neo-consult:one:request',
      concernId: 'research',
    });
  });
  test('an input closing during target reads is rejected immediately before atomic reservation', async () => {
    let live = true;
    const read = service.agentTargets.readOwner.bind(service.agentTargets);
    const owner = spyOn(service.agentTargets, 'readOwner').mockImplementation((ref) => {
      live = false;
      return read(ref);
    });
    try {
      expect(
        await invoke(input, { ...caller, neoTurn: { ...caller.neoTurn!, isLive: () => live } })
      ).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'A live Neo input is required to propose work.' },
      });
      expect(service.repo.listWork()).toEqual([]);
      expect(db.getDatabase().prepare('SELECT * FROM neo_agent_work_targets').all()).toEqual([]);
    } finally {
      owner.mockRestore();
    }
  });
  test.each(['paused', 'disabled', 'archived'])(
    'native manager %s blocks proposals',
    async (status) => {
      db.getDatabase()
        .prepare('UPDATE space_long_horizon_agents SET status=? WHERE id=?')
        .run(status, agent.agentId);
      expect(await invoke()).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'target_agent_not_active' },
      });
      expect(service.repo.listWork()).toEqual([]);
    }
  );
  test('owner drift after proposal blocks approval without loading/reassigning a replacement', async () => {
    const saved = await proposed();
    db.getDatabase()
      .prepare('UPDATE space_long_horizon_agents SET session_id=? WHERE id=?')
      .run('ordinary', agent.agentId);
    expect(
      await invokeOperation(registry, 'neo.work.start', { id: saved.id }, human)
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'target_agent_unavailable' },
    });
    expect(service.repo.getWork(saved.id)).toEqual(saved);
    expect(jobs(saved.id)).toEqual([]);
    expect(service.agentTargets.get(saved.id)).toEqual(agent);
    expect(createSession).not.toHaveBeenCalled();
  });
  test('Space pause after proposal retains an unexecuted immutable receipt', async () => {
    const saved = await proposed();
    db.getDatabase().prepare('UPDATE spaces SET paused=1 WHERE id=?').run(agent.spaceId);
    expect(
      await invokeOperation(registry, 'neo.work.start', { id: saved.id }, human)
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'target_space_not_active' },
    });
    expect(service.repo.getWork(saved.id)).toEqual(saved);
    expect(jobs(saved.id)).toEqual([]);
  });
  test('atomic repository failure cannot leave half a new native reservation', () => {
    expect(() =>
      service.agentTargets.propose(
        service.repo,
        { ...input, ...origin, id: 'broken', requestKey: 'broken' },
        { ...agent, sessionId: 'different' }
      )
    ).toThrow('Native target reservation failed');
    expect(service.repo.getWork('broken')).toBeNull();
    expect(service.agentTargets.get('broken')).toBeNull();
  });
});
