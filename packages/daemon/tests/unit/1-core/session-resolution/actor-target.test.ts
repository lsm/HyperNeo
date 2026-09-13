import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../../messaging/src/types.ts';
import { actorRefToSessionTarget } from '../../../../src/lib/session-resolution/actor-target';

function actor(
  actorId: string,
  kind: ActorRef['kind'],
  overrides: Partial<ActorRef> = {}
): ActorRef {
  return {
    actorId,
    kind,
    spaceId: 'space-1',
    status: 'active',
    ...overrides,
  };
}

describe('actorRefToSessionTarget', () => {
  test('human actor maps to the session target under the human: prefix', () => {
    expect(actorRefToSessionTarget(actor('human:sess-9', 'human'), 'space-1')).toEqual({
      kind: 'session',
      sessionId: 'sess-9',
    });
  });

  test('session actor maps to the session target under the session: prefix', () => {
    expect(actorRefToSessionTarget(actor('session:sess-9', 'session'), 'space-1')).toEqual({
      kind: 'session',
      sessionId: 'sess-9',
    });
  });

  test('agent actor decodes the encoded agent id', () => {
    expect(
      actorRefToSessionTarget(actor(`agent:${encodeURIComponent('agent one')}`, 'agent'), 'space-1')
    ).toEqual({ kind: 'agent', spaceId: 'space-1', agentId: 'agent one' });
  });

  test('the former coordinator alias actor decodes as an ordinary agent id', () => {
    expect(actorRefToSessionTarget(actor('agent:coordinator:space-1', 'agent'), 'space-1')).toEqual(
      {
        kind: 'agent',
        spaceId: 'space-1',
        agentId: 'coordinator:space-1',
      }
    );
  });

  test('derived coordinator row actor stays a plain agent target for record resolution', () => {
    expect(
      actorRefToSessionTarget(actor('agent:space-lh-agent:coordinator:space-1', 'agent'), 'space-1')
    ).toEqual({
      kind: 'agent',
      spaceId: 'space-1',
      agentId: 'space-lh-agent:coordinator:space-1',
    });
  });

  test('actor from another space does not map', () => {
    expect(
      actorRefToSessionTarget(actor('session:sess-9', 'session', { spaceId: 'space-2' }), 'space-1')
    ).toBeNull();
  });

  test('worker actors do not map: the actor id is run-keyed, the worker target is task-keyed', () => {
    const workerActorId = `worker:${encodeURIComponent('run-1')}:${encodeURIComponent('node-1')}:${encodeURIComponent('coder')}`;

    expect(actorRefToSessionTarget(actor(workerActorId, 'worker'), 'space-1')).toBeNull();
  });

  test('system actors and malformed prefixes do not map', () => {
    expect(actorRefToSessionTarget(actor('system:scheduler', 'system'), 'space-1')).toBeNull();
    expect(actorRefToSessionTarget(actor('nope-sess-9', 'session'), 'space-1')).toBeNull();
    expect(actorRefToSessionTarget(actor('human:', 'human'), 'space-1')).toBeNull();
    expect(
      actorRefToSessionTarget(actor('worker:run-1:node-1:coder', 'agent'), 'space-1')
    ).toBeNull();
  });
});
