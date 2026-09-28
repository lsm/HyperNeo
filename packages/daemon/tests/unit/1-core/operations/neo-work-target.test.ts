import { describe, expect, mock, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { MessageHub } from '@hyperneo/shared';
import {
  admitNeoWorkTargetId,
  createNeoWorkTargetResolver,
  presentNeoWorkTarget,
  requireNeoWorkTargetBinding,
  requireNeoWorkTargetSession,
  requireStoredNeoWorkTarget,
  type NeoWorkTargetDependencies,
} from '../../../../src/lib/neo/work-target.ts';
import type { NeoWorkTarget } from '../../../../src/storage/repositories/neo-repository.ts';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';

const target: NeoWorkTarget = Object.freeze({
  id: 'work-A',
  targetSessionId: 'project:α/work?keep=1',
});
const session = Object.freeze({ id: target.targetSessionId!, status: 'active' });
const worker: NeoBinding = { sessionId: session.id, kind: 'worker', concernId: 'research' };
type TargetRejection = Extract<ReturnType<typeof presentNeoWorkTarget>, { accepted: false }>;
const rejection = (reason: TargetRejection['reason']): { reason: TargetRejection } => ({
  reason: { accepted: false, reason },
});
function fixture() {
  const deps = {
    readTarget: mock<NeoWorkTargetDependencies['readTarget']>(() => target),
    readSession: mock<NeoWorkTargetDependencies['readSession']>(() => session),
    readBinding: mock<NeoWorkTargetDependencies['readBinding']>(() => null),
  } satisfies NeoWorkTargetDependencies;
  return { deps, resolve: createNeoWorkTargetResolver(deps) };
}

describe('Neo work target pure gates', () => {
  test.each(['', ' ', '\n\t'])('rejects blank work IDs: %j', (id) => {
    expect(admitNeoWorkTargetId(id)).toEqual(rejection('invalid_work_id'));
  });
  test.each(['Work:α|?x=1', ' work-A '])('preserves opaque IDs without normalization: %j', (id) => {
    expect(admitNeoWorkTargetId(id)).toEqual({ value: id });
  });
  test.each([null, { ...target, id: 'work-B' }])(
    'requires the exact recorded work: %j',
    (record) => {
      expect(requireStoredNeoWorkTarget(target.id, record)).toEqual(rejection('work_not_found'));
    }
  );
  test.each(['', ' ', '\t'])('rejects corrupt target references rather than guessing: %j', (id) => {
    expect(requireStoredNeoWorkTarget(target.id, { ...target, targetSessionId: id })).toEqual(
      rejection('invalid_target_reference')
    );
  });
  test('missing target metadata is not a null/default target', () => {
    expect(requireStoredNeoWorkTarget(target.id, { id: target.id } as NeoWorkTarget)).toEqual(
      rejection('invalid_target_reference')
    );
    for (const record of [target, { ...target, targetSessionId: null }])
      expect(requireStoredNeoWorkTarget(target.id, record)).toEqual({ value: record });
  });
  test.each([null, { ...session, id: 'different' }])(
    'rejects missing/mismatched sessions: %j',
    (value) => {
      expect(requireNeoWorkTargetSession(target, value)).toEqual(
        rejection('target_session_not_found')
      );
    }
  );
  test.each(['paused', 'ended', 'archived', 'pending_worktree_choice', 'unknown', ''])(
    'only active recorded targets are selected: %j',
    (status) => {
      expect(requireNeoWorkTargetSession(target, { ...session, status })).toEqual(
        rejection('target_session_not_active')
      );
    }
  );
  test('default targeting does not borrow an existing session or binding', () => {
    const record = Object.freeze({ ...target, targetSessionId: null });
    expect(requireNeoWorkTargetSession(record, null)).toEqual({ value: record });
    expect(requireNeoWorkTargetBinding(record, worker)).toEqual({ value: record });
  });
  test.each([null, worker])(
    'an ordinary chat or actual execution worker is selectable: %j',
    (binding) => {
      expect(requireNeoWorkTargetSession(target, session)).toEqual({ value: target });
      expect(requireNeoWorkTargetBinding(target, binding)).toEqual({ value: target });
    }
  );
  test.each([
    { ...worker, kind: 'neo' as const, concernId: null },
    { ...worker, kind: 'concern' as const },
  ])('holders/coordinators are context buffers, not execution targets: %j', (binding) => {
    expect(requireNeoWorkTargetBinding(target, binding)).toEqual(
      rejection('target_is_coordinator')
    );
  });
  test('binding identity must match even for an execution worker', () => {
    expect(requireNeoWorkTargetBinding(target, { ...worker, sessionId: 'other' })).toEqual(
      rejection('invalid_target_binding')
    );
  });
  test('presentation copies the reference without granting roles, content or authority', () => {
    const result = presentNeoWorkTarget(target);
    expect(result).toEqual({ accepted: true, workId: target.id, targetSessionId: session.id });
    expect(result).not.toHaveProperty('spaceId');
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('context');
    if (!result.accepted) throw new Error(result.reason);
    result.targetSessionId = 'changed-output';
    expect(target.targetSessionId).toBe(session.id);
  });
});

describe('Neo work target composition', () => {
  test('constructs without reading and resolves synchronously through primitive ports', () => {
    const f = fixture();
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
    const result = f.resolve(target.id);
    expect(result).toEqual(presentNeoWorkTarget(target));
    expect(result).not.toBeInstanceOf(Promise);
    expect(f.deps.readTarget.mock.calls).toEqual([[target.id]]);
    expect(f.deps.readSession.mock.calls).toEqual([[session.id]]);
    expect(f.deps.readBinding.mock.calls).toEqual([[session.id]]);
  });
  test('invalid IDs precede every read', () => {
    const f = fixture();
    expect(f.resolve(' ')).toEqual({ accepted: false, reason: 'invalid_work_id' });
    for (const port of Object.values(f.deps)) expect(port).not.toHaveBeenCalled();
  });
  test.each([
    { record: null, reason: 'work_not_found' },
    { record: { ...target, id: 'work-B' }, reason: 'work_not_found' },
    { record: { ...target, targetSessionId: '' }, reason: 'invalid_target_reference' },
  ])('stored target gate precedes execution-context reads: %j', ({ record, reason }) => {
    const f = fixture();
    f.deps.readTarget.mockReturnValue(record);
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason });
    expect(f.deps.readSession).not.toHaveBeenCalled();
    expect(f.deps.readBinding).not.toHaveBeenCalled();
  });
  test('explicit null survives composition and never reads another session', () => {
    const f = fixture();
    f.deps.readTarget.mockReturnValue({ ...target, targetSessionId: null });
    expect(f.resolve(target.id)).toEqual({
      accepted: true,
      workId: target.id,
      targetSessionId: null,
    });
    expect(f.deps.readSession).not.toHaveBeenCalled();
    expect(f.deps.readBinding).not.toHaveBeenCalled();
  });
  test.each([
    { row: null, reason: 'target_session_not_found' },
    { row: { ...session, id: 'other' }, reason: 'target_session_not_found' },
    { row: { ...session, status: 'archived' }, reason: 'target_session_not_active' },
  ])('target existence/activity precedes binding reads: %j', ({ row, reason }) => {
    const f = fixture();
    f.deps.readSession.mockReturnValue(row);
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason });
    expect(f.deps.readBinding).not.toHaveBeenCalled();
  });
  test('coordinator binding stops selection without replacing the target', () => {
    const f = fixture();
    f.deps.readBinding.mockReturnValue({ ...worker, kind: 'concern' });
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'target_is_coordinator' });
    expect(f.deps.readTarget).toHaveBeenCalledTimes(1);
    expect(f.deps.readSession).toHaveBeenCalledTimes(1);
    expect(f.deps.readBinding).toHaveBeenCalledTimes(1);
  });
  test('rechecks actual target state without caching or borrowing a newer work reference', () => {
    const f = fixture();
    const first = f.resolve(target.id);
    f.deps.readSession.mockReturnValue(null);
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'target_session_not_found' });
    f.deps.readTarget.mockReturnValue({ ...target, id: 'work-B', targetSessionId: 'new-target' });
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'work_not_found' });
    expect(first).toEqual(presentNeoWorkTarget(target));
    expect(f.deps.readBinding).toHaveBeenCalledTimes(1);
  });
  test.each(['readTarget', 'readSession', 'readBinding'] as const)(
    '%s infrastructure failure propagates once without fallback or retry',
    (name) => {
      const f = fixture();
      f.deps[name].mockImplementation(() => {
        throw new Error('storage fault');
      });
      expect(() => f.resolve(target.id)).toThrow('storage fault');
      expect(f.deps[name]).toHaveBeenCalledTimes(1);
      if (name !== 'readBinding') expect(f.deps.readBinding).not.toHaveBeenCalled();
      if (name === 'readTarget') expect(f.deps.readSession).not.toHaveBeenCalled();
    }
  );
});

