import { afterEach, describe, expect, it, mock } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub as MessageHubType } from '@hyperneo/shared';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { deliverMessage } from '../../../../src/lib/agent/message-delivery';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import type { Database } from '../../../../src/storage/database';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

type Harness = {
  db: Database;
  service: ReturnType<typeof createNeoService>;
  agentSession: AgentSession;
  sessionId: string;
  failed: string[][];
};

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.agentSession.messageQueue.stop();
    harness.service.dispose();
    harness.db.close();
  }
  vi.restoreAllMocks();
});

async function makeHarness(sessionId: string): Promise<Harness> {
  const db = await createTestDb();
  await db.createSession(createTestSession(sessionId));
  new NeoRepository(db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  const events = new InternalEventBus<DaemonInternalEventMap>();
  const failed: string[][] = [];
  events.subscribe(
    'messages.statusChanged',
    ({ messageIds, status }) => {
      if (status === 'failed') failed.push(messageIds);
    },
    { subscriberName: 'test-failed-notes' }
  );
  const service = createNeoService(
    db,
    { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
    { event: vi.fn() } as unknown as MessageHubType,
    events
  );
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
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: mock(async () => 'started'),
    executeDeferredRestartIfPending: mock(async () => {}),
  };
  agentSession.queryPromise = new Promise<void>(() => {});
  const harness = { db, service, agentSession, sessionId, failed };
  harnesses.push(harness);
  return harness;
}

function queueNote(harness: Harness, uuid: string): void {
  harness.db.getSDKMessageRepo().saveUserMessage(
    harness.sessionId,
    {
      type: 'user',
      uuid,
      inputKind: 'system',
      message: { role: 'user', content: `note ${uuid}` },
    } as unknown as SDKMessage,
    'enqueued'
  );
  deliverMessage(harness.db.getJobQueueRepo(), harness.sessionId, uuid, { origin: 'recovery' });
}

function consumeHumanInput(harness: Harness, uuid: string): void {
  harness.db.getSDKMessageRepo().saveUserMessage(
    harness.sessionId,
    {
      type: 'user',
      uuid,
      inputKind: 'human',
      message: { role: 'user', content: 'what is the status?' },
    } as unknown as SDKMessage,
    'consumed'
  );
}

const statusOf = (harness: Harness, uuid: string) =>
  harness.db.getSDKMessageRepo().getDeliveryContent(harness.sessionId, uuid)?.sendStatus;

const mailboxed = (harness: Harness, uuid: string) =>
  harness.db
    .getJobQueueRepo()
    .listActiveByPayload('mailbox', { 'to.sessionId': harness.sessionId, messageUuid: uuid })
    .length;

async function streamIntoRunningTurn(harness: Harness, head: string) {
  const { agentSession, sessionId } = harness;
  agentSession.messageQueue.start();
  const generator = agentSession.messageQueue.messageGenerator(sessionId, {
    suppressPreYieldCallback: true,
  });
  const turn = agentSession.driveDeliveryTurn(head, `note ${head}`, null, false, () => true);
  const yielded = await generator.next();
  if (!yielded.value) throw new Error('note was not streamed');
  return { generator, turn, sent: yielded.value };
}

describe('Neo note queue', () => {
  it('retains older notes when a newer note for the same card or ask arrives', async () => {
    const harness = await makeHarness('neo:supersede');
    queueNote(harness, 'w1:done-check:1');
    queueNote(harness, 'neo-ask-evidence:a1:old');
    queueNote(harness, 'w2:done-check:1');
    await harness.service.deliverForward(
      harness.sessionId,
      'w1:stall:7',
      'stalled',
      harness.sessionId,
      'event'
    );
    await harness.service.deliverForward(
      harness.sessionId,
      'neo-ask-evidence:a1:new',
      'evidence',
      harness.sessionId,
      'event'
    );
    expect(statusOf(harness, 'w1:done-check:1')).toBe('enqueued');
    expect(statusOf(harness, 'neo-ask-evidence:a1:old')).toBe('enqueued');
    expect(statusOf(harness, 'w2:done-check:1')).toBe('enqueued');
    expect(harness.failed).toEqual([]);
    expect(mailboxed(harness, 'w1:stall:7')).toBe(1);
    expect(mailboxed(harness, 'neo-ask-evidence:a1:new')).toBe(1);
  });

  it('queues and delivers notes even when their card or ask has settled', async () => {
    const harness = await makeHarness('neo:settled');
    queueNote(harness, 'neo-card-pr:w-done:s1');
    await harness.service.deliverForward(
      harness.sessionId,
      'w-done:done-check:4',
      'check',
      harness.sessionId,
      'event'
    );
    await harness.service.deliverForward(
      harness.sessionId,
      'neo-ask-evidence:a-done:x',
      'evidence',
      harness.sessionId,
      'event'
    );
    expect(mailboxed(harness, 'w-done:done-check:4')).toBe(1);
    expect(mailboxed(harness, 'neo-ask-evidence:a-done:x')).toBe(1);
    const { generator, turn, sent } = await streamIntoRunningTurn(harness, 'neo-card-pr:w-done:s1');
    sent.onSent();
    expect(await turn).toEqual({ outcome: 'completed' });
    expect(statusOf(harness, 'neo-card-pr:w-done:s1')).toBe('consumed');
    expect(harness.failed).toEqual([]);
    await generator.return?.(undefined);
  });

  it('delivers queued facts older than the last consumed human input', async () => {
    const harness = await makeHarness('neo:stale');
    const facts = ['w1:done-check:1', 'neo-ask-evidence:a1:x'];
    for (const uuid of facts) queueNote(harness, uuid);
    consumeHumanInput(harness, 'h1');
    await harness.service.deliverForward(
      harness.sessionId,
      'w3:stall:1',
      'new fact',
      harness.sessionId,
      'event'
    );
    expect(facts.map((uuid) => statusOf(harness, uuid))).toEqual(['enqueued', 'enqueued']);
    for (const uuid of facts) {
      const { generator, turn, sent } = await streamIntoRunningTurn(harness, uuid);
      sent.onSent();
      expect(await turn).toEqual({ outcome: 'completed' });
      await generator.return?.(undefined);
    }
    expect(facts.map((uuid) => statusOf(harness, uuid))).toEqual(['consumed', 'consumed']);
    expect(harness.failed).toEqual([]);
  });

  it('keeps delivery retry identity without suppressing messages by subject', async () => {
    const harness = await makeHarness('neo:retry');
    for (const id of ['w1:stall:1', 'w1:stall:1', 'w1:stall:2']) {
      await harness.service.deliverForward(
        harness.sessionId,
        id,
        'fact',
        harness.sessionId,
        'event'
      );
    }
    expect(mailboxed(harness, 'w1:stall:1')).toBe(1);
    expect(mailboxed(harness, 'w1:stall:2')).toBe(1);
    expect(harness.failed).toEqual([]);
  });
});
