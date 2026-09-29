import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  admitNeoWorkReportInput,
  createNeoWorkReporter,
  type NeoWorkReportDependencies,
  type NeoWorkReportInput,
  requireNeoWorkReportResources,
} from '../../../../src/lib/neo/work-report.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoWorkResourceRepository } from '../../../../src/storage/repositories/neo-work-resource-repository.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration287 } from '../../../../src/storage/schema/m287-neo-work-resources.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';

const task = { kind: 'tasks', id: 'draft:α/A' };
const workflow = { kind: 'workflows', id: 'flow/β' };
const work: NeoWork = Object.freeze({
  id: 'work-A',
  requestKey: 'request-A',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-A',
  title: 'Draft only',
  instruction: 'Use existing native operations.',
  sessionId: 'recipient',
  targetSessionId: 'recipient',
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
});
const legacy: NeoWorkReportInput = {
  id: work.id,
  status: 'reported',
  report: '  Draft evidence.\n未执行。  ',
};
const input: NeoWorkReportInput = { ...legacy, resourceRefs: [task, workflow] };
const caller: OperationCaller = { source: 'mcp', sessionId: 'recipient', role: 'outside_space' };
const settled: NeoWork = { ...work, status: input.status, report: input.report };
const rejected = (reason: string) => ({ accepted: false, reason });

function ports() {
  const resourceReports = {
    get: mock<NonNullable<NeoWorkReportDependencies['resourceReports']>['get']>(() => [
      task,
      workflow,
    ]),
    settle: mock<NonNullable<NeoWorkReportDependencies['resourceReports']>['settle']>(
      () => settled
    ),
  };
  const deps = {
    readWork: mock(() => work),
    readBinding: mock(() => null),
    transitionWork: mock(() => settled),
    returnReport: mock(async () => {}),
    resourceReports,
  } satisfies NeoWorkReportDependencies;
  return { deps, resourceReports, report: createNeoWorkReporter(deps) };
}

describe('Neo report resource admission and replay stages', () => {
  test.each([
    null,
    {},
    '[]',
    [null],
    [{ kind: '', id: 'x' }],
    [{ kind: 'tasks', id: ' ' }],
    [{ kind: 'x'.repeat(65), id: 'x' }],
    [{ kind: 'tasks', id: 'x'.repeat(161) }],
    Array.from({ length: 17 }, () => task),
  ])('rejects malformed or unbounded references: %j', (resourceRefs) => {
    expect(admitNeoWorkReportInput({ ...legacy, resourceRefs } as NeoWorkReportInput)).toEqual({
      reason: rejected('invalid_report'),
    });
  });
  test('preserves opaque IDs and exact evidence, strips hints, and copies a canonical set', () => {
    const refs = [
      Object.freeze(workflow),
      Object.freeze({ ...task, role: 'neo' }),
      Object.freeze(task),
    ];
    const supplied = Object.freeze({ ...legacy, resourceRefs: refs, originMessageId: 'forged' });
    const result = admitNeoWorkReportInput(supplied);
    expect(result).toEqual({ value: input });
    if ('reason' in result) throw new Error('Admission failed');
    if (!result.value.resourceRefs) throw new Error('References missing');
    result.value.resourceRefs[0].id = 'changed';
    expect(refs[1].id).toBe(task.id);
    expect(refs).toHaveLength(3);
    expect(admitNeoWorkReportInput(legacy)).toEqual({ value: legacy });
    expect(admitNeoWorkReportInput({ ...legacy, resourceRefs: [] })).toEqual({
      value: { ...legacy, resourceRefs: [] },
    });
    expect(
      admitNeoWorkReportInput({
        ...legacy,
        resourceRefs: [{ kind: 'future primitive', id: '  opaque id  ' }],
      })
    ).toEqual({
      value: { ...legacy, resourceRefs: [{ kind: 'future primitive', id: '  opaque id  ' }] },
    });
  });
  test('optional legacy reports need no reference port; explicit refs require one', () => {
    const plan = { replayed: false };
    expect(requireNeoWorkReportResources(legacy, plan, { supported: false, refs: null })).toEqual({
      value: plan,
    });
    expect(requireNeoWorkReportResources(input, plan, { supported: false, refs: null })).toEqual({
      reason: rejected('invalid_report'),
    });
    expect(requireNeoWorkReportResources(input, plan, { supported: true, refs: null })).toEqual({
      value: plan,
    });
  });
  test.each([null, [], [workflow], [{ ...task, id: 'other' }, workflow]])(
    'different or unknown settled references conflict: %j',
    (refs) => {
      expect(
        requireNeoWorkReportResources(input, { replayed: true }, { supported: true, refs })
      ).toEqual({ reason: rejected('report_conflict') });
    }
  );
});

