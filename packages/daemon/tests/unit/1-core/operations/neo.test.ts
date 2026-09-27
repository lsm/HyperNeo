import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService, neoWorkScratchDir } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { neoCoordinatorBinding, restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation, isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const concern = {
  id: 'book-club',
  title: 'Book club',
  summary: 'Sunday afternoons',
  context: 'Six people, free venue',
  expectedRevision: 0,
};

describe('Neo MVP', () => {
  let sqlite: SQLite;
  let service: NeoService;
  let db: Database;
  let sessions: SessionManager;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let created: CreateSessionParams[];
  let active: Set<string>;
  let jobs: { payload: Record<string, unknown> }[];
  let terminal: boolean;
  let failed: string | null;
  let delivered: Set<string>;
  let interrupt: ReturnType<typeof mock>;

  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createNeoTables(sqlite);
    runMigration279(sqlite);
    created = [];
    active = new Set();
    jobs = [];
    terminal = false;
    failed = null;
    delivered = new Set();
    interrupt = mock(async () => {});
    const queue = {
      listActiveByPayload: (_queue: string, match: Record<string, unknown>) =>
        jobs.filter(
          ({ payload }) =>
            (payload.to as { sessionId: string }).sessionId === match['to.sessionId'] &&
            payload.messageUuid === match.messageUuid
        ),
      enqueueUniquePending: (job: { payload: Record<string, unknown> }) => {
        jobs.push(job);
        return { id: String(jobs.length) };
      },
    };
    db = {
      getDatabase: () => sqlite,
      getSession: (id: string) => (active.has(id) ? { id } : null),
      getJobQueueRepo: () => queue,
      getSDKMessageRepo: () => ({
        findMessageIdByUuid: (id: string, uuid: string) =>
          delivered.has(`${id}:${uuid}`) ? uuid : null,
        hasTerminalResultAfter: () => terminal,
        getErrorTerminalResultSubtypeAfter: () => failed,
        getAssistantMessagesSince: () => [
          {
            id: 'reply',
            text: 'A quiet library room is a possible free venue.',
            toolCallNames: [],
          },
        ],
      }),
    } as unknown as Database;
    sessions = {
      createSession: async (params: CreateSessionParams) => {
        created.push(params);
        active.add(params.sessionId!);
        return params.sessionId;
      },
      getSessionAsync: async () => ({ handleInterrupt: interrupt }),
    } as unknown as SessionManager;
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
  });
  afterEach(() => {
    service.dispose();
    sqlite.close();
  });

  async function invoke(name: string, input: unknown = {}, caller = human) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      caller
    );
  }
  async function propose() {
    const root = await service.open(null);
    return service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      concernId: null,
      originSessionId: root,
      title: 'Suggest venues',
      instruction: 'Suggest three free venues. Do not book anything.',
    });
  }

  test('opening is idempotent, independent of concern creation and uses constrained coordinator sessions', async () => {
    const ids = await Promise.all([service.open(null), service.open(null), service.open(null)]);
    expect(new Set(ids).size).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].config).toMatchObject({
      permissionMode: 'dontAsk',
      sdkToolsPreset: ['AskUserQuestion'],
    });
    expect(service.repo.listConcerns()).toEqual([]);
    expect(await service.open(null)).toBe(ids[0]);
    expect(neoCoordinatorBinding(db, ids[0])?.kind).toBe('neo');
    expect(neoCoordinatorBinding(db, 'ordinary')).toBeNull();
  });

  test('real operation pipeline saves with revision protection and reuses durable contexts', async () => {
    expect(await invoke('neo.concern.save', concern)).toMatchObject({
      kind: 'completed',
      value: { ok: true, concern: { revision: 1 } },
    });
    expect(await invoke('neo.concern.save', { ...concern, context: 'Lost update' })).toMatchObject({
      kind: 'completed',
      value: { ok: false },
    });
    const id = await service.open(concern.id);
    expect(await service.open(concern.id)).toBe(id);
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: { concerns: [{ context: concern.context }] },
    });
    const root = await service.open(null);
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root })
    ).toMatchObject({ value: { concerns: [{ context: '' }] } });
  });

  test('opening a missing concern reports a domain rejection instead of an execution fault', async () => {
    expect(await invoke('neo.open', { concernId: 'gone' })).toMatchObject({
      value: { ok: false, reason: 'Concern not found.' },
    });
    expect(created).toHaveLength(0);
  });

  test('trusts bindings, not a claimed role; concern holders cannot read or mutate other contexts', async () => {
    await invoke('neo.concern.save', concern);
    const id = await service.open(concern.id);
    const caller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: id };
    expect(await invoke('neo.snapshot', { concernId: 'private' }, caller)).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.concern.save', { ...concern, id: 'private' }, caller)).toMatchObject({
      value: { ok: false },
    });
    expect(
      await invoke(
        'neo.work.propose',
        { requestKey: 'one', concernId: null, title: 'Other', instruction: 'Do this' },
        caller
      )
    ).toMatchObject({ value: { ok: false } });
    expect(await invoke('neo.snapshot', {}, { ...caller, sessionId: 'impostor' })).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.work.start', { id: 'work' }, caller)).toMatchObject({
      kind: 'failed',
      code: 'forbidden',
    });
    const definitions = createNeoOperations(service);
    expect(
      listOperationSummaries(createOperationRegistry(definitions), caller, true).map(
        (item) => item.name
      )
    ).toEqual([
      'neo.concern.consult',
      'neo.concern.respond',
      'neo.snapshot',
      'neo.concern.save',
      'neo.work.propose',
    ]);
    expect(isOperationAdmitted({ ...definitions[0], name: 'session.create' }, caller)).toBe(false);
    expect(
      isOperationAdmitted(
        { ...definitions[0], name: 'session.create' },
        { source: 'mcp', role: 'universal_read' }
      )
    ).toBe(true);
    expect(service.repo.getConcern('private')).toBeNull();
  });

  test('proposals do not execute; duplicate Starts reuse one real session and durable handoff', async () => {
    const work = await propose();
    expect(created).toHaveLength(1);
    expect(jobs).toHaveLength(0);
    await Promise.all([service.start(work.id), service.start(work.id)]);
    await service.start(work.id);
    expect(created).toHaveLength(2);
    expect(jobs).toHaveLength(1);
    const saved = service.repo.getWork(work.id)!;
    expect(saved.status).toBe('queued');
    expect(saved.sessionId).not.toBe(work.originSessionId);
    expect(jobs[0].payload).toMatchObject({
      to: { kind: 'session', sessionId: saved.sessionId },
      messageUuid: work.id,
    });
    expect(service.repo.getBindingBySession(saved.sessionId!)?.kind).toBe('worker');
    expect(created[0].workspacePath).toBeNull();
    expect(created[1].workspacePath).toBe(neoWorkScratchDir(saved.sessionId!));
    expect(created[1].worktreeMode).toBe('direct');
    expect(created[1].workspacePath).toContain('hyperneo-neo-work');
  });

  test('a response returns through the mailbox only after a terminal result and recovers without duplication', async () => {
    const work = await propose();
    await service.start(work.id);
    await service.reconcile(work.id);
    expect(service.repo.getWork(work.id)?.status).toBe('queued');
    terminal = true;
    const sessionId = service.repo.getWork(work.id)!.sessionId!;
    await events.publish('session.updated', { sessionId, processingState: { status: 'idle' } });
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'reported',
      report: 'A quiet library room is a possible free venue.',
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[1].payload).toMatchObject({
      to: { sessionId: work.originSessionId },
      messageUuid: work.id,
    });
    await service.recover();
    expect(jobs).toHaveLength(2);
    delivered.add(`${work.originSessionId}:${work.id}`);
    jobs = [];
    await service.recover();
    expect(jobs).toHaveLength(0);
  });

  test('reports runtime failure rather than successful completion', async () => {
    const work = await propose();
    await service.start(work.id);
    failed = 'error_max_turns';
    await service.reconcile(work.id);
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'failed',
      report: expect.stringContaining('error_max_turns'),
    });
  });

  test('a failed session launch is visible instead of staying handed-off forever', async () => {
    const work = await propose();
    sessions.createSession = mock(async () => {
      throw new Error('Workspace unavailable');
    });
    await expect(service.start(work.id)).rejects.toThrow('Workspace unavailable');
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'failed',
      report: expect.stringContaining('Workspace unavailable'),
    });
    expect(jobs).toHaveLength(0);
  });

  test('cancellation during session creation cannot enqueue work afterwards', async () => {
    const work = await propose();
    const originalCreate = sessions.createSession;
    let release: () => void = () => {};
    sessions.createSession = async (params) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalCreate(params);
    };
    const starting = service.start(work.id);
    const cancelling = service.cancel(work.id);
    release();
    await Promise.all([starting, cancelling]);
    expect(service.repo.getWork(work.id)?.status).toBe('cancelled');
    expect(jobs).toHaveLength(0);
    expect(interrupt).toHaveBeenCalledWith({ skipDeferredReplay: true });
  });

  test('cancelled proposals never start and running work is interrupted without replay', async () => {
    const first = await propose();
    await service.cancel(first.id);
    await service.start(first.id);
    expect(jobs).toHaveLength(0);
    expect(created).toHaveLength(1);
    const second = await propose();
    await service.start(second.id);
    await service.cancel(second.id);
    terminal = true;
    await service.reconcile(second.id);
    expect(service.repo.getWork(second.id)?.status).toBe('cancelled');
    expect(interrupt).toHaveBeenCalledWith({ skipDeferredReplay: true });
    expect(jobs).toHaveLength(1);
  });

  test('query restriction removes coding tools, plugins, settings and extra MCP servers', () => {
    const operationServer = { type: 'stdio' as const, command: 'operations' };
    const options: Options = {
      tools: ['Bash', 'Read'],
      plugins: [{ type: 'local', path: '/plugin' }],
      settingSources: ['user', 'project'],
      mcpServers: { 'hyperneo-operations': operationServer, unsafe: { command: 'other' } },
      agent: 'coder',
      agents: { coder: { description: 'work', prompt: 'work' } },
    };
    restrictNeoQuery(options);
    expect(options.tools).toEqual(['AskUserQuestion']);
    expect(options.mcpServers).toEqual({ 'hyperneo-operations': operationServer });
    expect(options.allowedTools).toEqual(['AskUserQuestion', 'mcp__hyperneo-operations__invoke']);
    expect(options.plugins).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.agent).toBeUndefined();
    expect(options.agents).toEqual({});
  });

  async function consultation() {
    await invoke('neo.concern.save', concern);
    const root = await service.open(null);
    const caller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: root };
    const input = {
      concernId: concern.id,
      requestKey: 'ask-once',
      question: 'What venue fits our constraints?',
    };
    expect(await invoke('neo.concern.consult', input, caller)).toMatchObject({
      kind: 'completed',
      value: { ok: true, consultation: { status: 'pending' } },
    });
    const item = service.consultations.list()[0];
    const holder: OperationCaller = { source: 'mcp', role: 'neo', sessionId: item.sessionId };
    return { item, caller, holder, input };
  }

  test('consults the persistent holder once, returns through the mailbox, and starts no worker', async () => {
    const { item, caller, holder, input } = await consultation();
    await Promise.all([
      invoke('neo.concern.consult', input, caller),
      invoke('neo.concern.consult', input, caller),
    ]);
    expect(service.consultations.list()).toHaveLength(1);
    expect(service.repo.listWork()).toHaveLength(0);
    expect(created).toHaveLength(2);
    expect(service.repo.getBindingBySession(item.sessionId)?.kind).toBe('concern');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      to: { sessionId: item.sessionId },
      messageUuid: `neo-consult:${item.id}:request`,
    });
    expect(JSON.stringify(jobs[0].payload)).toContain(input.question);
    const answer = 'Use a free living room on Sunday. No booking has been made.';
    expect(await invoke('neo.concern.respond', { id: item.id, answer }, holder)).toMatchObject({
      value: { ok: true, consultation: { status: 'reported', answer } },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[1].payload).toMatchObject({
      to: { sessionId: caller.sessionId },
      messageUuid: `neo-consult:${item.id}:reply`,
    });
    expect(JSON.stringify(jobs[1].payload)).toContain(answer);
    await invoke('neo.concern.respond', { id: item.id, answer }, holder);
    await service.recover();
    expect(jobs).toHaveLength(2);
    expect(service.consultations.unsettled()).toEqual([]);
    expect(
      await invoke('neo.concern.respond', { id: item.id, answer: 'Overwrite' }, holder)
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.get(item.id)?.answer).toBe(answer);
    expect(created).toHaveLength(2);
  });

  test('admits root consultations only and attributes replies to the exact assigned holder', async () => {
    const { item, caller, holder, input } = await consultation();
    await invoke('neo.concern.save', { ...concern, id: 'private' });
    const other = await service.open('private');
    service.repo.reserveBinding({ sessionId: 'worker', concernId: concern.id, kind: 'worker' });
    for (const denied of [
      human,
      holder,
      { ...caller, sessionId: other },
      { ...caller, sessionId: 'worker' },
      { ...caller, sessionId: 'impostor' },
    ]) {
      expect(await invoke('neo.concern.consult', input, denied)).toMatchObject({
        value: { ok: false },
      });
    }
    for (const denied of [
      human,
      caller,
      { ...holder, sessionId: other },
      { ...holder, sessionId: 'worker' },
      { ...holder, sessionId: 'impostor' },
    ]) {
      expect(
        await invoke('neo.concern.respond', { id: item.id, answer: 'Forged' }, denied)
      ).toMatchObject({ value: { ok: false } });
    }
    expect(service.consultations.get(item.id)?.status).toBe('pending');
    expect(jobs).toHaveLength(1);
    expect(await invoke('neo.snapshot', {}, { ...holder, sessionId: other })).toMatchObject({
      value: { consultations: [] },
    });
    expect(await invoke('neo.snapshot', {}, caller)).toMatchObject({
      value: { consultations: [{ question: '', answer: null }] },
    });
    expect(await invoke('neo.snapshot', { concernId: concern.id }, caller)).toMatchObject({
      value: { concerns: [{ context: '' }], consultations: [{ question: '', answer: null }] },
    });
    expect(await invoke('neo.snapshot', {}, holder)).toMatchObject({
      value: { consultations: [{ question: input.question }] },
    });
  });

  test('rejects conflicting request keys and simultaneous different questions without losing the first request', async () => {
    const { item, caller, input } = await consultation();
    for (const change of [
      { question: 'Changed question' },
      { requestKey: 'second-question' },
      { concernId: 'missing' },
    ]) {
      expect(await invoke('neo.concern.consult', { ...input, ...change }, caller)).toMatchObject({
        value: { ok: false },
      });
    }
    expect(service.consultations.list()).toEqual([item]);
    expect(jobs).toHaveLength(1);
  });

  test('recovers undelivered requests and finished replies across service restart', async () => {
    const { item } = await consultation();
    jobs = [];
    service.dispose();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    await service.recover();
    expect(jobs).toHaveLength(1);
    delivered.add(`${item.sessionId}:neo-consult:${item.id}:request`);
    jobs = [];
    await service.recover();
    expect(jobs).toHaveLength(0);
    service.consultations.finish(item.id, 'reported', 'Recovered answer');
    await service.recover();
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0].payload)).toContain('Recovered answer');
    await service.recover();
    expect(jobs).toHaveLength(1);
  });

  test.each([null, 'error_max_turns'])(
    'returns an explicit failure when the holder ends without responding (%s)',
    async (failure) => {
      const { item, holder } = await consultation();
      await service.syncConsultation(item.id);
      expect(service.consultations.get(item.id)?.status).toBe('pending');
      terminal = true;
      failed = failure;
      await events.publish('session.updated', {
        sessionId: item.sessionId,
        processingState: { status: 'idle' },
      });
      expect(service.consultations.get(item.id)).toMatchObject({
        status: 'failed',
        answer: expect.any(String),
      });
      expect(jobs).toHaveLength(2);
      expect(
        await invoke('neo.concern.respond', { id: item.id, answer: 'Late reply' }, holder)
      ).toMatchObject({ value: { ok: false } });
    }
  );

  test('bounds questions and responses before they enter durable context', async () => {
    const { item, caller, holder, input } = await consultation();
    expect(
      await invoke('neo.concern.consult', { ...input, question: 'x'.repeat(8001) }, caller)
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(
      await invoke('neo.concern.respond', { id: item.id, answer: 'x'.repeat(4001) }, holder)
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(service.consultations.get(item.id)?.status).toBe('pending');
  });

  test('root may create a concern but only its holder or the human may revise its context', async () => {
    const root = await service.open(null);
    const caller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: root };
    expect(await invoke('neo.concern.save', concern, caller)).toMatchObject({
      value: { ok: true },
    });
    const correction = { ...concern, expectedRevision: 1, context: 'Host at my home' };
    expect(await invoke('neo.concern.save', correction, caller)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('Consult') },
    });
    expect(service.repo.getConcern(concern.id)?.context).toBe(concern.context);
    const holder = await service.open(concern.id);
    expect(
      await invoke('neo.concern.save', correction, { ...caller, sessionId: holder })
    ).toMatchObject({ value: { ok: true, concern: { context: correction.context } } });
    expect(
      await invoke('neo.concern.save', { ...correction, expectedRevision: 2 }, human)
    ).toMatchObject({ value: { ok: true } });
  });
});
