import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

async function driveThenClear(sessionId: string, bound: boolean) {
  const db = await createTestDb();
  await db.createSession(createTestSession(sessionId));
  new NeoRepository(db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  const agentSession = new AgentSession(
    db.getSession(sessionId)!,
    db,
    new MessageHub(),
    await createTestInternalEventBus(),
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  );
  const repo = db.getSDKMessageRepo();
  repo.saveUserMessage(
    sessionId,
    {
      type: 'user',
      uuid: 'human-1',
      inputKind: 'human',
      message: { role: 'user', content: 'Remove i4' },
    } as unknown as SDKMessage,
    'enqueued'
  );
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: mock(async () => 'started'),
    executeDeferredRestartIfPending: mock(async () => {}),
  };
  agentSession.queryPromise = new Promise<void>(() => {});
  agentSession.messageQueue.start();
  const generator = agentSession.messageQueue.messageGenerator(sessionId, {
    suppressPreYieldCallback: true,
  });
  const turn = agentSession.driveDeliveryTurn('human-1', 'Remove i4', null, false, () => true);
  const next = await generator.next();
  if (bound) {
    next.value?.onSent();
    await turn;
  }
  agentSession.messageQueue.clear();
  const outcome = await turn.then(
    (value) => value,
    (error: Error) => ({ thrown: error.message })
  );
  const status = repo.getDeliveryContent(sessionId, 'human-1')?.sendStatus;
  await generator.return?.(undefined);
  agentSession.messageQueue.stop();
  db.close();
  return { outcome, status };
}

describe('AgentSession driveDeliveryTurn for a input acknowledged through the ordinary queue', () => {
  it('completes when the queue is cleared after the turn took the input, so it never runs again', async () => {
    expect(await driveThenClear('neo:once', true)).toEqual({
      outcome: { outcome: 'completed' },
      status: 'consumed',
    });
  });

  it('still fails for retry when the queue is cleared before any turn took the input', async () => {
    expect(await driveThenClear('neo:untaken', false)).toEqual({
      outcome: { thrown: 'Interrupted by user' },
      status: 'enqueued',
    });
  });
});
