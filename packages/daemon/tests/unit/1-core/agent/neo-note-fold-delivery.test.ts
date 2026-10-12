import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageContent, Provider } from '@hyperneo/shared';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { deliverMessage } from '../../../../src/lib/agent/message-delivery';
import { NEO_NOTE_FOLD_SEPARATOR } from '../../../../src/lib/agent/neo-note-fold';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import { setModelsCache } from '../../../../src/lib/model-service';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

type BoundarySession = {
  db: Database;
  agentSession: AgentSession;
};

async function makeBoundarySession(
  sessionId: string,
  opts?: { provider?: Provider }
): Promise<BoundarySession> {
  const db = await createTestDb();
  const session = createTestSession(sessionId);
  if (opts?.provider) {
    session.config.provider = opts.provider;
  }
  db.createSession(session);
  const bus = await createTestInternalEventBus();
  const agentSession = new AgentSession(
    db.getSession(sessionId) ?? session,
    db,
    new MessageHub(),
    bus,
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  );
  return { db, agentSession };
}

function stubLifecycleManager(agentSession: AgentSession, result: 'started' | 'blocked') {
  const ensureQueryStarted = mock(async () => result);
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted,
    executeDeferredRestartIfPending: mock(async () => {}),
  };
  return ensureQueryStarted;
}

function armNeverResolvingQuery(agentSession: AgentSession): void {
  agentSession.queryPromise = new Promise<void>(() => {});
}

function saveUserMessage(
  repo: SDKMessageRepository,
  sessionId: string,
  uuid: string,
  status: 'enqueued' | 'consumed' = 'enqueued',
  content: string | MessageContent[] = 'hello',
  inputKind = 'system'
): void {
  repo.saveUserMessage(
    sessionId,
    {
      type: 'user',
      uuid,
      inputKind,
      message: { role: 'user', content },
    } as unknown as SDKMessage,
    status
  );
}

describe('AgentSession driveDeliveryTurn for Neo system notes', () => {
  async function drive(sessionId: string, neo: boolean, notes: Array<[string, string]>) {
    const { db, agentSession } = await makeBoundarySession(sessionId);
    const repo = db.getSDKMessageRepo();
    if (neo)
      new NeoRepository(db.getDatabase()).reserveBinding({
        sessionId,
        kind: 'neo',
        concernId: null,
      });
    for (const [uuid, kind] of notes)
      saveUserMessage(repo, sessionId, uuid, 'enqueued', `note ${uuid}`, kind);
    for (const [uuid] of notes.slice(1))
      deliverMessage(db.getJobQueueRepo(), sessionId, uuid, { origin: 'recovery' });
    stubLifecycleManager(agentSession, 'started');
    armNeverResolvingQuery(agentSession);
    agentSession.messageQueue.start();
    const generator = agentSession.messageQueue.messageGenerator(sessionId);
    const turn = agentSession.driveDeliveryTurn(
      notes[0][0],
      `note ${notes[0][0]}`,
      null,
      false,
      () => true
    );
    const yielded = await generator.next();
    if (!yielded.value) throw new Error('message not yielded');
    yielded.value.onSent();
    const outcome = await turn;
    const status = (uuid: string) => repo.getDeliveryContent(sessionId, uuid)?.sendStatus;
    const blocks = yielded.value.message.message?.content as Array<{ text?: string }>;
    const content = blocks.map((block) => block.text).join('');
    const statuses = notes.map(([uuid]) => status(uuid));
    await generator.return?.(undefined);
    agentSession.messageQueue.stop();
    db.close();
    return { outcome, content, statuses };
  }

  it('folds the queued notes into one turn and marks them all consumed', async () => {
    const result = await drive('neo:fold-root', true, [
      ['w1:stall:1', 'system'],
      ['w2:stall:2', 'system'],
      ['neo-ask-evidence:a1:x', 'system'],
    ]);
    expect(result.outcome).toEqual({ outcome: 'completed' });
    expect(result.content).toBe(
      ['note w1:stall:1', 'note w2:stall:2', 'note neo-ask-evidence:a1:x'].join(
        NEO_NOTE_FOLD_SEPARATOR
      )
    );
    expect(result.statuses).toEqual(['consumed', 'consumed', 'consumed']);
  });

  it('gives a nudge or consultation its own turn', async () => {
    const result = await drive('neo:fold-nudge', true, [
      ['w1:stall:1', 'system'],
      ['neo-nudge:m1', 'system'],
      ['neo-consult:c1:request', 'system'],
    ]);
    expect(result.content).toBe('note w1:stall:1');
    expect(result.statuses).toEqual(['consumed', 'enqueued', 'enqueued']);
  });

  it('leaves a queued human message and non-Neo sessions alone', async () => {
    const neo = await drive('neo:fold-human', true, [
      ['w1:stall:1', 'system'],
      ['h1', 'human'],
    ]);
    expect(neo.content).toBe('note w1:stall:1');
    expect(neo.statuses).toEqual(['consumed', 'enqueued']);
    const plain = await drive('plain-session', false, [
      ['w1:stall:1', 'system'],
      ['w2:stall:2', 'system'],
    ]);
    expect(plain.content).toBe('note w1:stall:1');
    expect(plain.statuses).toEqual(['consumed', 'enqueued']);
  });
});
