import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import {
  admitNeoWorkReportCaller,
  admitNeoWorkReportInput,
  createNeoWorkReporter,
  planNeoWorkReport,
  presentNeoWorkReport,
  requireNeoWorkReportBinding,
  requireNeoWorkReportOwner,
  requireNeoWorkReportRecord,
  requireSettledNeoWorkReport,
  type NeoWorkReportDependencies,
  type NeoWorkReportInput,
} from '../../../../src/lib/neo/work-report.ts';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';

const work: NeoWork = Object.freeze({
  id: 'work:α/A',
  requestKey: 'request-A',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-A',
  title: 'Research status',
  instruction: 'Read current evidence without external actions.',
  sessionId: 'existing-recipient',
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
});
const input: NeoWorkReportInput = Object.freeze({
  id: work.id,
  status: 'reported',
  report: '  Evidence: **draft only**.\nNo external action was taken.  ',
});
const caller: OperationCaller = Object.freeze({
  source: 'mcp',
  sessionId: work.sessionId!,
  role: 'outside_space',
});
const binding: NeoBinding = { sessionId: caller.sessionId!, kind: 'worker', concernId: null };
type Result = Awaited<ReturnType<ReturnType<typeof createNeoWorkReporter>>>;
type Failure = Extract<Result, { accepted: false }>;
const failure = (reason: Failure['reason']): Failure => ({ accepted: false, reason });
const rejection = (reason: Failure['reason']): { reason: Failure } => ({ reason: failure(reason) });
const settled = { ...work, status: input.status, report: input.report };
function fixture() {
  const deps = {
    readWork: mock<NeoWorkReportDependencies['readWork']>(() => work),
    readBinding: mock<NeoWorkReportDependencies['readBinding']>(() => null),
    transitionWork: mock<NeoWorkReportDependencies['transitionWork']>(() => settled),
    returnReport: mock<NeoWorkReportDependencies['returnReport']>(async () => {}),
  } satisfies NeoWorkReportDependencies;
  return { deps, report: createNeoWorkReporter(deps) };
}

describe('Neo recipient report pure stages', () => {
  test.each([
    { ...input, id: '' },
    { ...input, id: '\t ' },
    { ...input, report: '' },
    { ...input, report: '\n\t' },
    { ...input, report: 'x'.repeat(12001) },
    { ...input, status: 'queued' } as unknown as NeoWorkReportInput,
  ])('rejects invalid/beyond-bound reports: %j', (value) => {
    expect(admitNeoWorkReportInput(value)).toEqual(rejection('invalid_report'));
  });
  test('copies only the bounded input, preserving opaque IDs and exact report bytes', () => {
    const value = { ...input, originSessionId: 'forged', originMessageId: 'ask-B', role: 'neo' };
    const result = admitNeoWorkReportInput(value);
    expect(result).toEqual({ value: input });
    if ('reason' in result) throw new Error(result.reason.reason);
    result.value.report = 'Changed';
    expect(value.report).toBe(input.report);
    expect(admitNeoWorkReportInput({ ...input, report: 'x'.repeat(12000) })).toEqual({
      value: { ...input, report: 'x'.repeat(12000) },
    });
  });
  test.each([
    { source: 'rpc', principal: 'local', sessionId: caller.sessionId },
    { source: 'internal', sessionId: caller.sessionId },
    { source: 'mcp' },
    { source: 'mcp', sessionId: '' },
    { source: 'mcp', sessionId: ' \t' },
  ] satisfies OperationCaller[])('requires an actual MCP recipient: %j', (value) => {
    expect(admitNeoWorkReportCaller(value)).toEqual(rejection('recipient_required'));
  });
  test('caller stage uses immutable transport identity, not role or human hints', () => {
    expect(admitNeoWorkReportCaller(caller)).toEqual({ value: { sessionId: caller.sessionId! } });
    expect(requireNeoWorkReportOwner(work, { sessionId: 'other-recipient' })).toEqual(
      rejection('recipient_mismatch')
    );
    expect(requireNeoWorkReportOwner(work, { sessionId: caller.sessionId! })).toEqual({
      value: work,
    });
    expect(
      requireNeoWorkReportOwner({ ...work, sessionId: null }, { sessionId: caller.sessionId! })
    ).toEqual(rejection('recipient_mismatch'));
  });
  test.each([null, { ...work, id: 'work-B' }])('requires the exact work row: %j', (value) => {
    expect(requireNeoWorkReportRecord(input, { work: value })).toEqual(rejection('work_not_found'));
  });
  test.each([null, binding])('ordinary execution and worker bindings are allowed: %j', (value) => {
    expect(requireNeoWorkReportRecord(input, { work })).toEqual({ value: work });
    expect(requireNeoWorkReportBinding(work, { binding: value })).toEqual({ value: work });
  });
  test.each(['neo', 'concern'] as const)('context %s bindings never execute reports', (kind) => {
    expect(requireNeoWorkReportBinding(work, { binding: { ...binding, kind } })).toEqual(
      rejection('recipient_is_coordinator')
    );
  });
  test('binding identity mismatch rejects even a worker', () => {
    expect(
      requireNeoWorkReportBinding(work, { binding: { ...binding, sessionId: 'other' } })
    ).toEqual(rejection('invalid_recipient_binding'));
  });
  test.each(['reported', 'failed'] as const)('plans a %s report or exact replay only', (status) => {
    const value = { ...input, status };
    expect(planNeoWorkReport(work, value)).toEqual({ value: { replayed: false } });
    expect(planNeoWorkReport({ ...work, status, report: value.report }, value)).toEqual({
      value: { replayed: true },
    });
    expect(planNeoWorkReport({ ...work, status, report: 'Different evidence' }, value)).toEqual(
      rejection('report_conflict')
    );
    expect(
      planNeoWorkReport(
        { ...work, status: status === 'reported' ? 'failed' : 'reported', report: value.report },
        value
      )
    ).toEqual(rejection('report_conflict'));
  });
  test.each(['proposed', 'cancelled'] as const)('does not settle %s work', (status) => {
    expect(planNeoWorkReport({ ...work, status }, input)).toEqual(rejection('work_not_pending'));
  });
  test.each([
    null,
    { ...settled, id: 'work-B' },
    { ...settled, sessionId: 'other' },
    { ...settled, originSessionId: 'holder' },
    { ...settled, originMessageId: 'ask-B' },
    { ...settled, status: 'queued' as const },
    { ...settled, report: 'Other result' },
  ])('never returns a superseded/mismatched settled row: %j', (value) => {
    expect(requireSettledNeoWorkReport(work, input, { work: value })).toEqual(
      rejection('superseded')
    );
  });
  test('settled presentation is a minimal receipt, not context or verified completion', () => {
    expect(requireSettledNeoWorkReport(work, input, { work: settled })).toEqual({ value: settled });
    expect(presentNeoWorkReport(settled, { replayed: false })).toEqual({
      accepted: true,
      workId: work.id,
      status: 'reported',
      replayed: false,
    });
    expect(work.status).toBe('queued');
    expect(input.report).toBe(settled.report);
  });
});

