import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  neoStartDecision,
  neoQuestionStartTargets,
} from '../../../../src/lib/neo/start-question.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const root = 'neo:10000000-0000-4000-8000-000000000001';
const target = {
  verb: 'start' as const,
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/tmp', name: 'test' },
};
const human = { source: 'rpc' as const, principal: 'local' };

describe('grouped card start question', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let starts: string[];
  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession(root));
    starts = [];
    const registry = createOperationRegistry(
      ['work.start', 'work.stop'].map((name) =>
        defineOperation({
          name,
          description: name,
          inputSchema: z.record(z.string(), z.unknown()),
          resultSchema: z.unknown(),
          execute: async (input) => {
            if (name === 'work.stop') return { ok: true, value: { stopped: true } };
            starts.push(String(input.title));
            return {
              ok: true,
              value: {
                ref: { adapter: 'codex-desktop', id: `thread-${starts.length}` },
                title: input.title,
                place: target.place,
                status: 'running',
                lastActivityAt: Date.now(),
              },
            };
          },
        })
      )
    );
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    service.askRecords.open(
      {
        id: 'ask',
        requestKey: 'ask',
        projectId: null,
        originSessionId: root,
        originMessageId: 'human',
        title: 'Plan',
        ask: 'Do these steps',
        doneWhen: 'Outcome',
        doneSource: 'human',
      },
      [{ text: 'Outcome', check: null }]
    );
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });
  const current = () => service.askRecords.get('ask')!;
  const questions = () =>
    current().doneItems!.filter((item) => !item.removed && item.state === 'needs_you');
  const invoke = (name: string, input: unknown) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);
  const propose = (id: string, chosen = target) => {
    service.driverTargets.propose(
      service.repo,
      {
        id,
        requestKey: id,
        projectId: null,
        originSessionId: root,
        originMessageId: 'human',
        title: `Card ${id}`,
        instruction: 'Do it.',
      },
      chosen
    );
    service.askRecords.link('ask', id);
    service.proposeStartQuestion(id);
  };
  const answer = (choice: string, revision = current().revision) =>
    invoke('neo.ask.answer', {
      askId: 'ask',
      itemId: questions()[0].id,
      choice,
      expectedRevision: revision,
    });

  test('three proposals become one decline-first question and approval starts exactly those cards once', async () => {
    for (const id of ['one', 'two', 'three']) propose(id);
    expect(questions()).toHaveLength(1);
    expect(questions()[0]).toMatchObject({
      question: '开始这 3 步？',
      options: ['先不做', '开始'],
      kind: 'approval',
    });
    expect(neoQuestionStartTargets(questions()[0]).map((entry) => entry.workId)).toEqual(
      expect.arrayContaining(['one', 'two', 'three'])
    );
    expect(starts).toEqual([]);
    const question = questions()[0];
    const revision = current().revision;
    expect(await answer('开始')).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(starts).toHaveLength(3);
    expect(starts).toEqual(expect.arrayContaining(['Card one', 'Card two', 'Card three']));
    expect(current().doneItems!.find((item) => item.id === question.id)).toMatchObject({
      state: 'met',
      metBy: 'human',
    });
    expect(
      await invoke('neo.ask.answer', {
        askId: 'ask',
        itemId: question.id,
        choice: '开始',
        expectedRevision: revision,
      })
    ).toMatchObject({ kind: 'completed', value: { ok: false } });
    expect(starts).toHaveLength(3);
    expect(current().doneItems![0].state).toBe('pending');
  });

  test('decline completes the question and cancels just its proposed cards', async () => {
    propose('one');
    propose('two');
    expect(await answer('先不做')).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(starts).toEqual([]);
    expect(['one', 'two'].map((id) => service.repo.getWork(id)?.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(questions()).toEqual([]);
  });

  test('an added card changes question identity and revision; a stale answer cannot approve it', async () => {
    propose('one');
    const old = questions()[0];
    const revision = current().revision;
    propose('two');
    expect(questions()[0].id).not.toBe(old.id);
    expect(
      await invoke('neo.ask.answer', {
        askId: 'ask',
        itemId: old.id,
        choice: '开始',
        expectedRevision: revision,
      })
    ).toMatchObject({ kind: 'completed', value: { ok: false } });
    expect(starts).toEqual([]);
    expect(service.proposalApproval('two')).toBe(false);
  });

  test('a replacement with a different target never inherits an earlier approval', async () => {
    propose('one');
    await answer('开始');
    const replacement = { ...target, adapter: 'hyperneo' };
    propose('replacement', replacement);
    expect(service.proposalApproval('replacement')).toBe(false);
    expect(questions()).toHaveLength(1);
    expect(questions()[0].question).toBe('开始这 1 步？');
    expect(await service.admitWork('replacement', true)).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(starts).toHaveLength(1);
    expect(
      neoStartDecision(current(), { workId: 'one', target: JSON.stringify(replacement) })
    ).toBe('pending');
  });

  test('ticking a question cannot erase the target binding or turn ask-wide approval into card consent', async () => {
    propose('one');
    const question = questions()[0];
    expect(
      await invoke('neo.ask.tick', {
        askId: 'ask',
        itemId: question.id,
        state: 'pending',
        expectedRevision: current().revision,
      })
    ).toMatchObject({ value: { ok: true } });
    expect(current().doneItems!.find((item) => item.id === question.id)?.action).toBe(
      question.action
    );
    service.askRecords.approve('ask', Date.now(), current().revision!);
    expect(await service.admitWork('one', true)).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(starts).toEqual([]);
  });

  test('same request replay does not add a second question or change the revision', () => {
    propose('one');
    const before = current();
    service.proposeStartQuestion('one');
    expect(current()).toEqual(before);
    expect(questions()).toHaveLength(1);
  });

  test('an in-place target change invalidates the old target grant', async () => {
    propose('one');
    const question = questions()[0];
    service.askRecords.tickItem(
      'ask',
      { ...question, state: 'met', evidence: 'The human answered: 开始', metBy: 'human' },
      Date.now(),
      question,
      true
    );
    expect(service.proposalApproval('one')).toBe(true);
    db.getDatabase()
      .prepare('UPDATE neo_work_driver_targets SET target = ? WHERE work_id = ?')
      .run(JSON.stringify({ ...target, adapter: 'hyperneo' }), 'one');
    expect(service.proposalApproval('one')).toBe(false);
    service.proposeStartQuestion('one');
    expect(questions()).toHaveLength(1);
    expect(await service.admitWork('one', true)).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(starts).toEqual([]);
  });

  test('a withdrawn target set can become the current question again without accepting an old answer', async () => {
    propose('one');
    const original = questions()[0];
    const revision = current().revision;
    propose('two');
    service.repo.transitionWork('two', service.repo.getWork('two')!, { status: 'cancelled' });
    service.proposeStartQuestion('one');
    expect(questions()).toHaveLength(1);
    expect(questions()[0].id).toBe(original.id);
    expect(await answer('开始', revision)).toMatchObject({ value: { ok: false } });
    expect(starts).toEqual([]);
    expect(await answer('开始')).toMatchObject({ value: { ok: true } });
    expect(starts).toEqual(['Card one']);
  });

  test('withdrawing an answered question never revives its earlier approval', async () => {
    propose('one');
    const question = questions()[0];
    service.askRecords.tickItem(
      'ask',
      { ...question, state: 'met', evidence: 'The human answered: 开始', metBy: 'human' },
      Date.now(),
      question,
      true
    );
    expect(service.proposalApproval('one')).toBe(true);
    service.askRecords.editItems('ask', { add: [], remove: [question.id] }, Date.now());
    expect(service.proposalApproval('one')).toBe(false);
    service.proposeStartQuestion('one');
    expect(questions()).toHaveLength(1);
    expect(await service.admitWork('one', true)).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(starts).toEqual([]);
  });

  test('the real proposal operation creates a question before any start', async () => {
    expect(
      await invoke('neo.work.propose', {
        askId: 'ask',
        title: 'First step',
        instruction: 'Do it',
        work: target,
        delivers: [],
      })
    ).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(questions()).toHaveLength(1);
    expect(starts).toEqual([]);
  });
});
