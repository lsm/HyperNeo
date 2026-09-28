import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import {
  requireNeoAgentWorkReference,
  requireNeoAgentWorkSession,
  requireNeoAgentWorkBinding,
  type NeoAgentWorkOwner,
} from '../../../../src/lib/neo/agent-work-target.ts';
import { createNeoWorkTargetResolver } from '../../../../src/lib/neo/work-target.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { NeoWorkTarget } from '../../../../src/storage/repositories/neo-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const agent = Object.freeze({
  spaceId: 'space-A',
  agentId: 'manager-A',
  sessionId: 'manager-session',
});
const target: NeoWorkTarget = Object.freeze({
  id: 'work-A',
  targetSessionId: agent.sessionId,
  agent,
});
const session = Object.freeze({
  id: agent.sessionId,
  status: 'active',
  scopeOwned: 1,
  neoBound: 0,
});
const owner: NeoAgentWorkOwner = Object.freeze({
  agentId: agent.agentId,
  spaceId: agent.spaceId,
  sessionId: agent.sessionId,
  agentStatus: 'active',
  spaceStatus: 'active',
  paused: 0,
  stopped: 0,
  nativeSpaceId: null,
  ownerCount: 1,
});
const denied = (reason: string) => ({ reason: { accepted: false, reason } });

describe('Neo managed work target gates', () => {
  test('opaque immutable references survive without normalization', () => {
    expect(requireNeoAgentWorkReference(target)).toEqual({ value: target });
    expect(requireNeoAgentWorkReference({ ...target, agent: undefined })).toMatchObject({
      value: { agent: undefined },
    });
    expect(requireNeoAgentWorkSession(target, session, owner)).toEqual({ value: target });
    expect(
      requireNeoAgentWorkSession(target, session, { ...owner, nativeSpaceId: agent.spaceId })
    ).toEqual({ value: target });
    expect(requireNeoAgentWorkBinding(target, null)).toEqual({ value: target });
  });
  test.each([
    { spaceId: '', agentId: agent.agentId, sessionId: agent.sessionId },
    { ...agent, agentId: ' \n' },
    { ...agent, sessionId: 'different' },
    null,
  ])('rejects malformed or mismatched explicit references: %j', (value) => {
    expect(requireNeoAgentWorkReference({ ...target, agent: value } as NeoWorkTarget)).toEqual(
      denied('invalid_agent_reference')
    );
  });
  test('managed metadata cannot convert a scratch request into an agent request', () => {
    expect(requireNeoAgentWorkReference({ ...target, targetSessionId: null })).toEqual(
      denied('invalid_agent_reference')
    );
  });
  test.each([null, { ...session, id: 'different' }])(
    'requires exact existing session: %j',
    (value) => {
      expect(requireNeoAgentWorkSession(target, value, owner)).toEqual(
        denied('target_session_not_found')
      );
    }
  );
  test.each(['archived', 'paused', 'unknown'])('requires active session %s', (status) => {
    expect(requireNeoAgentWorkSession(target, { ...session, status }, owner)).toEqual(
      denied('target_session_not_active')
    );
  });
  test('Neo role/binding claims cannot replace native manager ownership', () => {
    expect(requireNeoAgentWorkSession(target, { ...session, neoBound: 1 }, owner)).toEqual(
      denied('target_owned_context')
    );
    for (const kind of ['neo', 'concern', 'worker'] as const)
      expect(
        requireNeoAgentWorkBinding(target, { sessionId: session.id, kind, concernId: 'research' })
      ).toEqual(denied('target_owned_context'));
  });
  test.each([
    null,
    { ...owner, agentId: 'other' },
    { ...owner, spaceId: 'other' },
    { ...owner, sessionId: 'replacement' },
    { ...owner, nativeSpaceId: 'other-space' },
  ])('native actor references must match at read time: %j', (value) => {
    expect(requireNeoAgentWorkSession(target, session, value)).toEqual(
      denied('target_agent_unavailable')
    );
  });
  test.each([0, 2, -1])('ownership must be exclusive: %s', (ownerCount) => {
    expect(requireNeoAgentWorkSession(target, session, { ...owner, ownerCount })).toEqual(
      denied('ambiguous_target_agent')
    );
  });
  test.each(['paused', 'disabled', 'archived', 'unknown'])(
    'inactive manager %s remains unavailable',
    (agentStatus) => {
      expect(requireNeoAgentWorkSession(target, session, { ...owner, agentStatus })).toEqual(
        denied('target_agent_not_active')
      );
    }
  );
  test.each([{ spaceStatus: 'archived' }, { paused: 1 }, { stopped: 1 }, { paused: 2 }])(
    'owning Space stops new work: %j',
    (patch) => {
      expect(requireNeoAgentWorkSession(target, session, { ...owner, ...patch })).toEqual(
        denied('target_space_not_active')
      );
    }
  );
});