describe('Neo recipient report composition', () => {
  test('constructs without effects and uses exact primitive reads/CAS/return', async () => {
    const f = fixture();
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
    expect(await f.report(input, caller)).toEqual(
      presentNeoWorkReport(settled, { replayed: false })
    );
    expect(f.deps.readWork.mock.calls).toEqual([[work.id]]);
    expect(f.deps.readBinding.mock.calls).toEqual([[work.sessionId!]]);
    expect(f.deps.transitionWork.mock.calls).toEqual([
      [work.id, work, { status: input.status, report: input.report }],
    ]);
    expect(f.deps.returnReport.mock.calls).toEqual([[settled]]);
  });
  test('input/caller admission runs before resource reads', async () => {
    const f = fixture();
    expect(await f.report({ ...input, report: ' ' }, caller)).toEqual(failure('invalid_report'));
    expect(await f.report(input, { source: 'rpc', principal: 'local' })).toEqual(
      failure('recipient_required')
    );
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
  });
  test('unknown work rejects before binding/CAS/return', async () => {
    const f = fixture();
    f.deps.readWork.mockReturnValue(null);
    expect(await f.report(input, caller)).toEqual(failure('work_not_found'));
    expect(f.deps.readBinding).not.toHaveBeenCalled();
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
  test('owner mismatch precedes status/binding and cannot borrow the origin or newer ask', async () => {
    const f = fixture();
    for (const sessionId of ['root', 'holder', 'other-recipient']) {
      expect(
        await f.report(input, {
          ...caller,
          sessionId,
          role: 'neo',
          neoTurn: { messageId: 'ask-B', human: true, isLive: () => true },
        })
      ).toEqual(failure('recipient_mismatch'));
    }
    expect(f.deps.readBinding).not.toHaveBeenCalled();
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
  test.each(['neo', 'concern'] as const)(
    'actual %s binding blocks writes and returns',
    async (kind) => {
      const f = fixture();
      f.deps.readBinding.mockReturnValue({ ...binding, kind });
      expect(await f.report(input, caller)).toEqual(failure('recipient_is_coordinator'));
      expect(f.deps.transitionWork).not.toHaveBeenCalled();
      expect(f.deps.returnReport).not.toHaveBeenCalled();
    }
  );
  test.each(['proposed', 'cancelled'] as const)(
    'closed %s state never writes or returns',
    async (status) => {
      const f = fixture();
      f.deps.readWork.mockReturnValue({ ...work, status });
      expect(await f.report(input, caller)).toEqual(failure('work_not_pending'));
      expect(f.deps.transitionWork).not.toHaveBeenCalled();
      expect(f.deps.returnReport).not.toHaveBeenCalled();
    }
  );
  test('settled conflicting text/outcome cannot rewrite or redeliver', async () => {
    const f = fixture();
    f.deps.readWork.mockReturnValue(settled);
    expect(await f.report({ ...input, report: 'Replace evidence' }, caller)).toEqual(
      failure('report_conflict')
    );
    expect(await f.report({ ...input, status: 'failed' }, caller)).toEqual(
      failure('report_conflict')
    );
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
  test('superseded CAS never retries or returns another result', async () => {
    const f = fixture();
    f.deps.transitionWork.mockReturnValue(null);
    expect(await f.report(input, caller)).toEqual(failure('superseded'));
    expect(f.deps.transitionWork).toHaveBeenCalledTimes(1);
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
  test('exact settled retry returns again without a write', async () => {
    const f = fixture();
    f.deps.readWork.mockReturnValue(settled);
    expect(await f.report(input, caller)).toEqual(
      presentNeoWorkReport(settled, { replayed: true })
    );
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport.mock.calls).toEqual([[settled]]);
  });
  test.each(['readWork', 'readBinding', 'transitionWork'] as const)(
    'propagates %s faults once',
    async (name) => {
      const f = fixture();
      f.deps[name].mockImplementation(() => {
        throw new Error('Storage unavailable');
      });
      await expect(f.report(input, caller)).rejects.toThrow('Storage unavailable');
      expect(f.deps[name]).toHaveBeenCalledTimes(1);
      expect(f.deps.returnReport).not.toHaveBeenCalled();
    }
  );
  test('return failure is infrastructure failure, not a second transition', async () => {
    const f = fixture();
    f.deps.returnReport.mockRejectedValueOnce(new Error('Mailbox unavailable'));
    await expect(f.report(input, caller)).rejects.toThrow('Mailbox unavailable');
    expect(f.deps.transitionWork).toHaveBeenCalledTimes(1);
    f.deps.readWork.mockReturnValue(settled);
    expect(await f.report(input, caller)).toEqual(
      presentNeoWorkReport(settled, { replayed: true })
    );
    expect(f.deps.transitionWork).toHaveBeenCalledTimes(1);
    expect(f.deps.returnReport).toHaveBeenCalledTimes(2);
  });
});

describe('Neo recipient report actual SQLite effects', () => {
  let db: SQLite;
  let repo: NeoRepository;
  beforeEach(() => {
    db = new SQLite(':memory:');
    createNeoTables(db);
    runMigration283(db);
    repo = new NeoRepository(db);
  });
  afterEach(() => db.close());
  function queued(id: string, sessionId = caller.sessionId!) {
    const proposed = repo.proposeWork({
      ...work,
      id,
      requestKey: id,
      originMessageId: `ask:${id}`,
    });
    return repo.transitionWork(id, proposed, { status: 'queued', sessionId })!;
  }
  function reporter(returnReport = mock(async (_work: NeoWork) => {})) {
    return {
      returnReport,
      report: createNeoWorkReporter({
        readWork: (id) => repo.getWork(id),
        readBinding: (id) => repo.getBindingBySession(id),
        transitionWork: (id, expected, patch) => repo.transitionWork(id, expected, patch),
        returnReport,
      }),
    };
  }
  test('one recipient independently reports multiple work IDs without cross-ask borrowing', async () => {
    const a = queued('A');
    const b = queued('B');
    const f = reporter();
    expect(await f.report({ ...input, id: a.id }, caller)).toMatchObject({
      accepted: true,
      workId: a.id,
    });
    expect(repo.getWork(b.id)).toEqual(b);
    expect(
      await f.report(
        { ...input, id: b.id, status: 'failed', report: 'Blocked: needs a choice.' },
        caller
      )
    ).toMatchObject({ accepted: true, workId: b.id, status: 'failed' });
    expect(repo.getWork(a.id)).toMatchObject({
      status: 'reported',
      report: input.report,
      originMessageId: 'ask:A',
    });
    expect(repo.getWork(b.id)).toMatchObject({
      status: 'failed',
      report: 'Blocked: needs a choice.',
      originMessageId: 'ask:B',
    });
    expect(f.returnReport.mock.calls.map(([value]) => [value.id, value.originMessageId])).toEqual([
      ['A', 'ask:A'],
      ['B', 'ask:B'],
    ]);
  });
  test.each(['status', 'sessionId', 'report'] as const)(
    'real CAS rejects raced %s changes',
    async (field) => {
      const current = queued('A');
      const returnReport = mock(async (_work: NeoWork) => {});
      const report = createNeoWorkReporter({
        readWork: (id) => repo.getWork(id),
        readBinding: (id) => repo.getBindingBySession(id),
        transitionWork: (id, expected, patch) => {
          const race =
            field === 'status'
              ? { status: 'cancelled' as const }
              : field === 'sessionId'
                ? { status: current.status, sessionId: 'replacement' }
                : { status: current.status, report: 'Other report' };
          expect(repo.transitionWork(id, current, race)).not.toBeNull();
          return repo.transitionWork(id, expected, patch);
        },
        returnReport,
      });
      expect(await report({ ...input, id: current.id }, caller)).toEqual(failure('superseded'));
      expect(returnReport).not.toHaveBeenCalled();
      expect(repo.getWork(current.id)?.report).not.toBe(input.report);
      expect(repo.getWork(current.id)?.originMessageId).toBe('ask:A');
    }
  );
  test('persisted report survives delivery failure and retries without changing its row', async () => {
    const current = queued('A');
    const f = reporter();
    f.returnReport.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.report({ ...input, id: current.id }, caller)).rejects.toThrow('Unavailable');
    const saved = repo.getWork(current.id);
    expect(saved).toMatchObject({ status: input.status, report: input.report });
    expect(await f.report({ ...input, id: current.id }, caller)).toMatchObject({
      accepted: true,
      replayed: true,
    });
    expect(repo.getWork(current.id)).toEqual(saved);
  });
  test('cancelled work and foreign recipients remain unchanged with no return', async () => {
    const a = queued('A');
    const b = queued('B', 'foreign-recipient');
    repo.transitionWork(a.id, a, { status: 'cancelled' });
    const before = repo.listWork();
    const f = reporter();
    expect(await f.report({ ...input, id: a.id }, caller)).toEqual(failure('work_not_pending'));
    expect(await f.report({ ...input, id: b.id }, caller)).toEqual(failure('recipient_mismatch'));
    expect(repo.listWork()).toEqual(before);
    expect(f.returnReport).not.toHaveBeenCalled();
  });
});

describe('NeoService recipient report facade', () => {
  test('uses real work CAS and deduplicated mailbox returns, not SDK terminal/text inference', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const createSession = mock(async () => {
      throw new Error('Must reuse existing contexts');
    });
    const getSessionAsync = mock(async () => {
      throw new Error('Must not load or interrupt SDK');
    });
    const event = mock(() => {});
    const service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const sql = db.getDatabase();
    const sdk = db.getSDKMessageRepo();
    const text = spyOn(sdk, 'getAssistantMessagesSince');
    const terminal = spyOn(sdk, 'hasTerminalResultAfter');
    try {
      for (const id of ['root', 'existing-recipient', 'holder'])
        sql
          .prepare(`INSERT INTO sessions(id, title, workspace_path, created_at, last_active_at,
          status, config, metadata) VALUES (?, ?, NULL, '2026-09-28T12:00:00Z',
          '2026-09-28T12:00:00Z', 'active', '{}', '{}')`)
          .run(id, id);
      service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
      service.repo.saveConcern(
        { id: 'research', title: 'Research', summary: 'Learn', context: 'Private' },
        0
      );
      service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
      const current = service.repo.proposeWork({ ...work });
      service.repo.transitionWork(current.id, current, {
        status: 'queued',
        sessionId: caller.sessionId,
      });
      const capture = () =>
        JSON.stringify(
          ['sessions', 'neo_concerns', 'neo_session_bindings', 'sdk_messages'].map((table) =>
            sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
          )
        );
      const before = capture();
      event.mockClear();
      expect(await service.reportWork(input, caller)).toEqual(
        presentNeoWorkReport(settled, { replayed: false })
      );
      const saved = service.repo.getWork(work.id);
      expect(saved).toMatchObject({
        ...settled,
        createdAt: current.createdAt,
        updatedAt: expect.any(Number),
      });
      expect(saved!.updatedAt).toBeGreaterThanOrEqual(current.createdAt);
      const jobs = db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: work.id });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({
        to: { kind: 'session', sessionId: 'root' },
        origin: 'session:existing-recipient',
        messageUuid: work.id,
        message: { type: 'user', inputKind: 'system' },
      });
      const message = jobs[0].payload.message as { message: { content: string } };
      expect(message.message.content).toContain('untrusted evidence');
      expect(message.message.content).toContain('"originMessageId":"ask-A"');
      expect(message.message.content).toContain(JSON.stringify(input.report));
      expect(await service.reportWork(input, caller)).toMatchObject({
        accepted: true,
        replayed: true,
      });
      expect(service.repo.getWork(work.id)).toEqual(saved);
      expect(
        db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: work.id })
      ).toHaveLength(1);
      expect(capture()).toBe(before);
      expect(event).toHaveBeenCalledTimes(1);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      text.mockRestore();
      terminal.mockRestore();
      service.dispose();
      db.close();
    }
  });
});