describe('Neo report resource pipeline ports', () => {
  test('construction is inert and new references use only atomic settlement', async () => {
    const f = ports();
    for (const port of [f.deps.readWork, f.resourceReports.get, f.resourceReports.settle])
      expect(port).not.toHaveBeenCalled();
    expect(
      await f.report({ ...legacy, resourceRefs: [workflow, task, task] }, caller)
    ).toMatchObject({ accepted: true, replayed: false });
    expect(f.resourceReports.settle.mock.calls).toEqual([[work, input, input.resourceRefs]]);
    expect(f.resourceReports.get).not.toHaveBeenCalled();
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport.mock.calls).toEqual([[settled]]);
  });
  test('omitted refs retain the exact legacy CAS and do not touch reference storage', async () => {
    const f = ports();
    expect(await f.report(legacy, caller)).toMatchObject({ accepted: true });
    expect(f.deps.transitionWork.mock.calls).toEqual([
      [work.id, work, { status: legacy.status, report: legacy.report }],
    ]);
    expect(f.resourceReports.get).not.toHaveBeenCalled();
    expect(f.resourceReports.settle).not.toHaveBeenCalled();
  });
  test('a reusable reporter without the optional primitive fails explicit refs closed', async () => {
    const f = ports();
    const { resourceReports: unused, ...deps } = f.deps;
    expect(await createNeoWorkReporter(deps)(input, caller)).toEqual(rejected('invalid_report'));
    expect(unused.settle).not.toHaveBeenCalled();
    expect(deps.transitionWork).not.toHaveBeenCalled();
    expect(deps.returnReport).not.toHaveBeenCalled();
    expect(await createNeoWorkReporter(deps)(legacy, caller)).toMatchObject({ accepted: true });
  });
  test.each([
    { source: 'rpc', principal: 'local' },
    { source: 'internal', sessionId: 'recipient' },
    { source: 'mcp', sessionId: 'foreign' },
  ] satisfies OperationCaller[])(
    'transport/owner rejection precedes all reference effects: %j',
    async (foreign) => {
      const f = ports();
      expect(await f.report(input, foreign)).toHaveProperty('accepted', false);
      expect(f.resourceReports.get).not.toHaveBeenCalled();
      expect(f.resourceReports.settle).not.toHaveBeenCalled();
      expect(f.deps.returnReport).not.toHaveBeenCalled();
    }
  );
  test('coordinator bindings cannot report resources and failed CAS cannot deliver them', async () => {
    const f = ports();
    const report = createNeoWorkReporter({
      ...f.deps,
      readBinding: () => ({ sessionId: 'recipient', kind: 'concern', concernId: 'A' }),
    });
    expect(await report(input, caller)).toEqual(rejected('recipient_is_coordinator'));
    expect(f.resourceReports.settle).not.toHaveBeenCalled();
    f.resourceReports.settle.mockReturnValue(null);
    expect(await f.report(input, caller)).toEqual(rejected('superseded'));
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
  test('exact canonical replay reads refs but never writes or reroutes', async () => {
    const f = ports();
    f.deps.readWork.mockReturnValue(settled);
    expect(
      await f.report({ ...legacy, resourceRefs: [workflow, task, task] }, caller)
    ).toMatchObject({ accepted: true, replayed: true });
    expect(f.resourceReports.get.mock.calls).toEqual([[work.id]]);
    expect(f.resourceReports.settle).not.toHaveBeenCalled();
    expect(f.deps.transitionWork).not.toHaveBeenCalled();
    expect(f.deps.returnReport.mock.calls).toEqual([[settled]]);
    f.deps.returnReport.mockClear();
    expect(await f.report({ ...input, resourceRefs: [workflow] }, caller)).toEqual(
      rejected('report_conflict')
    );
    expect(f.deps.returnReport).not.toHaveBeenCalled();
  });
});

describe('Neo report resources with real SQL settlement', () => {
  let db: SQLite;
  let repo: NeoRepository;
  let resources: NeoWorkResourceRepository;
  let notifications: number;
  beforeEach(() => {
    db = new SQLite(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createNeoTables(db);
    runMigration283(db);
    runMigration287(db);
    repo = new NeoRepository(db);
    notifications = 0;
    resources = new NeoWorkResourceRepository(db, () => {
      notifications += 1;
    });
  });
  afterEach(() => db.close());
  function queued(id: string) {
    const proposal = repo.proposeWork({
      ...work,
      id,
      requestKey: id,
      originMessageId: `ask-${id}`,
    });
    const pending = repo.transitionWork(id, proposal, {
      status: 'queued',
      sessionId: caller.sessionId,
    });
    if (!pending) throw new Error('Queued receipt missing');
    return pending;
  }
  function reporter() {
    const returnReport = mock(async (_work: NeoWork) => {});
    return {
      returnReport,
      report: createNeoWorkReporter({
        readWork: (id) => repo.getWork(id),
        readBinding: (id) => repo.getBindingBySession(id),
        transitionWork: (id, expected, patch) => repo.transitionWork(id, expected, patch),
        resourceReports: resources,
        returnReport,
      }),
    };
  }
  test.each(['reported', 'failed'] as const)(
    'persists %s evidence and exact refs atomically, with one notification',
    async (status) => {
      queued(work.id);
      const f = reporter();
      const supplied = { ...input, status };
      expect(await f.report(supplied, caller)).toMatchObject({
        accepted: true,
        status,
        replayed: false,
      });
      const saved = repo.getWork(work.id);
      expect(saved).toMatchObject({
        status,
        report: legacy.report,
        originMessageId: `ask-${work.id}`,
      });
      expect(resources.get(work.id)).toEqual(input.resourceRefs);
      expect(
        await f.report({ ...supplied, resourceRefs: [workflow, task, task] }, caller)
      ).toMatchObject({ accepted: true, replayed: true });
      expect(repo.getWork(work.id)).toEqual(saved);
      expect(notifications).toBe(1);
    }
  );
  test('delivery failure retains both records and exact retry returns the same origin', async () => {
    const pending = queued(work.id);
    const f = reporter();
    f.returnReport.mockRejectedValueOnce(new Error('mailbox unavailable'));
    await expect(f.report(input, caller)).rejects.toThrow('mailbox unavailable');
    const saved = repo.getWork(work.id);
    expect(saved).toMatchObject({ status: 'reported' });
    expect(resources.get(work.id)).toEqual(input.resourceRefs);
    expect(await f.report(input, caller)).toMatchObject({ accepted: true, replayed: true });
    expect(f.returnReport.mock.calls[1][0].originMessageId).toBe(pending.originMessageId);
    expect(repo.getWork(work.id)).toEqual(saved);
    expect(notifications).toBe(1);
  });
  test('changed refs cannot rewrite settled data; omitted retries preserve it', async () => {
    queued(work.id);
    const f = reporter();
    await f.report(input, caller);
    const saved = repo.getWork(work.id);
    f.returnReport.mockClear();
    expect(await f.report({ ...input, resourceRefs: [] }, caller)).toEqual(
      rejected('report_conflict')
    );
    expect(f.returnReport).not.toHaveBeenCalled();
    expect(await f.report(legacy, caller)).toMatchObject({ accepted: true, replayed: true });
    expect(resources.get(work.id)).toEqual(input.resourceRefs);
    expect(repo.getWork(work.id)).toEqual(saved);
    expect(notifications).toBe(1);
  });
  test('legacy unknown cannot be retrofitted but explicit empty is an exact reusable set', async () => {
    queued('legacy');
    queued('empty');
    const f = reporter();
    await f.report({ ...legacy, id: 'legacy' }, caller);
    expect(resources.get('legacy')).toBeNull();
    expect(await f.report({ ...legacy, id: 'legacy', resourceRefs: [] }, caller)).toEqual(
      rejected('report_conflict')
    );
    const empty = { ...legacy, id: 'empty', resourceRefs: [] };
    expect(await f.report(empty, caller)).toMatchObject({ accepted: true, replayed: false });
    expect(resources.get('empty')).toEqual([]);
    expect(await f.report(empty, caller)).toMatchObject({ accepted: true, replayed: true });
  });
  test('asks sharing one native manager retain separate origins and resource sets', async () => {
    const a = queued('A');
    const b = queued('B');
    const f = reporter();
    await f.report({ ...legacy, id: a.id, resourceRefs: [task] }, caller);
    await f.report({ ...legacy, id: b.id, resourceRefs: [workflow] }, caller);
    expect(resources.get('A')).toEqual([task]);
    expect(resources.get('B')).toEqual([workflow]);
    expect(f.returnReport.mock.calls.map(([value]) => [value.id, value.originMessageId])).toEqual([
      ['A', 'ask-A'],
      ['B', 'ask-B'],
    ]);
    expect(repo.getWork('A')?.sessionId).toBe('recipient');
    expect(repo.getWork('B')?.sessionId).toBe('recipient');
  });
});

describe('NeoService resource-report Wire', () => {
  test('uses the atomic primitive and existing deduplicated mailbox with no SDK execution', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const createSession = mock(async () => {
      throw new Error('No new execution');
    });
    const getSessionAsync = mock(async () => {
      throw new Error('No SDK load');
    });
    const event = mock(() => {});
    const service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      const sql = db.getDatabase();
      for (const id of ['root', 'recipient'])
        sql
          .prepare(
            `INSERT INTO sessions(id, title, workspace_path, created_at, last_active_at, status, config, metadata) VALUES (?, ?, NULL, '2026-09-28T12:00:00Z', '2026-09-28T12:00:00Z', 'active', '{}', '{}')`
          )
          .run(id, id);
      service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
      const proposed = service.repo.proposeWork(work);
      service.repo.transitionWork(work.id, proposed, { status: 'queued', sessionId: 'recipient' });
      const capture = () =>
        JSON.stringify(
          ['sessions', 'neo_concerns', 'neo_session_bindings', 'sdk_messages'].map((table) =>
            sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
          )
        );
      const before = capture();
      event.mockClear();
      const operation = createNeoOperations(service).find(
        (entry) => entry.name === 'neo.work.report'
      );
      if (!operation) throw new Error('Report operation missing');
      expect(
        operation.inputSchema.safeParse({
          ...input,
          resourceRefs: Array.from({ length: 17 }, () => task),
        }).success
      ).toBe(false);
      expect(await operation.execute(operation.inputSchema.parse(input), caller)).toMatchObject({
        accepted: true,
        replayed: false,
      });
      expect(db.neoWorkResources.get(work.id)).toEqual(input.resourceRefs);
      expect(
        await service.reportWork({ ...legacy, resourceRefs: [workflow, task, task] }, caller)
      ).toMatchObject({ accepted: true, replayed: true });
      expect(event).toHaveBeenCalledTimes(1);
      const jobs = db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: work.id });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({
        to: { kind: 'session', sessionId: 'root' },
        origin: 'session:recipient',
        messageUuid: work.id,
      });
      expect(JSON.stringify(jobs[0].payload)).toContain('ask-A');
      expect(capture()).toBe(before);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      db.close();
    }
  });
});