describe('Neo managed work target composition', () => {
  function fixture(record: NeoWorkTarget = target) {
    const deps = {
      readTarget: mock(() => record),
      readSession: mock(() => session),
      readBinding: mock(() => null),
      readAgentOwner: mock(() => owner as NeoAgentWorkOwner | null),
    };
    return { deps, resolve: createNeoWorkTargetResolver(deps) };
  }
  test('a synchronous reusable pipeline reads the exact owner without granting a new role', () => {
    const f = fixture();
    const result = f.resolve(target.id);
    expect(result).toEqual({ accepted: true, workId: target.id, targetSessionId: session.id });
    expect(result).not.toBeInstanceOf(Promise);
    expect(f.deps.readAgentOwner.mock.calls).toEqual([[agent]]);
    expect(f.deps.readBinding.mock.calls).toEqual([[session.id]]);
    expect(result).not.toHaveProperty('role');
  });
  test('ordinary scope-owned targets remain rejected without reading agent ports', () => {
    const f = fixture({ ...target, agent: undefined });
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'target_owned_context' });
    expect(f.deps.readAgentOwner).not.toHaveBeenCalled();
    expect(f.deps.readBinding).not.toHaveBeenCalled();
  });
  test('invalid explicit target halts before reading session or native owner', () => {
    const f = fixture({ ...target, agent: { ...agent, sessionId: 'other' } });
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'invalid_agent_reference' });
    expect(f.deps.readSession).not.toHaveBeenCalled();
    expect(f.deps.readAgentOwner).not.toHaveBeenCalled();
  });
  test('missing optional owner port fails closed rather than admitting an ordinary chat', () => {
    expect(
      createNeoWorkTargetResolver({
        readTarget: () => target,
        readSession: () => session,
        readBinding: () => null,
      })(target.id)
    ).toEqual({ accepted: false, reason: 'target_agent_unavailable' });
  });
  test('owner rejection precedes binding reads and no cached admission survives drift', () => {
    const f = fixture();
    expect(f.resolve(target.id)).toMatchObject({ accepted: true });
    f.deps.readAgentOwner.mockReturnValue({ ...owner, sessionId: 'replacement' });
    expect(f.resolve(target.id)).toEqual({ accepted: false, reason: 'target_agent_unavailable' });
    expect(f.deps.readBinding).toHaveBeenCalledTimes(1);
    f.deps.readAgentOwner.mockImplementation(() => {
      throw new Error('native owner read fault');
    });
    expect(() => f.resolve(target.id)).toThrow('native owner read fault');
  });
});

describe('Neo native agent target integration', () => {
  test('actual owner records remain unchanged and reassignment invalidates the reserved receiver', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      db.createSession(createTestSession(agent.sessionId));
      db.createSession(createTestSession('replacement'));
      db.getDatabase()
        .prepare(
          'INSERT INTO spaces(id,slug,name,workspace_path,created_at,updated_at) VALUES (?,?,?,?,1,1)'
        )
        .run(agent.spaceId, 'space-a', 'Existing Space', '/controlled-qa');
      const agents = new SpaceLongHorizonAgentRepository(db.getDatabase());
      agents.create({
        id: agent.agentId,
        spaceId: agent.spaceId,
        handle: 'manager',
        sessionId: agent.sessionId,
        instructions: 'Existing native responsibilities',
      });
      service.repo.proposeWork({
        id: target.id,
        requestKey: 'A',
        concernId: null,
        originSessionId: 'root',
        originMessageId: 'ask-A',
        title: 'Bounded draft',
        instruction: 'No execution in this Build test',
        targetSessionId: agent.sessionId,
      });
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: false,
        reason: 'target_owned_context',
      });
      expect(service.agentTargets.reserve(target.id, agent)).toEqual(agent);
      const before = JSON.stringify(
        db.getDatabase().prepare('SELECT * FROM space_long_horizon_agents').all()
      );
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: true,
        workId: target.id,
        targetSessionId: agent.sessionId,
      });
      expect(
        JSON.stringify(db.getDatabase().prepare('SELECT * FROM space_long_horizon_agents').all())
      ).toBe(before);
      expect(service.repo.getWork(target.id)).toMatchObject({
        status: 'proposed',
        sessionId: null,
        originMessageId: 'ask-A',
      });
      expect(service.repo.getBindingBySession(agent.sessionId)).toBeNull();
      agents.update(agent.agentId, { status: 'paused' });
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: false,
        reason: 'target_agent_not_active',
      });
      agents.update(agent.agentId, { status: 'active', sessionId: 'replacement' });
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: false,
        reason: 'target_agent_unavailable',
      });
      expect(service.agentTargets.get(target.id)).toEqual(agent);
      agents.update(agent.agentId, { sessionId: agent.sessionId });
      db.getDatabase().prepare('UPDATE spaces SET paused = 1 WHERE id = ?').run(agent.spaceId);
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: false,
        reason: 'target_space_not_active',
      });
      db.getDatabase().prepare('UPDATE spaces SET paused = 0 WHERE id = ?').run(agent.spaceId);
      agents.create({
        id: 'duplicate',
        spaceId: agent.spaceId,
        handle: 'duplicate',
        sessionId: agent.sessionId,
      });
      expect(service.resolveWorkTarget(target.id)).toEqual({
        accepted: false,
        reason: 'ambiguous_target_agent',
      });
    } finally {
      service.dispose();
      db.close();
    }
  });
});
