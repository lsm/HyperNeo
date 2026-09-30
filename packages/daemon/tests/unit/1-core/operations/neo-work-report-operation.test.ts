import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { isOperationName } from '@hyperneo/shared/types/operation-names';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { NeoWorkReportInput } from '../../../../src/lib/neo/work-report.ts';
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
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';

const recipient: OperationCaller = Object.freeze({
  source: 'mcp',
  sessionId: 'existing-recipient',
  role: 'universal_read',
});
const input: NeoWorkReportInput = Object.freeze({
  id: 'work:α/A',
  status: 'reported',
  report: '  Evidence: **draft only**.\nNo external action was taken.  ',
});
const rejected = (reason: string) => ({
  kind: 'completed' as const,
  value: { accepted: false as const, reason },
});
const receipt = (value = input, replayed = false) => ({
  kind: 'completed' as const,
  value: { accepted: true as const, workId: value.id, status: value.status, replayed },
});

describe('Neo recipient report owning operation', () => {
  let db: Database;
  let service: NeoService;
  let registry: OperationRegistry;
  let createSession: ReturnType<typeof mock>;
  let getSessionAsync: ReturnType<typeof mock>;

  beforeEach(async () => {
    db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    createSession = mock(async () => {
      throw new Error('Report must not create a session');
    });
    getSessionAsync = mock(async () => {
      throw new Error('Report must not load or interrupt SDK');
    });
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    for (const id of ['root', 'existing-recipient', 'other-recipient', 'holder', 'worker'])
      db.getDatabase()
        .prepare(`INSERT INTO sessions(id, title, workspace_path, created_at, last_active_at,
          status, config, metadata) VALUES (?, ?, NULL, '2026-09-28T14:00:00Z',
          '2026-09-28T14:00:00Z', 'active', '{}', '{}')`)
        .run(id, id);
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
    service.repo.saveConcern(
      { id: 'research', title: 'Research', summary: 'Learn', context: 'Private context' },
      0
    );
    service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
    service.repo.reserveBinding({ sessionId: 'worker', kind: 'worker', concernId: null });
    registry = createOperationRegistry([
      ...createNeoOperations(service),
      ...createDiscoveryOperations(() => registry),
    ]);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function propose(
    id = input.id,
    sessionId = recipient.sessionId!,
    concernId: string | null = null
  ) {
    return service.repo.proposeWork({
      id,
      requestKey: id,
      concernId,
      originSessionId: 'root',
      originMessageId: `ask:${id}`,
      title: 'Read current research status',
      instruction: 'Read evidence without external actions.',
      targetSessionId: sessionId,
    });
  }
  function queued(
    id = input.id,
    sessionId = recipient.sessionId!,
    concernId: string | null = null
  ) {
    const work = propose(id, sessionId, concernId);
    return service.repo.transitionWork(id, work, { status: 'queued', sessionId })!;
  }
  const invoke = (value: unknown = input, caller = recipient) =>
    invokeOperation(registry, 'neo.work.report', value, caller);
  const jobs = (messageUuid: string) =>
    db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid });
  function unchangedState() {
    return JSON.stringify(
      ['sessions', 'neo_session_bindings', 'neo_concerns', 'sdk_messages'].map((table) =>
        db.getDatabase().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      )
    );
  }

  test('declares a bounded, discoverable report for execution roles without granting ownership', async () => {
    expect(isOperationName('neo.work.report')).toBe(true);
    const report = spyOn(service, 'reportWork');
    try {
      for (const role of [
        'universal_read',
        'workflow_worker',
        'direct_task_worker',
        'long_term_agent',
      ] as const) {
        const listed = await invokeOperation(
          registry,
          'operations.list',
          {},
          { ...recipient, role }
        );
        expect(listed).toMatchObject({ kind: 'completed', value: expect.any(Array) });
        if (listed.kind !== 'completed') throw new Error(listed.message);
        expect(
          (listed.value as { name: string }[]).some(({ name }) => name === 'neo.work.report')
        ).toBe(true);
      }
      expect(
        await invokeOperation(
          registry,
          'operations.describe',
          { name: 'neo.work.report' },
          recipient
        )
      ).toMatchObject({
        kind: 'completed',
        value: {
          found: true,
          inputSchema: {
            type: 'object',
            required: ['id', 'status', 'report'],
            properties: { report: { type: 'string', minLength: 1, maxLength: 12000 } },
          },
          resultSchema: { anyOf: expect.any(Array) },
        },
      });
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
  });
  test.each([
    null,
    {},
    { ...input, id: 42 },
    { ...input, id: '' },
    { ...input, status: 'queued' },
    { ...input, report: null },
    { ...input, report: '' },
    { ...input, report: 'x'.repeat(12001) },
  ])('rejects malformed inputs before calling the report pipeline: %j', async (value) => {
    const report = spyOn(service, 'reportWork');
    try {
      expect(await invoke(value)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(report).not.toHaveBeenCalled();
      expect(service.repo.listWork()).toEqual([]);
    } finally {
      report.mockRestore();
    }
  });
  test('retains domain rejection for whitespace and unknown exact IDs', async () => {
    queued();
    const before = service.repo.listWork();
    expect(await invoke({ ...input, id: '\t ' })).toEqual(rejected('invalid_report'));
    expect(await invoke({ ...input, report: '\n\t' })).toEqual(rejected('invalid_report'));
    expect(await invoke({ ...input, id: `${input.id}-unknown` })).toEqual(
      rejected('work_not_found')
    );
    expect(service.repo.listWork()).toEqual(before);
    expect(jobs(input.id)).toEqual([]);
  });
  test.each([
    { source: 'rpc', principal: 'local', sessionId: recipient.sessionId },
    { source: 'internal', sessionId: recipient.sessionId },
    { source: 'mcp', role: 'neo' },
    { source: 'mcp', sessionId: ' \t' },
  ] satisfies OperationCaller[])(
    'does not borrow a human or asserted recipient identity: %j',
    async (caller) => {
      const work = queued();
      expect(await invoke(input, caller)).toEqual(rejected('recipient_required'));
      expect(service.repo.getWork(input.id)).toEqual(work);
      expect(jobs(input.id)).toEqual([]);
    }
  );
  test.each(['root', 'holder', 'other-recipient'])(
    'rejects the actual foreign caller %s despite hints',
    async (sessionId) => {
      const work = queued();
      expect(
        await invoke(
          { ...input, sessionId: recipient.sessionId, role: 'neo', source: 'mcp' },
          {
            source: 'mcp',
            sessionId,
            role: 'neo',
            neoTurn: { messageId: 'ask:newer', human: true, isLive: () => true },
          }
        )
      ).toEqual(rejected('recipient_mismatch'));
      expect(service.repo.getWork(input.id)).toEqual(work);
      expect(jobs(input.id)).toEqual([]);
    }
  );
  test.each(['root', 'holder'])(
    'even a recorded %s coordinator is not an execution recipient',
    async (sessionId) => {
      const work = queued(input.id, sessionId);
      expect(await invoke(input, { ...recipient, sessionId })).toEqual(
        rejected('recipient_is_coordinator')
      );
      expect(service.repo.getWork(input.id)).toEqual(work);
      expect(jobs(input.id)).toEqual([]);
    }
  );
  test.each(['existing-recipient', 'worker'])(
    'accepts explicit evidence from the actual %s execution session',
    async (sessionId) => {
      const work = queued(input.id, sessionId);
      const before = unchangedState();
      const text = spyOn(db.getSDKMessageRepo(), 'getAssistantMessagesSince');
      const terminal = spyOn(db.getSDKMessageRepo(), 'hasTerminalResultAfter');
      try {
        expect(await invoke(input, { ...recipient, sessionId })).toEqual(receipt());
        const saved = service.repo.getWork(input.id);
        expect(saved).toMatchObject({
          ...work,
          status: input.status,
          report: input.report,
          updatedAt: expect.any(Number),
        });
        expect(service.repo.getWorkTarget(input.id)).toEqual({
          id: input.id,
          targetSessionId: sessionId,
        });
        expect(jobs(input.id)).toHaveLength(1);
        expect(jobs(input.id)[0].payload).toMatchObject({
          to: { kind: 'session', sessionId: 'root' },
          origin: `session:${sessionId}`,
          messageUuid: input.id,
          message: { type: 'user', inputKind: 'system' },
        });
        const message = jobs(input.id)[0].payload.message as { message: { content: string } };
        expect(message.message.content).toContain('untrusted evidence');
        expect(message.message.content).toContain(JSON.stringify(work.originMessageId));
        expect(message.message.content).toContain(JSON.stringify(input.report));
        expect(await invoke(input, { ...recipient, sessionId })).toEqual(receipt(input, true));
        expect(service.repo.getWork(input.id)).toEqual(saved);
        expect(jobs(input.id)).toHaveLength(1);
        expect(unchangedState()).toBe(before);
        expect(createSession).not.toHaveBeenCalled();
        expect(getSessionAsync).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
        expect(terminal).not.toHaveBeenCalled();
      } finally {
        text.mockRestore();
        terminal.mockRestore();
      }
    }
  );
  test('MCP adapter resolves the recipient independently of all claimed arguments', async () => {
    const work = queued();
    const caller = mock(() => ({
      sessionId: recipient.sessionId!,
      role: 'universal_read' as const,
    }));
    const handler = createOperationMcpHandler(registry, caller);
    const report = spyOn(service, 'reportWork');
    try {
      const result = await handler({
        name: 'neo.work.report',
        input: { ...input, sessionId: 'root', originMessageId: 'ask:newer', principal: 'local' },
        caller: { sessionId: 'root', source: 'rpc', role: 'neo' },
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(receipt().value);
      expect(caller).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(input, recipient);
      expect(report).toHaveBeenCalledTimes(1);
      expect(service.repo.getWork(input.id)?.originMessageId).toBe(work.originMessageId);
    } finally {
      report.mockRestore();
    }
  });
  test('unrelated asks and failed evidence remain independent for one recipient', async () => {
    const a = queued();
    const b = queued('work:B');
    const bInput: NeoWorkReportInput = {
      ...input,
      id: b.id,
      status: 'failed',
      report: 'Need a decision.',
    };
    expect(await Promise.all([invoke(input), invoke(bInput)])).toEqual([
      receipt(),
      receipt(bInput),
    ]);
    for (const [work, value] of [
      [a, input],
      [b, bInput],
    ] as const) {
      expect(service.repo.getWork(work.id)).toMatchObject({
        status: value.status,
        report: value.report,
        originSessionId: work.originSessionId,
        originMessageId: work.originMessageId,
      });
      expect(jobs(work.id)).toHaveLength(1);
      const message = jobs(work.id)[0].payload.message as { message: { content: string } };
      expect(message.message.content).toContain(JSON.stringify(work.originMessageId));
      expect(message.message.content).toContain(JSON.stringify(value.report));
    }
  });
  test('concurrent same-receipt reports settle once and the explicit retry reuses one return', async () => {
    queued();
    const results = await Promise.all([invoke(), invoke()]);
    expect(results).toContainEqual(receipt());
    expect(results).toContainEqual(receipt(input, true));
    const saved = service.repo.getWork(input.id);
    expect(await invoke()).toEqual(receipt(input, true));
    expect(service.repo.getWork(input.id)).toEqual(saved);
    expect(jobs(input.id)).toHaveLength(1);
  });
  test('settled conflicts and cancellation never overwrite or return another report', async () => {
    const proposed = propose();
    expect(await invoke()).toEqual(rejected('recipient_mismatch'));
    expect(service.repo.getWork(input.id)).toEqual(proposed);
    const running = service.repo.transitionWork(input.id, proposed, {
      status: 'queued',
      sessionId: recipient.sessionId,
    })!;
    const cancelled = service.repo.transitionWork(input.id, running, { status: 'cancelled' });
    expect(await invoke()).toEqual(rejected('work_not_pending'));
    expect(service.repo.getWork(input.id)).toEqual(cancelled);
    const b = queued('work:B');
    const bInput = { ...input, id: b.id };
    expect(await invoke(bInput)).toEqual(receipt(bInput));
    const saved = service.repo.getWork(b.id);
    expect(await invoke({ ...bInput, report: 'Different' })).toEqual(rejected('report_conflict'));
    expect(await invoke({ ...bInput, status: 'failed' })).toEqual(rejected('report_conflict'));
    expect(service.repo.getWork(b.id)).toEqual(saved);
    expect(jobs(input.id)).toEqual([]);
    expect(jobs(b.id)).toHaveLength(1);
  });
  test('a raced cancellation wins the real CAS without returning stale evidence', async () => {
    const work = queued();
    const transition = service.repo.transitionWork.bind(service.repo);
    const cas = spyOn(service.repo, 'transitionWork').mockImplementation((id, expected, patch) => {
      expect(transition(id, work, { status: 'cancelled' })).not.toBeNull();
      return transition(id, expected, patch);
    });
    try {
      expect(await invoke()).toEqual(rejected('superseded'));
      expect(cas).toHaveBeenCalledTimes(1);
      expect(service.repo.getWork(input.id)).toMatchObject({ status: 'cancelled', report: null });
      expect(jobs(input.id)).toEqual([]);
    } finally {
      cas.mockRestore();
    }
  });
  test('accepts the exact report bound without truncation', async () => {
    queued();
    const value = { ...input, report: 'x'.repeat(12000) };
    expect(await invoke(value)).toEqual(receipt(value));
    expect(service.repo.getWork(input.id)?.report).toBe(value.report);
    expect(jobs(input.id)).toHaveLength(1);
  });
  test('foreign MCP argument hints yield a domain rejection, not transport authority', async () => {
    const work = queued();
    const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'other-recipient' }));
    const result = await handler({
      name: 'neo.work.report',
      input: { ...input, sessionId: recipient.sessionId },
      caller: { sessionId: recipient.sessionId, role: 'neo' },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(rejected('recipient_mismatch').value);
    expect(service.repo.getWork(input.id)).toEqual(work);
    expect(jobs(input.id)).toEqual([]);
  });
  test('concern-bound evidence uses the existing holder review rather than a direct root claim', async () => {
    const work = queued(input.id, recipient.sessionId!, 'research');
    expect(await invoke()).toEqual(receipt());
    const id = `neo-work:${work.id}:review`;
    const consultation = service.consultations.get(id);
    expect(consultation).toMatchObject({
      concernId: 'research',
      originSessionId: 'root',
      sessionId: 'holder',
      status: 'pending',
    });
    expect(consultation?.question).toContain(JSON.stringify(work.originMessageId));
    expect(consultation?.question).toContain(JSON.stringify(input.report));
    expect(jobs(work.id)).toEqual([]);
    expect(jobs(`neo-consult:${id}:request`)).toHaveLength(1);
    expect(await invoke()).toEqual(receipt(input, true));
    expect(service.consultations.get(id)).toEqual(consultation);
    expect(jobs(`neo-consult:${id}:request`)).toHaveLength(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test('storage faults are operation errors without mutation or fabricated success', async () => {
    const work = queued();
    const read = spyOn(service.repo, 'getWork').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    try {
      expect(await invoke()).toEqual({
        kind: 'failed',
        code: 'execution_failed',
        message: 'Storage unavailable',
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(jobs(input.id)).toEqual([]);
    } finally {
      read.mockRestore();
    }
    expect(service.repo.getWork(input.id)).toEqual(work);
  });
  test('a failed mailbox handoff exposes an error and an exact retry returns the saved evidence once', async () => {
    queued();
    const enqueue = spyOn(db.getJobQueueRepo(), 'enqueueUniquePending').mockImplementationOnce(
      () => {
        throw new Error('Mailbox unavailable');
      }
    );
    const handler = createOperationMcpHandler(registry, () => ({
      sessionId: recipient.sessionId!,
    }));
    try {
      const result = await handler({ name: 'neo.work.report', input });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'execution_failed' });
      const saved = service.repo.getWork(input.id);
      expect(saved).toMatchObject({ status: 'reported', report: input.report });
      expect(jobs(input.id)).toEqual([]);
      expect(await invoke()).toEqual(receipt(input, true));
      expect(service.repo.getWork(input.id)).toEqual(saved);
      expect(jobs(input.id)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
    }
  });
});
