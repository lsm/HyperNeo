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
import {
  createNeoNoteQueueDeps,
  dispatchNeoNote,
  issueNeoNote,
  neoNoteSubject,
  planNeoNoteQueue,
} from '../../../../src/lib/neo/note-queue';
import { NeoService } from '../../../../src/lib/neo/service';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import type { Database } from '../../../../src/storage/database';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

const note = (uuid: string, seq: number) => ({ uuid, seq });

describe('planNeoNoteQueue', () => {
  it('keeps only the newest queued note for each card or ask', () => {
    expect(
      planNeoNoteQueue(
        {
          queued: [
            note('w1:done-check:1', 1),
            note('neo-ask-evidence:a1:x', 2),
            note('w1:stall:5', 3),
            note('neo-ask-ticked:a1:i1:9', 4),
            note('w2:done-check:1', 5),
          ],
          lastConsumedSeq: null,
        },
        () => false
      )
    ).toEqual([
      { uuid: 'w1:done-check:1', reason: 'superseded' },
      { uuid: 'neo-ask-evidence:a1:x', reason: 'superseded' },
    ]);
  });

  it('drops notes for a settled card or ask', () => {
    expect(
      planNeoNoteQueue(
        {
          queued: [note('neo-card-pr:w9:s', 1), note('neo-ask-evidence:a9:x', 2)],
          lastConsumedSeq: null,
        },
        (subject) => subject.id.endsWith('9')
      )
    ).toEqual([
      { uuid: 'neo-card-pr:w9:s', reason: 'settled' },
      { uuid: 'neo-ask-evidence:a9:x', reason: 'settled' },
    ]);
  });

  it('drops wake notes older than the last consumed input and leaves other inputs alone', () => {
    expect(
      planNeoNoteQueue(
        {
          queued: [
            note('w1:done-check:1', 1),
            note('neo-session-notices:1:k', 2),
            note('neo-consult:c1:request', 3),
            note('w1:return', 4),
            note('w2:done-check:1', 9),
          ],
          lastConsumedSeq: 5,
        },
        () => false
      )
    ).toEqual([
      { uuid: 'w1:done-check:1', reason: 'stale' },
      { uuid: 'neo-session-notices:1:k', reason: 'stale' },
    ]);
  });

  it('drops a turn-limit or restart note once a newer input already continued the work', () => {
    expect(
      planNeoNoteQueue(
        {
          queued: [
            note('neo-turn-limit:r1', 1),
            note('restart-recovery:p1', 2),
            note('neo-turn-limit:r2', 7),
          ],
          lastConsumedSeq: 5,
        },
        () => false
      )
    ).toEqual([
      { uuid: 'neo-turn-limit:r1', reason: 'stale' },
      { uuid: 'restart-recovery:p1', reason: 'stale' },
    ]);
  });
});

describe('neoNoteSubject', () => {
  it('names the card or ask a note is about', () => {
    expect(neoNoteSubject('w1:done-check:3:pr:2')).toEqual({ kind: 'card', id: 'w1' });
    expect(neoNoteSubject('w1:needs-you:5')).toEqual({ kind: 'card', id: 'w1' });
    expect(neoNoteSubject('neo-card-pr:w1:abc')).toEqual({ kind: 'card', id: 'w1' });
    expect(neoNoteSubject('neo-ask-evidence:a1:x')).toEqual({ kind: 'ask', id: 'a1' });
    expect(neoNoteSubject('neo-ask-answer:a1:i1:5')).toBeNull();
    expect(neoNoteSubject('neo-nudge:m1')).toBeNull();
  });
});

