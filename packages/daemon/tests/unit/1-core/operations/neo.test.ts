import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration280 } from '../../../../src/storage/schema/m280-neo-context-write-grants.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration285 } from '../../../../src/storage/schema/m285-neo-consultation-waiters.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService, neoWorkScratchDir } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  neoCoordinatorBinding,
  neoCoordinatorRuntimePath,
  restrictNeoQuery,
} from '../../../../src/lib/neo/session-policy.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation, isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';
import {
  CONSULTATION_EXPIRED,
  CONSULTATION_STOPPED,
  CONSULTATION_TIMEOUT_MS,
} from '../../../../src/lib/neo/consultation-policy.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const concern = {
  id: 'book-club',
  title: 'Book club',
  summary: 'Sunday afternoons',
  context: 'Six people, free venue',
  expectedRevision: 0,
};

describe('Neo MVP', () => {
  test('root prompt requires real cards and honors explicit context retention', () => {
    const prompt = neoPrompt(null);
    expect(prompt).toContain('permission to create its record now');
    expect(prompt).toContain('call neo.work.propose in that turn');
    expect(prompt).toContain('never render a pretend card');
    expect(prompt).toContain('Start work button is the approval to execute');
    expect(prompt).toContain('no implicit project, workspace, folder, repository or worktree');
    expect(prompt).toContain('ask one short clarifying question');
  });

  let sqlite: SQLite;
  let service: NeoService;
  let db: Database;
  let sessions: SessionManager;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let created: CreateSessionParams[];
  let active: Set<string>;
  let jobs: { payload: Record<string, unknown> }[];
  let terminal: boolean;
  let terminalSessions: Set<string> | null;
  let failed: string | null;
  let delivered: Set<string>;
  let interrupt: ReturnType<typeof mock>;

  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createNeoTables(sqlite);
    runMigration279(sqlite);
    runMigration280(sqlite);
    runMigration282(sqlite);
    runMigration283(sqlite);
    runMigration285(sqlite);
    created = [];
    active = new Set();
    jobs = [];
    terminal = false;
    terminalSessions = null;
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
        getStoredPromptsByUuid: () => [{ type: 'user', inputKind: 'human' }],
        findMessageIdByUuid: (id: string, uuid: string) =>
          delivered.has(`${id}:${uuid}`) ? uuid : null,
        hasTerminalResultAfter: (id: string) => terminalSessions?.has(id) ?? terminal,
        getErrorTerminalResultSubtypeAfter: (id: string) =>
          terminalSessions && !terminalSessions.has(id) ? null : failed,
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
  function holderInput(sessionId: string, consultationId?: string): OperationCaller {
    return {
      source: 'mcp',
      role: 'neo',
      sessionId,
      neoTurn: {
        messageId: consultationId ? `neo-consult:${consultationId}:request` : 'human-message',
        consultationId,
        human: !consultationId,
        isLive: () => true,
      },
    };
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
      sdkToolsPreset: [],
      allowedTools: ['mcp__hyperneo-operations__invoke'],
    });
    expect(created[0].workspacePath).toBeNull();
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
    expect(created[0].config).toMatchObject({
      sdkToolsPreset: ['AskUserQuestion'],
      allowedTools: ['AskUserQuestion', 'mcp__hyperneo-operations__invoke'],
    });
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: { concerns: [{ context: concern.context }] },
    });
    const root = await service.open(null);
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root })
    ).toMatchObject({ value: { concerns: [{ context: '' }] } });
  });

  test('work origin message ids survive the snapshot boundary in every state', async () => {
    service.repo.saveConcern({ id: 'book-club', title: 'Book club', summary: '', context: '' }, 0);
    const root = await service.open(null);
    const states = ['proposed', 'queued', 'reported'] as const;
    const works = states.map((state) => {
      const work = service.repo.proposeWork({
        id: `origin-${state}`,
        requestKey: `origin-${state}`,
        concernId: 'book-club',
        originSessionId: root,
        originMessageId: `ask-${state}`,
        title: `Origin-bearing ${state}`,
        instruction: 'Draft a plan.',
      });
      if (state === 'queued')
        service.repo.transitionWork(work.id, work, { status: 'queued', sessionId: 'exec' });
      if (state === 'reported')
        service.repo.transitionWork(
          work.id,
          { status: 'proposed', sessionId: null, report: null },
          { status: 'reported', report: 'Done.' }
        );
      return work;
    });
    expect(works.map((work) => work.originMessageId)).toEqual([
      'ask-proposed',
      'ask-queued',
      'ask-reported',
    ]);
    const snapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string; status: string; originMessageId: string | null }> };
    };
    const byState = new Map(snapshot.value.work.map((item) => [item.status, item]));
    for (const state of states) {
      expect(byState.get(state)?.originMessageId).toBe(`ask-${state}`);
    }
  });

  test('human snapshots retain a bounded set of older actionable work', async () => {
    service.repo.saveConcern({ id: 'book-club', title: 'Book club', summary: '', context: '' }, 0);
    const root = await service.open(null);
    const oldest = service.repo.proposeWork({
      id: 'oldest',
      requestKey: 'oldest',
      concernId: 'book-club',
      originSessionId: root,
      title: 'Still needs a decision',
      instruction: 'Draft a plan.',
    });
    sqlite.prepare('UPDATE neo_work SET created_at = 1 WHERE id = ?').run(oldest.id);
    const queued = service.repo.proposeWork({
      id: 'queued',
      requestKey: 'queued',
      concernId: 'book-club',
      originSessionId: root,
      title: 'Still running',
      instruction: 'Draft a plan.',
    });
    service.repo.transitionWork(queued.id, queued, {
      status: 'queued',
      sessionId: 'queued-session',
    });
    sqlite.prepare('UPDATE neo_work SET created_at = 2 WHERE id = ?').run(queued.id);
    for (let index = 0; index < 50; index++) {
      const item = service.repo.proposeWork({
        id: `recent-${index}`,
        requestKey: `recent-${index}`,
        concernId: 'book-club',
        originSessionId: root,
        title: 'Completed work',
        instruction: 'Draft a plan.',
      });
      service.repo.transitionWork(
        item.id,
        { status: 'proposed', sessionId: null, report: null },
        { status: 'reported', report: 'Done.' }
      );
    }
    const rootSnapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string }> };
    };
    expect(rootSnapshot.value.work).toHaveLength(52);
    expect(rootSnapshot.value.work.at(-1)?.id).toBe(oldest.id);
    expect(rootSnapshot.value.work.some((item) => item.id === queued.id)).toBe(true);
    const concernSnapshot = (await invoke('neo.snapshot', { concernId: 'book-club' })) as {
      value: { work: Array<{ id: string }> };
    };
    expect(concernSnapshot.value.work.some((item) => item.id === oldest.id)).toBe(true);
    expect(concernSnapshot.value.work.some((item) => item.id === queued.id)).toBe(true);
    const agentSnapshot = (await invoke(
      'neo.snapshot',
      {},
      { source: 'mcp', role: 'neo', sessionId: root }
    )) as {
      value: { work: Array<{ id: string }> };
    };
    expect(agentSnapshot.value.work).toHaveLength(10);
    expect(agentSnapshot.value.work.some((item) => item.id === oldest.id)).toBe(false);
    expect(agentSnapshot.value.work.some((item) => item.id === queued.id)).toBe(false);
    for (let index = 0; index < 50; index++) {
      const item = service.repo.proposeWork({
        id: `extra-${index}`,
        requestKey: `extra-${index}`,
        concernId: 'book-club',
        originSessionId: root,
        title: 'Another decision',
        instruction: 'Draft a plan.',
      });
      sqlite.prepare('UPDATE neo_work SET created_at = ? WHERE id = ?').run(index + 3, item.id);
    }
    const boundedSnapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string }> };
    };
    expect(boundedSnapshot.value.work).toHaveLength(100);
    expect(boundedSnapshot.value.work.some((item) => item.id === 'extra-0')).toBe(true);
    expect(boundedSnapshot.value.work.some((item) => item.id === oldest.id)).toBe(false);
    expect(boundedSnapshot.value.work.some((item) => item.id === queued.id)).toBe(false);
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
      kind: 'completed',
      value: { ok: false, reason: 'This action needs the user.' },
    });
    const definitions = createNeoOperations(service);
    expect(
      listOperationSummaries(createOperationRegistry(definitions), caller, true).map(
        (item) => item.name
      )
    ).toEqual([
      'neo.message.send',
      'neo.publication.publish',
      'neo.concern.cancel',
      'neo.concern.consult',
      'neo.concern.respond',
      'neo.open',
      'neo.snapshot',
      'neo.concern.save',
      'neo.work.propose',
      'neo.work.report',
      'neo.work.start',
      'neo.work.cancel',
    ]);
    expect(isOperationAdmitted({ ...definitions[0], name: 'session.create' }, caller)).toBe(true);
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

  test.each([null, concern.id])(
    'work origins survive %s MCP retries, successor inputs and returns',
    async (scope) => {
      await invoke('neo.concern.save', concern);
      const sessionId = await service.open(scope);
      const attempts = new QueryAttemptRegistry();
      const first = new NeoHolderTurn(db, sessionId, attempts.allocate(), () => {});
      const turns = [first];
      const registry = createOperationRegistry(createNeoOperations(service));
      const handler = (turn: NeoHolderTurn) =>
        createOperationMcpHandler(registry, () => ({
          sessionId,
          role: 'neo',
          neoTurn: turn.identity(),
        }));
      const request = {
        name: 'neo.work.propose',
        input: {
          requestKey: 'first',
          concernId: scope,
          targetSessionId: null,
          title: 'Draft an agenda',
          instruction: 'Draft only.',
          originMessageId: 'forged',
          neoTurn: { messageId: 'forged' },
        },
        caller: { source: 'rpc', principal: 'local' },
      };
      try {
        first.bind('ask-A');
        const receipt = JSON.parse((await handler(first)(request)).content[0].text);
        expect(receipt).toMatchObject({
          ok: true,
          work: {
            originSessionId: sessionId,
            originMessageId: 'ask-A',
            status: 'proposed',
            sessionId: null,
          },
        });
        expect(JSON.parse((await handler(first)(request)).content[0].text)).toEqual(receipt);
        const next = new NeoHolderTurn(db, sessionId, attempts.allocate(), () => {});
        turns.push(next);
        next.bind('ask-B');
        expect(JSON.parse((await handler(first)(request)).content[0].text)).toMatchObject({
          ok: false,
        });
        expect(JSON.parse((await handler(next)(request)).content[0].text)).toMatchObject({
          ok: false,
          reason: 'This request key belongs to another input.',
        });
        expect(service.repo.listWork()).toEqual([receipt.work]);
        const independent = { ...request, input: { ...request.input, requestKey: 'second' } };
        expect(JSON.parse((await handler(next)(independent)).content[0].text)).toMatchObject({
          ok: true,
          work: { originMessageId: 'ask-B' },
        });
        expect(service.repo.listWork()).toHaveLength(2);
        expect(jobs).toHaveLength(0);
        expect(created).toHaveLength(1);
        expect(await invoke('neo.snapshot')).toMatchObject({
          value: {
            work: expect.arrayContaining([
              expect.objectContaining({
                id: receipt.work.id,
                originSessionId: sessionId,
                originMessageId: 'ask-A',
              }),
            ]),
          },
        });
        await service.start(receipt.work.id);
        terminal = true;
        await service.reconcile(receipt.work.id);
        if (scope) {
          const review = service.consultations.get(`neo-work:${receipt.work.id}:review`)!;
          expect(review.originMessageId).toBeNull();
          expect(review.question).toContain(`"originSessionId":"${sessionId}"`);
          expect(review.question).toContain('"originMessageId":"ask-A"');
        } else {
          const response = jobs.find(
            (job) =>
              job.payload.messageUuid === receipt.work.id &&
              (job.payload.to as { sessionId: string }).sessionId === sessionId
          )!;
          const content = (response.payload.message as { message: { content: string } }).message
            .content;
          expect(content).toContain(`"originSessionId":"${sessionId}"`);
          expect(content).toContain('"originMessageId":"ask-A"');
        }
        expect(service.repo.getWork(receipt.work.id)?.originMessageId).toBe('ask-A');
      } finally {
        turns.forEach((turn) => turn.dispose());
      }
    }
  );

  test('work reservation rechecks a live input after admission', async () => {
    const root = await service.open(null);
    let checks = 0;
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: root,
      neoTurn: { messageId: 'ask-A', human: true, isLive: () => ++checks === 1 },
    };
    expect(
      await invoke(
        'neo.work.propose',
        {
          requestKey: 'one',
          title: 'Draft only',
          instruction: 'Draft only',
          targetSessionId: null,
        },
        caller
      )
    ).toMatchObject({ value: { ok: false } });
    expect(checks).toBe(2);
    expect(service.repo.listWork()).toEqual([]);
  });

  test('manual work proposals stay unknown and missing-input MCP proposals cannot mutate storage', async () => {
    const root = await service.open(null);
    const input = {
      requestKey: 'manual',
      title: 'Draft only',
      instruction: 'Draft only',
      originMessageId: 'forged',
    };
    expect(
      await invoke('neo.work.propose', input, { source: 'mcp', sessionId: root })
    ).toMatchObject({ value: { ok: false } });
    expect(service.repo.listWork()).toEqual([]);
    expect(await invoke('neo.work.propose', input)).toMatchObject({
      value: { ok: true, work: { originMessageId: null, originSessionId: root } },
    });
    expect(service.repo.listWork()).toHaveLength(1);
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

  async function concernWork(origin?: string) {
    service.repo.saveConcern(concern, 0);
    const root = await service.open(null);
    const work = service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      concernId: concern.id,
      originSessionId: origin ?? root,
      title: 'Suggest venues',
      instruction: 'Suggest free venues, do not book anything.',
    });
    await service.start(work.id);
    const saved = service.repo.getWork(work.id)!;
    terminalSessions ??= new Set();
    terminalSessions.add(saved.sessionId!);
    return { work: saved, root };
  }

  test.each(['root', 'holder'])(
    'routes %s-origin work through its holder before root Neo',
    async (origin) => {
      service.repo.saveConcern(concern, 0);
      const holderId = await service.open(concern.id);
      const { work, root } = await concernWork(origin === 'holder' ? holderId : undefined);
      await Promise.all([service.reconcile(work.id), service.reconcile(work.id)]);
      const review = service.consultations.get(`neo-work:${work.id}:review`)!;
      expect(review).toMatchObject({
        concernId: concern.id,
        originSessionId: root,
        sessionId: holderId,
        status: 'pending',
      });
      expect(review.question).toContain(work.id);
      expect(review.question).toContain('untrusted data');
      expect(review.question).toContain('A quiet library room');
      expect(jobs).toHaveLength(2);
      expect(jobs[1].payload).toMatchObject({
        to: { sessionId: holderId },
        messageUuid: `neo-consult:${review.id}:request`,
      });
      expect(service.repo.getConcern(concern.id)?.context).toBe(concern.context);
      const holder: OperationCaller = { source: 'mcp', role: 'neo', sessionId: holderId };
      expect(
        await invoke(
          'neo.concern.respond',
          { id: review.id, answer: 'A venue was suggested, not booked.' },
          holder
        )
      ).toMatchObject({ value: { ok: true } });
      expect(jobs).toHaveLength(3);
      expect(jobs[2].payload).toMatchObject({
        to: { sessionId: root },
        messageUuid: `neo-consult:${review.id}:reply`,
      });
      expect(JSON.stringify(jobs[2])).toContain('A venue was suggested, not booked.');
      expect(JSON.stringify(jobs[2])).not.toContain('A quiet library room');
      await service.recover();
      expect(jobs).toHaveLength(3);
      expect(service.repo.listWork()).toHaveLength(1);
      expect(created).toHaveLength(3);
    }
  );

  test('retains busy-holder reports and drains them after the current consultation settles', async () => {
    const { item, holder } = await consultation();
    const first = await concernWork();
    const second = await concernWork();
    await service.reconcile(first.work.id);
    await service.reconcile(second.work.id);
    expect(service.consultations.list()).toHaveLength(1);
    expect(service.repo.listWork().every((work) => work.status === 'reported')).toBe(true);
    await invoke('neo.concern.respond', { id: item.id, answer: 'Initial answer' }, holder);
    const review = service.consultations.list().find((value) => value.status === 'pending')!;
    expect(review.id).not.toBe(item.id);
    await invoke('neo.concern.respond', { id: review.id, answer: 'First report reviewed' }, holder);
    const next = service.consultations.list().find((value) => value.status === 'pending')!;
    expect(next.id).not.toBe(review.id);
    await invoke('neo.concern.respond', { id: next.id, answer: 'Second report reviewed' }, holder);
    expect(service.consultations.unsettled()).toEqual([]);
    expect(service.consultations.list()).toHaveLength(3);
    expect(jobs).toHaveLength(8);
    expect(service.repo.listWork()).toHaveLength(2);
  });

  test('restarts with a saved result without executing again or duplicating the holder review', async () => {
    const { work } = await concernWork();
    await service.reconcile(work.id);
    const review = service.consultations.list()[0];
    const workerCount = created.length;
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
    expect(jobs[0].payload).toMatchObject({
      to: { sessionId: review.sessionId },
      messageUuid: `neo-consult:${review.id}:request`,
    });
    await service.recover();
    expect(jobs).toHaveLength(1);
    expect(created).toHaveLength(workerCount);
    expect(service.consultations.list()).toHaveLength(1);
  });

  test('preserves failed execution evidence for holder interpretation', async () => {
    const { work } = await concernWork();
    failed = 'error_max_turns';
    await service.reconcile(work.id);
    const review = service.consultations.list()[0];
    expect(review.status).toBe('pending');
    expect(review.question).toContain('error_max_turns');
    expect(review.question).toContain('"status":"failed"');
    expect(service.repo.getWork(work.id)?.status).toBe('failed');
  });

  test('recovers a reserved review after its mailbox handoff fails', async () => {
    const { work } = await concernWork();
    const queue = db.getJobQueueRepo();
    const enqueue = queue.enqueueUniquePending;
    queue.enqueueUniquePending = mock(() => {
      throw new Error('Mailbox unavailable');
    });
    await expect(service.reconcile(work.id)).rejects.toThrow('Mailbox unavailable');
    const review = service.consultations.list()[0];
    expect(review.status).toBe('pending');
    expect(service.repo.getWork(work.id)?.status).toBe('reported');
    queue.enqueueUniquePending = enqueue;
    await service.recover();
    expect(jobs).toHaveLength(2);
    expect(jobs[1].payload).toMatchObject({
      messageUuid: `neo-consult:${review.id}:request`,
    });
    expect(service.consultations.list()).toHaveLength(1);
  });

  test.each(['queued', 'delivered'])(
    'does not replay historical %s raw returns through a holder',
    async (state) => {
      const { work, root } = await concernWork();
      service.repo.transitionWork(work.id, work, { status: 'reported', report: 'Old result' });
      jobs = [];
      if (state === 'delivered') delivered.add(`${root}:${work.id}`);
      else jobs.push({ payload: { to: { sessionId: root }, messageUuid: work.id } });
      await service.recover();
      expect(service.consultations.list()).toEqual([]);
      expect(jobs).toHaveLength(state === 'queued' ? 1 : 0);
    }
  );

  test('a failed holder review remains settled without looping or replacing the raw result', async () => {
    const { work } = await concernWork();
    await service.reconcile(work.id);
    const review = service.consultations.list()[0];
    terminalSessions!.add(review.sessionId);
    await service.syncConsultation(review.id);
    expect(service.consultations.get(review.id)?.status).toBe('failed');
    expect(service.repo.getWork(work.id)?.status).toBe('reported');
    await service.recover();
    expect(service.consultations.list()).toHaveLength(1);
    expect(jobs).toHaveLength(3);
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

  test.each(['reported', 'failed', 'expired', 'stopped'])(
    'preserves a newer human correction across a %s work review and recovery',
    async (outcome) => {
      const { work } = await concernWork();
      const correction = {
        ...concern,
        expectedRevision: 1,
        summary: 'Eight people, at my home',
        context: 'Eight people. I will host at my home. No venue booking.',
      };
      expect(await invoke('neo.concern.save', correction)).toMatchObject({
        value: { ok: true, concern: { revision: 2, context: correction.context } },
      });
      const corrected = service.repo.getConcern(concern.id);
      await service.reconcile(work.id);
      const review = service.consultations.get(`neo-work:${work.id}:review`)!;
      const holder = holderInput(review.sessionId, review.id);
      const staleSave = { ...concern, expectedRevision: 1, context: 'Six people at the library' };
      expect(await invoke('neo.concern.save', staleSave, holder)).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('superseded') },
      });
      expect(await invoke('neo.snapshot', {}, holder)).toMatchObject({
        value: { concerns: [{ revision: 2, context: correction.context }] },
      });
      if (outcome === 'reported') {
        expect(
          await invoke(
            'neo.concern.respond',
            { id: review.id, answer: 'Library suggested, not booked.' },
            holder
          )
        ).toMatchObject({ value: { ok: true } });
      } else if (outcome === 'stopped') {
        expect(await invoke('neo.concern.cancel', { id: review.id })).toMatchObject({
          value: { ok: true },
        });
      } else {
        if (outcome === 'expired') {
          sqlite
            .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
            .run(Date.now() - CONSULTATION_TIMEOUT_MS - 1, review.id);
        } else terminalSessions!.add(review.sessionId);
        await service.syncConsultation(review.id);
      }
      expect(service.repo.getConcern(concern.id)).toEqual(corrected);
      expect(service.consultations.get(review.id)?.status).toBe(
        outcome === 'reported' ? 'reported' : 'failed'
      );
      const receipt = service.repo.getWork(work.id);
      expect(receipt).toMatchObject({
        status: 'reported',
        report: expect.stringContaining('library'),
      });
      const jobCount = jobs.length;
      service.dispose();
      service = new NeoService(
        db,
        sessions,
        { event: mock(() => {}) } as unknown as MessageHub,
        events
      );
      await service.recover();
      await service.recover();
      expect(await invoke('neo.concern.save', staleSave, holder)).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('superseded') },
      });
      expect(service.repo.getConcern(concern.id)).toEqual(corrected);
      expect(service.repo.getWork(work.id)).toEqual(receipt);
      expect(service.consultations.list()).toHaveLength(1);
      expect(service.repo.listWork()).toHaveLength(1);
      expect(jobs).toHaveLength(jobCount);
      expect(interrupt).not.toHaveBeenCalled();
    }
  );

  test('a newer correction requires a fresh request before the holder can incorporate evidence', async () => {
    const { work } = await concernWork();
    await service.reconcile(work.id);
    const review = service.consultations.list()[0];
    const holder = holderInput(review.sessionId, review.id);
    const context = 'Eight people. I will host at my home.';
    expect(
      await invoke('neo.concern.save', { ...concern, expectedRevision: 1, context })
    ).toMatchObject({
      value: { ok: true },
    });
    expect(await invoke('neo.snapshot', {}, holder)).toMatchObject({
      value: { concerns: [{ revision: 2, context }] },
    });
    const updated = `${context} Worker suggested a library; no booking was made.`;
    expect(
      await invoke(
        'neo.concern.save',
        { ...concern, expectedRevision: 2, context: 'Stale overwrite' },
        holder
      )
    ).toMatchObject({ value: { ok: false } });
    expect(service.repo.getConcern(concern.id)?.context).toBe(context);
    await invoke('neo.concern.cancel', { id: review.id });
    const fresh = service.consultations.reserve({
      ...review,
      id: 'fresh-review',
      requestKey: 'fresh-review',
    })!;
    const freshHolder = holderInput(fresh.sessionId, fresh.id);
    expect(
      await invoke(
        'neo.concern.save',
        { ...concern, expectedRevision: 2, context: updated },
        freshHolder
      )
    ).toMatchObject({
      value: { ok: true, concern: { revision: 3, context: updated } },
    });
    expect(
      await invoke(
        'neo.concern.respond',
        { id: fresh.id, answer: 'Your home remains the plan; nothing booked.' },
        freshHolder
      )
    ).toMatchObject({ value: { ok: true } });
    await service.recover();
    expect(service.repo.getConcern(concern.id)?.context).toBe(updated);
    expect(service.repo.listWork()).toHaveLength(1);
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
    restrictNeoQuery(options, null, 'neo:runtime-test');
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({ 'hyperneo-operations': operationServer });
    expect(options.allowedTools).toEqual(['mcp__hyperneo-operations__invoke']);
    expect(options.plugins).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.agent).toBeUndefined();
    expect(options.agents).toEqual({});
    expect(options.cwd).toBe(neoCoordinatorRuntimePath('neo:runtime-test'));
    expect(options.cwd).not.toBe(process.cwd());
  });

  async function consultation() {
    await invoke('neo.concern.save', concern);
    const root = await service.open(null);
    const caller = holderInput(root);
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

  test('correlates unrelated root inputs through durable consultation returns', async () => {
    await invoke('neo.concern.save', concern);
    await invoke('neo.concern.save', { ...concern, id: 'research' });
    const root = await service.open(null);
    const caller = (messageId: string): OperationCaller => ({
      ...holderInput(root),
      neoTurn: { messageId, human: true, isLive: () => true },
    });
    const input = { concernId: concern.id, requestKey: 'first', question: 'Next?' };
    expect(
      await invoke('neo.concern.consult', { ...input, originMessageId: 'forged' }, caller('ask-A'))
    ).toMatchObject({ value: { consultation: { originMessageId: 'ask-A' } } });
    expect(
      await invoke(
        'neo.concern.consult',
        { ...input, concernId: 'research', requestKey: 'second' },
        caller('ask-B')
      )
    ).toMatchObject({ value: { consultation: { originMessageId: 'ask-B' } } });
    await invoke('neo.concern.consult', input, caller('ask-A'));
    expect(service.consultations.list()).toHaveLength(2);
    expect(service.repo.listWork()).toEqual([]);
    for (const item of service.consultations.list()) {
      expect(
        JSON.stringify(
          jobs.find((job) => job.payload.messageUuid === `neo-consult:${item.id}:request`)
        )
      ).toContain(item.originMessageId);
      await invoke(
        'neo.concern.respond',
        { id: item.id, answer: `Answer ${item.originMessageId}` },
        holderInput(item.sessionId, item.id)
      );
      expect(
        JSON.stringify(
          jobs.find((job) => job.payload.messageUuid === `neo-consult:${item.id}:reply`)
        )
      ).toContain(item.originMessageId);
    }
    await service.recover();
    expect(jobs).toHaveLength(4);
    expect(await invoke('neo.snapshot', {}, human)).toMatchObject({
      value: {
        consultations: expect.arrayContaining([
          expect.objectContaining({ originMessageId: 'ask-A', status: 'reported' }),
          expect.objectContaining({ originMessageId: 'ask-B', status: 'reported' }),
        ]),
      },
    });
  });

  test('a request key cannot borrow another input’s consultation receipt', async () => {
    const { item, caller, holder, input } = await consultation();
    await invoke('neo.concern.respond', { id: item.id, answer: 'A result' }, holder);
    const unrelated: OperationCaller = {
      ...caller,
      neoTurn: { messageId: 'ask-B', human: true, isLive: () => true },
    };
    expect(await invoke('neo.concern.consult', input, unrelated)).toMatchObject({
      value: { ok: false },
    });
    expect(service.consultations.list()).toEqual([
      { ...item, status: 'reported', answer: 'A result' },
    ]);
    expect(jobs).toHaveLength(2);
  });

  test('MCP consultations use the isolated runtime input despite forged provenance', async () => {
    await invoke('neo.concern.save', concern);
    await invoke('neo.concern.save', { ...concern, id: 'research' });
    const root = await service.open(null);
    const attempts = new QueryAttemptRegistry();
    const first = new NeoHolderTurn(db, root, attempts.allocate(), () => {});
    const turns = [first];
    const registry = createOperationRegistry(createNeoOperations(service));
    const handler = (current: NeoHolderTurn) =>
      createOperationMcpHandler(registry, () => ({
        sessionId: root,
        role: 'neo',
        neoTurn: current.identity(),
      }));
    const request = {
      name: 'neo.concern.consult',
      input: {
        concernId: concern.id,
        requestKey: 'first',
        question: 'Next?',
        originMessageId: 'forged',
        neoTurn: { messageId: 'forged', human: true },
      },
      caller: { source: 'rpc', principal: 'local', neoTurn: { messageId: 'forged' } },
    };
    try {
      first.bind('ask-A');
      const result = await handler(first)(request);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: true,
        consultation: { originMessageId: 'ask-A', originSessionId: root },
      });
      const next = new NeoHolderTurn(db, root, attempts.allocate(), () => {});
      turns.push(next);
      next.bind('ask-B');
      const independent = {
        ...request,
        input: { ...request.input, concernId: 'research', requestKey: 'second' },
      };
      expect(JSON.parse((await handler(first)(independent)).content[0].text)).toMatchObject({
        ok: false,
      });
      expect(JSON.parse((await handler(next)(independent)).content[0].text)).toMatchObject({
        ok: true,
        consultation: { originMessageId: 'ask-B' },
      });
      expect(service.consultations.list()).toHaveLength(2);
      expect(jobs).toHaveLength(2);
      expect(service.repo.listWork()).toEqual([]);
    } finally {
      turns.forEach((current) => current.dispose());
    }
  });

  test('an unbound root cannot create a consultation', async () => {
    await invoke('neo.concern.save', concern);
    const root = await service.open(null);
    expect(
      await invoke(
        'neo.concern.consult',
        {
          concernId: concern.id,
          requestKey: 'unbound',
          question: 'Next?',
        },
        { source: 'mcp', role: 'neo', sessionId: root }
      )
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.list()).toEqual([]);
    expect(created).toHaveLength(1);
    expect(jobs).toEqual([]);
  });

  test('superseding the input during holder opening prevents reservation and delivery', async () => {
    await invoke('neo.concern.save', concern);
    const root = await service.open(null);
    let live = true;
    let opened!: () => void;
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = service.open.bind(service);
    service.open = async (id) => {
      const sessionId = await original(id);
      opened();
      await held;
      return sessionId;
    };
    const result = invoke(
      'neo.concern.consult',
      {
        concernId: concern.id,
        requestKey: 'late',
        question: 'Next?',
      },
      {
        source: 'mcp',
        role: 'neo',
        sessionId: root,
        neoTurn: { messageId: 'ask-A', human: true, isLive: () => live },
      }
    );
    await opening;
    live = false;
    release();
    expect(await result).toMatchObject({ value: { ok: false } });
    expect(service.consultations.list()).toEqual([]);
    expect(jobs).toEqual([]);
  });

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

  test('rechecks the immutable input inside receipt persistence before any queue write', async () => {
    await invoke('neo.concern.save', concern);
    const root = await service.open(null);
    let checks = 0;
    const source: OperationCaller = {
      ...holderInput(root),
      neoTurn: { messageId: 'ask-B', human: true, isLive: () => ++checks < 3 },
    };
    expect(
      await invoke(
        'neo.concern.consult',
        { concernId: concern.id, requestKey: 'B', question: 'Correction B' },
        source
      )
    ).toMatchObject({ value: { ok: false } });
    expect(checks).toBe(3);
    expect(service.consultationWaiters.queued()).toEqual([]);
    expect(service.consultations.list()).toEqual([]);
    expect(jobs).toEqual([]);
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

  test('rejects conflicting keys while retaining a separate queued question', async () => {
    const { item, caller, input } = await consultation();
    for (const change of [{ question: 'Changed question' }, { concernId: 'missing' }]) {
      expect(await invoke('neo.concern.consult', { ...input, ...change }, caller)).toMatchObject({
        value: { ok: false },
      });
    }
    expect(service.consultations.list()).toEqual([item]);
    expect(jobs).toHaveLength(1);
    expect(
      await invoke('neo.concern.consult', { ...input, requestKey: 'second-question' }, caller)
    ).toMatchObject({ value: { ok: true, waiter: { status: 'queued' } } });
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
    expect(await invoke('neo.concern.save', correction, holderInput(holder))).toMatchObject({
      value: { ok: true, concern: { context: correction.context } },
    });
    expect(
      await invoke('neo.concern.save', { ...correction, expectedRevision: 2 }, human)
    ).toMatchObject({ value: { ok: true } });
  });

  test('only the human can stop waiting, without interrupting the shared holder session', async () => {
    const { item, caller, holder } = await consultation();
    for (const denied of [caller, holder]) {
      expect(await invoke('neo.concern.cancel', { id: item.id }, denied)).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'This action needs the user.' },
      });
    }
    expect(
      await invoke('neo.concern.cancel', { id: item.id }, { source: 'rpc', principal: 'remote' })
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.get(item.id)?.status).toBe('pending');
    const request = jobs[0];
    const unrelated = {
      payload: { to: { sessionId: item.sessionId }, messageUuid: 'human-follow-up' },
    };
    jobs.push(unrelated);
    expect(await invoke('neo.concern.cancel', { id: item.id })).toMatchObject({
      value: { ok: true, consultation: { status: 'failed', answer: CONSULTATION_STOPPED } },
    });
    await invoke('neo.concern.cancel', { id: item.id });
    await service.recoverConsultations();
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toBe(request);
    expect(jobs[1]).toBe(unrelated);
    expect(JSON.stringify(jobs[2])).toContain(CONSULTATION_STOPPED);
    expect(interrupt).not.toHaveBeenCalled();
    expect(service.repo.getConcern(concern.id)?.context).toBe(concern.context);
    expect(
      await invoke('neo.concern.respond', { id: item.id, answer: 'Late' }, holder)
    ).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.concern.cancel', { id: 'missing' })).toMatchObject({
      value: { ok: false },
    });
  });

  test('expires a stuck consultation during recovery and allows a new request with a new key', async () => {
    const { item, caller, input } = await consultation();
    sqlite
      .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
      .run(Date.now() - CONSULTATION_TIMEOUT_MS, item.id);
    await service.recoverConsultations();
    expect(service.consultations.get(item.id)).toMatchObject({
      status: 'failed',
      answer: CONSULTATION_EXPIRED,
    });
    expect(jobs).toHaveLength(2);
    await service.recoverConsultations();
    expect(jobs).toHaveLength(2);
    expect(interrupt).not.toHaveBeenCalled();
    expect(await invoke('neo.concern.consult', input, caller)).toMatchObject({
      value: { consultation: { id: item.id, status: 'failed' } },
    });
    expect(
      await invoke('neo.concern.consult', { ...input, requestKey: 'new-attempt' }, caller)
    ).toMatchObject({
      value: { ok: true, consultation: { status: 'pending' } },
    });
    expect(created).toHaveLength(2);
  });

  test('rejects an answer past its deadline even before recovery runs', async () => {
    const { item, holder } = await consultation();
    sqlite
      .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
      .run(Date.now() - CONSULTATION_TIMEOUT_MS - 1, item.id);
    expect(
      await invoke('neo.concern.respond', { id: item.id, answer: 'Too late' }, holder)
    ).toMatchObject({
      value: { ok: false },
    });
    expect(service.consultations.get(item.id)?.answer).toBe(CONSULTATION_EXPIRED);
    expect(JSON.stringify(jobs[1])).toContain(CONSULTATION_EXPIRED);
  });

  test('stopping or expiring a completed request cannot replace its answer', async () => {
    const { item, holder } = await consultation();
    await invoke('neo.concern.respond', { id: item.id, answer: 'Timely answer' }, holder);
    sqlite.prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?').run(item.id);
    await invoke('neo.concern.cancel', { id: item.id });
    await service.recoverConsultations();
    expect(service.consultations.get(item.id)).toMatchObject({
      status: 'reported',
      answer: 'Timely answer',
    });
    expect(jobs).toHaveLength(2);
  });

  test('a concurrent answer and stop settle once with one consistent return', async () => {
    const { item, holder } = await consultation();
    await Promise.all([
      invoke('neo.concern.respond', { id: item.id, answer: 'Answer' }, holder),
      invoke('neo.concern.cancel', { id: item.id }),
    ]);
    const settled = service.consultations.get(item.id)!;
    expect(['reported', 'failed']).toContain(settled.status);
    expect(settled.answer).toBe(settled.status === 'reported' ? 'Answer' : CONSULTATION_STOPPED);
    expect(jobs).toHaveLength(2);
    expect(JSON.stringify(jobs[1])).toContain(settled.answer!);
    await service.recoverConsultations();
    expect(jobs).toHaveLength(2);
  });
});