describe('NeoService work-target read facet', () => {
  test('resolves real persisted ordinary/manager targets without session, job or context writes', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const createSession = mock(async () => {
      throw new Error('must not create or load execution');
    });
    const getSessionAsync = mock(async () => {
      throw new Error('must not load SDK');
    });
    const event = mock(() => {});
    const service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const sql = db.getDatabase();
    try {
      service.repo.saveConcern(
        { id: 'research', title: 'Research', summary: 'Learn', context: 'Private' },
        0
      );
      for (const id of ['project-chat', 'family-chat', 'space-manager', 'holder']) {
        sql
          .prepare(`INSERT INTO sessions(id, title, workspace_path, created_at, last_active_at, status, config, metadata)
          VALUES (?, ?, ?, '2026-09-28T12:00:00Z', '2026-09-28T12:00:00Z', 'active', '{}', '{}')`)
          .run(id, id, id === 'project-chat' ? '/projects/a' : null);
      }
      sql
        .prepare(`INSERT INTO spaces(id, slug, name, workspace_path, created_at, updated_at)
        VALUES ('space-a', 'space-a', 'Project A', '/projects/a', 1, 1)`)
        .run();
      sql
        .prepare(`INSERT INTO space_long_horizon_agents(id, space_id, handle, display_name, session_id, instructions, created_at, updated_at)
        VALUES ('manager', 'space-a', 'manager', 'Manager', 'space-manager', 'Existing responsibilities', 1, 1)`)
        .run();
      service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'research' });
      const base = {
        requestKey: 'unused',
        concernId: 'research',
        originSessionId: 'root',
        originMessageId: 'ask-A',
        title: 'Readiness',
        instruction: 'Approved scope later',
      };
      for (const targetSessionId of [
        'project-chat',
        'family-chat',
        'space-manager',
        'holder',
        'missing',
        null,
      ]) {
        const id = targetSessionId ?? 'default';
        service.repo.proposeWork({ ...base, id, requestKey: id, targetSessionId });
      }
      const capture = () =>
        JSON.stringify(
          [
            'neo_work',
            'neo_concerns',
            'neo_session_bindings',
            'sessions',
            'space_long_horizon_agents',
            'job_queue',
            'sdk_messages',
          ].map((table) => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        );
      const before = capture();
      event.mockClear();
      for (const workId of ['project-chat', 'family-chat', 'space-manager'])
        expect(service.resolveWorkTarget(workId)).toEqual({
          accepted: true,
          workId,
          targetSessionId: workId,
        });
      expect(service.resolveWorkTarget('holder')).toEqual({
        accepted: false,
        reason: 'target_is_coordinator',
      });
      expect(service.resolveWorkTarget('missing')).toEqual({
        accepted: false,
        reason: 'target_session_not_found',
      });
      expect(service.resolveWorkTarget('unknown')).toEqual({
        accepted: false,
        reason: 'work_not_found',
      });
      expect(service.resolveWorkTarget('default')).toEqual({
        accepted: true,
        workId: 'default',
        targetSessionId: null,
      });
      expect(capture()).toBe(before);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
      expect(event).not.toHaveBeenCalled();
      sql.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'project-chat'").run();
      expect(service.resolveWorkTarget('project-chat')).toEqual({
        accepted: false,
        reason: 'target_session_not_active',
      });
      expect(service.repo.getWorkTarget('project-chat')).toEqual({
        id: 'project-chat',
        targetSessionId: 'project-chat',
      });
      expect(service.repo.getWork('project-chat')).toMatchObject({
        status: 'proposed',
        sessionId: null,
        originMessageId: 'ask-A',
      });
    } finally {
      service.dispose();
      db.close();
    }
  });
});