type Harness = {
  db: Database;
  service: NeoService;
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
  db.createSession(createTestSession(sessionId));
  new NeoRepository(db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', concernId: null });
  const events = new InternalEventBus<DaemonInternalEventMap>();
  const failed: string[][] = [];
  events.subscribe(
    'messages.statusChanged',
    ({ messageIds, status }) => {
      if (status === 'failed') failed.push(messageIds);
    },
    { subscriberName: 'test-failed-notes' }
  );
  const service = new NeoService(
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

function settledCard(harness: Harness, id: string): void {
  const work = harness.service.repo.proposeWork({
    id,
    requestKey: `k-${id}`,
    concernId: null,
    originSessionId: harness.sessionId,
    title: 'Done card',
    instruction: 'Done.',
  });
  harness.service.repo.transitionWork(id, work, { status: 'cancelled' });
}

function settledAsk(harness: Harness, id: string): void {
  const ask = harness.service.askRecords.open({
    id,
    requestKey: `k-${id}`,
    concernId: null,
    originSessionId: harness.sessionId,
    originMessageId: `m-${id}`,
    title: 'Done ask',
    ask: 'Ship it',
    doneWhen: '- shipped',
    doneSource: 'human',
  })!;
  harness.service.askRecords.settle(ask, 'achieved', 'Shipped.', 'merged');
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
  agentSession.markHolderInputConsumed(head);
  return { generator, turn, sent: yielded.value };
}

describe('Neo note queue', () => {
  it('marks every note folded into a running turn consumed when the turn takes it', async () => {
    const harness = await makeHarness('neo:streamed');
    const fold = ['w1:stall:1', 'w2:stall:2', 'neo-ask-evidence:a1:x'];
    for (const uuid of fold) queueNote(harness, uuid);
    const { generator, turn, sent } = await streamIntoRunningTurn(harness, fold[0]);
    expect(fold.map((uuid) => statusOf(harness, uuid))).toEqual([
      'consumed',
      'consumed',
      'consumed',
    ]);
    sent.onSent();
    expect(await turn).toEqual({ outcome: 'completed' });
    await generator.return?.(undefined);
  });

  it('never discards a note folded into a turn that is taking it', async () => {
    const harness = await makeHarness('neo:in-flight');
    const fold = ['w1:stall:1', 'w2:stall:2', 'neo-ask-evidence:a1:x'];
    for (const uuid of fold) queueNote(harness, uuid);
    const { agentSession, sessionId } = harness;
    agentSession.messageQueue.start();
    const generator = agentSession.messageQueue.messageGenerator(sessionId, {
      suppressPreYieldCallback: true,
    });
    const turn = agentSession.driveDeliveryTurn(fold[0], 'note', null, false, () => true);
    const yielded = await generator.next();
    consumeHumanInput(harness, 'h-mid-turn');
    await harness.service.deliverForward(sessionId, 'w2:stall:9', 'stalled', sessionId, null);
    expect(fold.map((uuid) => statusOf(harness, uuid))).toEqual([
      'enqueued',
      'enqueued',
      'enqueued',
    ]);
    agentSession.markHolderInputConsumed(fold[0]);
    expect(fold.map((uuid) => statusOf(harness, uuid))).toEqual([
      'consumed',
      'consumed',
      'consumed',
    ]);
    yielded.value?.onSent();
    expect(await turn).toEqual({ outcome: 'completed' });
    await generator.return?.(undefined);
  });

  it('lets a newer note for a card or ask supersede the older queued one', async () => {
    const harness = await makeHarness('neo:supersede');
    queueNote(harness, 'w1:done-check:1');
    queueNote(harness, 'neo-ask-evidence:a1:old');
    queueNote(harness, 'w2:done-check:1');
    await harness.service.deliverForward(
      harness.sessionId,
      'w1:stall:7',
      'stalled',
      harness.sessionId,
      null
    );
    await harness.service.deliverForward(
      harness.sessionId,
      'neo-ask-evidence:a1:new',
      'evidence',
      harness.sessionId,
      null
    );
    expect(statusOf(harness, 'w1:done-check:1')).toBe('failed');
    expect(statusOf(harness, 'neo-ask-evidence:a1:old')).toBe('failed');
    expect(statusOf(harness, 'w2:done-check:1')).toBe('enqueued');
    expect(harness.failed.flat()).toHaveLength(2);
    expect(mailboxed(harness, 'w1:stall:7')).toBe(1);
    expect(mailboxed(harness, 'neo-ask-evidence:a1:new')).toBe(1);
  });

  it('never queues or dispatches a note for a settled card or ask', async () => {
    const harness = await makeHarness('neo:settled');
    queueNote(harness, 'neo-card-pr:w-done:s1');
    settledCard(harness, 'w-done');
    settledAsk(harness, 'a-done');
    await harness.service.deliverForward(
      harness.sessionId,
      'w-done:done-check:4',
      'check',
      harness.sessionId,
      null
    );
    await harness.service.deliverForward(
      harness.sessionId,
      'neo-ask-evidence:a-done:x',
      'evidence',
      harness.sessionId,
      null
    );
    expect(mailboxed(harness, 'w-done:done-check:4')).toBe(0);
    expect(mailboxed(harness, 'neo-ask-evidence:a-done:x')).toBe(0);
    expect(
      await harness.agentSession.driveDeliveryTurn(
        'neo-card-pr:w-done:s1',
        'note',
        null,
        false,
        () => true
      )
    ).toEqual({ outcome: 'aborted' });
    expect(statusOf(harness, 'neo-card-pr:w-done:s1')).toBe('failed');
  });

  it('discards queued notes older than the last input the session consumed when a note is issued', async () => {
    const harness = await makeHarness('neo:stale');
    queueNote(harness, 'w1:done-check:1');
    queueNote(harness, 'neo-ask-evidence:a1:x');
    consumeHumanInput(harness, 'h1');
    queueNote(harness, 'w2:done-check:1');
    expect(
      issueNeoNote(createNeoNoteQueueDeps(harness.db), harness.sessionId, 'w3:stall:1')
    ).toEqual({ issue: true });
    expect(statusOf(harness, 'w1:done-check:1')).toBe('failed');
    expect(statusOf(harness, 'neo-ask-evidence:a1:x')).toBe('failed');
    expect(statusOf(harness, 'w2:done-check:1')).toBe('enqueued');
    expect(
      dispatchNeoNote(createNeoNoteQueueDeps(harness.db), harness.sessionId, 'w2:done-check:1')
    ).toEqual({ dispatch: true });
  });

  it('reproduces the fe8c48f2 incident: 34 notes streamed into running turns never wake Neo again', async () => {
    const harness = await makeHarness('neo:fe8c48f2-5581-43d0-ad3a-f60fa7de17c4');
    settledCard(harness, 'w-done');
    settledAsk(harness, 'a-done');
    const cards = ['w1', 'w2', 'w3'];
    const asks = ['a1', 'a2'];
    const streamed = ['w1:stall:1', 'w2:stall:1', 'neo-ask-evidence:a1:s0'];
    for (const uuid of streamed) queueNote(harness, uuid);
    const { generator, turn, sent } = await streamIntoRunningTurn(harness, streamed[0]);

    const notes: string[] = [];
    for (let index = 0; notes.length < 31; index++) {
      notes.push(`${cards[index % cards.length]}:done-check:${index}:pr:${index}`);
      notes.push(`neo-ask-evidence:${asks[index % asks.length]}:s${index + 1}`);
      if (index % 5 === 0) notes.push(`neo-card-pr:w-done:s${index}`);
      if (index % 7 === 0) notes.push(`neo-ask-evidence:a-done:s${index}`);
    }
    notes.length = 31;
    for (const uuid of notes) queueNote(harness, uuid);
    consumeHumanInput(harness, 'human-newer');
    const all = [...streamed, ...notes];
    expect(all).toHaveLength(34);

    await harness.service.deliverForward(
      harness.sessionId,
      'w1:done-check:99:pr:99',
      'check',
      harness.sessionId,
      null
    );
    await harness.service.deliverForward(
      harness.sessionId,
      'w-done:done-check:99',
      'check',
      harness.sessionId,
      null
    );

    for (const uuid of streamed) expect(statusOf(harness, uuid)).toBe('consumed');
    const repo = harness.db.getSDKMessageRepo();
    const humanSeq = repo.lastConsumedInputSeq(harness.sessionId)!;
    const queued = repo.listQueuedSystemInputs(harness.sessionId);
    expect(queued.filter((row) => row.seq < humanSeq)).toEqual([]);
    expect(all.filter((uuid) => statusOf(harness, uuid) === 'enqueued')).toEqual([]);
    const subjects = queued.map((row) => JSON.stringify(neoNoteSubject(row.uuid)));
    expect(new Set(subjects).size).toBe(subjects.length);
    expect(mailboxed(harness, 'w-done:done-check:99')).toBe(0);
    expect(mailboxed(harness, 'w1:done-check:99:pr:99')).toBe(1);

    for (const uuid of notes)
      expect(
        await harness.agentSession.driveDeliveryTurn(uuid, `note ${uuid}`, null, false, () => true)
      ).toEqual({ outcome: 'aborted' });

    sent.onSent();
    expect(await turn).toEqual({ outcome: 'completed' });
    await generator.return?.(undefined);
  });
});
