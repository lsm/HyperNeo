import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  clearProviderFailure,
  getProviderFailure,
  recordClassifiedProviderFailure,
} from '../../../../src/lib/providers/provider-failure-store.ts';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database.ts';

function createAgentSession(provider: string): AgentSession {
  const session = {
    id: `auth-rejected-${Math.random()}`,
    title: 'Rejected key',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { model: 'glm-5', provider, maxTokens: 8192, temperature: 1.0 },
    metadata: {},
  } as Session;
  const db = {
    getSession: mock(() => session),
    updateSession: mock(() => {}),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    getSDKMessageRepo: mock(() => ({
      getUserMessageContentByUuid: mock(() => null),
      markDeliveryRetryableByUuid: mock(() => null),
    })),
  } as unknown as Database;
  return new AgentSession(
    session,
    db,
    { event: mock(() => {}) } as MessageHub,
    {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>,
    mock(async () => 'test-api-key')
  );
}

describe('AgentSession.onProviderAuthRejected', () => {
  afterEach(() => {
    clearProviderFailure('glm');
    clearProviderFailure('anthropic');
    resetProviderRegistry();
  });

  it('marks the provider failed, tells the human once, and stops every rejected turn', async () => {
    const sessions = [createAgentSession('glm'), createAgentSession('glm')];
    const notices = sessions.map((session) =>
      spyOn(session.queryRunner, 'displayErrorAsAssistantMessage').mockResolvedValue(undefined)
    );
    const stops = sessions.map((session) =>
      spyOn(session, 'handleInterrupt').mockResolvedValue(undefined)
    );

    await sessions[0].onProviderAuthRejected('HTTP 401: authentication_error');
    await sessions[1].onProviderAuthRejected('HTTP 401: authentication_error');

    expect(getProviderFailure('glm')).toMatchObject({
      errorKind: 'credential',
      message: 'HTTP 401: authentication_error',
    });
    expect(notices[0].mock.calls[0][0]).toMatch(/key rejected; update it in Providers\.$/);
    expect(notices[1]).not.toHaveBeenCalled();
    expect(stops.map((stop) => stop.mock.calls.length)).toEqual([1, 1]);
  });

  it('still tells the human when a model check recorded the rejection first', async () => {
    recordClassifiedProviderFailure('glm', { errorKind: 'credential', message: 'HTTP 401' });
    const session = createAgentSession('glm');
    const notice = spyOn(session.queryRunner, 'displayErrorAsAssistantMessage').mockResolvedValue(
      undefined
    );
    spyOn(session, 'handleInterrupt').mockResolvedValue(undefined);

    await session.onProviderAuthRejected('HTTP 401: authentication_error');
    await session.onProviderAuthRejected('HTTP 401: authentication_error');

    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('ignores a retry from an earlier query and leaves Anthropic to its own refresh', async () => {
    const stale = createAgentSession('glm');
    const stop = spyOn(stale, 'handleInterrupt').mockResolvedValue(undefined);
    await stale.onProviderAuthRejected('HTTP 401: x', stale.getQueryGeneration() + 1);
    const anthropic = createAgentSession('anthropic');
    const anthropicStop = spyOn(anthropic, 'handleInterrupt').mockResolvedValue(undefined);
    await anthropic.onProviderAuthRejected('HTTP 401: x');

    expect(stop).not.toHaveBeenCalled();
    expect(anthropicStop).not.toHaveBeenCalled();
    expect(getProviderFailure('glm')).toBeUndefined();
    expect(getProviderFailure('anthropic')).toBeUndefined();
  });
});
