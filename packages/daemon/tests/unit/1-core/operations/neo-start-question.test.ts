import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { NeoAskSchema } from '../../../../src/lib/neo/ask-inputs.ts';
import {
  readNeoAskAnswerAt,
  readNeoAskAnswerChoice,
  readNeoAskAnswerOption,
} from '../../../../src/lib/neo/ask-answer-evidence.ts';
import { deriveNeoAskHumanActions } from '../../../../src/lib/neo/ask-views.ts';
import { NeoAskViewSchema } from '../../../../src/lib/neo/card-view-schema.ts';
import { projectNeoAskViews } from '../../../../src/lib/neo/ask-views.ts';
import { planNeoStartQuestion } from '../../../../src/lib/neo/start-question.ts';
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
    vi.restoreAllMocks();
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
      question: '开始这 3 件？',
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

  test('projects exact step identities and titles through the snapshot schema', () => {
    let proposalAt = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => proposalAt++);
    for (const id of ['one', 'two', 'three']) propose(id);
    const [view] = projectNeoAskViews([current()], [], []);
    expect(NeoAskViewSchema.parse(view).humanActions).toEqual([
      {
        kind: 'question',
        itemId: questions()[0].id,
        question: '开始这 3 件？',
        options: ['先不做', '开始'],
        steps: expect.arrayContaining([
          { id: 'one', title: 'Card one' },
          { id: 'two', title: 'Card two' },
          { id: 'three', title: 'Card three' },
        ]),
      },
    ]);
  });

  test('single-step questions name their step and old questions recover recorded titles', () => {
    propose('one');
    const question = questions()[0];
    expect(deriveNeoAskHumanActions(current())[0]).toMatchObject({
      question: '开始「Card one」？',
      steps: [{ id: 'one', title: 'Card one' }],
    });
    const old = {
      ...question,
      action: 'neo-start:' + JSON.stringify([{ workId: 'one', target: JSON.stringify(target) }]),
      question: '开始这 1 步？',
    };
    expect(deriveNeoAskHumanActions({ ...current(), doneItems: [old] })[0]).toMatchObject({
      question: '开始「Card one」？',
      steps: [{ id: 'one', title: 'Card one' }],
    });
  });

  test('title-only changes preserve question identity and exact-target consent', async () => {
    propose('one');
    const original = questions()[0];
    const renamed = { workId: 'one', target: JSON.stringify(target), title: '改一个更清楚的标题' };
    expect(planNeoStartQuestion(current(), [renamed])?.id).toBe(original.id);
    await answer('开始');
    expect(neoStartDecision(current(), renamed)).toBe('approved');
    expect(planNeoStartQuestion(current(), [renamed])).toBeNull();
    expect(neoStartDecision(current(), { ...renamed, target: 'a different target' })).toBe(
      'pending'
    );
  });

  test('records the human choice and answer time without changing it on a replay', async () => {
    propose('one');
    const original = questions()[0];
    expect(original.answer).toBeUndefined();
    db.getDatabase()
      .prepare('UPDATE neo_ask_items SET added_at = 1000, updated_at = 1000 WHERE id = ?')
      .run(original.id);
    const before = Date.now();
    await answer('开始');
    const receipt = current().doneItems!.find((item) => item.id === original.id)!.answer!;
    expect(receipt.choice).toBe('开始');
    expect(receipt.at).toBeGreaterThanOrEqual(before);
    expect(receipt.at).toBeLessThanOrEqual(Date.now());
    expect(
      NeoAskSchema.parse(current()).doneItems!.find((item) => item.id === original.id)!.answer
    ).toEqual(receipt);
    db.getDatabase()
      .prepare('UPDATE neo_ask_items SET updated_at = ? WHERE id = ?')
      .run(Date.now() + 60_000, original.id);
    expect(current().doneItems!.find((item) => item.id === original.id)!.answer).toEqual(receipt);
    await invoke('neo.ask.answer', {
      askId: 'ask',
      itemId: original.id,
      choice: '先不做',
      expectedRevision: current().revision,
    });
    expect(current().doneItems!.find((item) => item.id === original.id)!.answer).toEqual(receipt);
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

  test.each([
    ['可以', '开始', 1, 'queued'],
    ['以后再说', '先不做', 0, 'cancelled'],
  ])(
    'records chat words %s with their option %s without another confirmation',
    async (choice, option, count, status) => {
      propose('one');
      const question = questions()[0];
      db.getSDKMessageRepo().saveSDKMessage(root, {
        type: 'user',
        uuid: 'reply',
        session_id: root,
        parent_tool_use_id: null,
        inputKind: 'human',
        message: { role: 'user', content: choice },
      } as unknown as SDKUserMessage);
      db.getDatabase()
        .prepare('UPDATE neo_ask_items SET added_at = 0 WHERE ask_id = ? AND id = ?')
        .run('ask', question.id);
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.ask.answer',
          {
            askId: 'ask',
            itemId: question.id,
            choice: option,
            option,
            expectedRevision: current().revision,
          },
          {
            source: 'mcp',
            principal: 'agent',
            role: 'neo',
            sessionId: root,
            neoTurn: {
              messageId: 'reply',
              human: true,
              isLive: () => true,
            },
          }
        )
      ).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('answer_not_in_message') },
      });
      expect(starts).toEqual([]);
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.ask.answer',
          {
            askId: 'ask',
            itemId: question.id,
            choice,
            option,
            expectedRevision: current().revision,
          },
          {
            source: 'mcp',
            principal: 'agent',
            role: 'neo',
            sessionId: root,
            neoTurn: {
              messageId: 'reply',
              human: true,
              isLive: () => true,
            },
          }
        )
      ).toMatchObject({ value: { ok: true } });
      expect(starts).toHaveLength(count);
      expect(service.repo.getWork('one')?.status).toBe(status);
      const answered = current().doneItems!.find((item) => item.id === question.id)!;
      expect(answered).toMatchObject({ state: 'met', metBy: 'human' });
      expect(readNeoAskAnswerChoice(answered.evidence)).toBe(choice);
      expect(questions()).toEqual([]);
    }
  );

  test('unmatched consent reopens its exact question and can be answered without a new proposal', async () => {
    propose('one');
    const original = questions()[0];
    const revision = current().revision;
    expect(await answer('可以')).toMatchObject({ value: { ok: true } });
    const entry = { workId: 'one', target: JSON.stringify(target), title: 'Card one' };
    expect(neoStartDecision(current(), entry)).toBe('pending');
    expect(planNeoStartQuestion(current(), [entry])).not.toBeNull();
    expect(service.repo.getWork('one')?.status).toBe('proposed');
    service.proposeStartQuestion('one');
    expect(questions()).toHaveLength(1);
    expect(questions()[0].id).toBe(original.id);
    expect(neoQuestionStartTargets(questions()[0])).toEqual([entry]);
    expect(current().revision).toBeGreaterThan(revision!);
    const reopened = current();
    service.proposeStartQuestion('one');
    expect(current()).toEqual(reopened);
    expect(await answer('开始', revision)).toMatchObject({ value: { ok: false } });
    expect(await service.admitWork('one', true)).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(starts).toEqual([]);
    expect(await answer('开始')).toMatchObject({ value: { ok: true } });
    expect(starts).toEqual(['Card one']);
  });

  test('normalized option labels drive both immediate starts and recorded consent', async () => {
    propose('one');
    const question = questions()[0];
    service.askRecords.restateQuestion(
      'ask',
      {
        ...question,
        question: question.question!,
        kind: 'approval',
        options: ['Not yet', 'Start'],
        decides: question.decides!,
      },
      Date.now()
    );
    expect(await answer('ＳＴＡＲＴ')).toMatchObject({ value: { ok: true } });
    expect(starts).toEqual(['Card one']);
    expect(service.proposalApproval('one')).toBe(true);
  });

  test('an option outside the question cannot grant consent', async () => {
    propose('one');
    expect(
      await invoke('neo.ask.answer', {
        askId: 'ask',
        itemId: questions()[0].id,
        choice: '可以',
        option: 'Do something else',
        expectedRevision: current().revision,
      })
    ).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('answer_option_unknown') },
    });
    expect(questions()).toHaveLength(1);
    expect(starts).toEqual([]);
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
    expect(questions()[0].question).toBe('开始「Card replacement」？');
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

  test.each(['先不做', '开始'])(
    'a proposal without askId receives its own %s decision',
    async (choice) => {
      const result = await invoke('neo.work.propose', {
        title: 'Loose proposal',
        instruction: 'Do this step',
        goal: 'Original goal',
        doneWhen: 'Original outcome',
        work: target,
      });
      expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
      const work = service.repo.listWork().find((entry) => entry.title === 'Loose proposal')!;
      const ask = service.askRecords.forWork(work.id)!;
      expect(ask).toMatchObject({
        ask: 'Original goal',
        doneWhen: 'Original outcome',
        doneSource: 'proposal',
        workIds: [work.id],
      });
      const question = ask.doneItems!.find((item) => item.state === 'needs_you')!;
      expect(question).toMatchObject({
        question: '开始「Loose proposal」？',
        options: ['先不做', '开始'],
      });
      await service.start(work.id);
      expect(starts).toEqual([]);
      expect(
        await invoke('neo.ask.answer', {
          askId: ask.id,
          itemId: question.id,
          choice,
          expectedRevision: ask.revision,
        })
      ).toMatchObject({ value: { ok: true } });
      expect(service.repo.getWork(work.id)?.status).toBe(
        choice === '开始' ? 'queued' : 'cancelled'
      );
      expect(starts).toEqual(choice === '开始' ? ['Loose proposal'] : []);
    }
  );

  test('recovery creates one durable question for a legacy loose proposal', async () => {
    service.driverTargets.propose(
      service.repo,
      {
        id: 'legacy-loose',
        requestKey: 'legacy-loose',
        projectId: null,
        originSessionId: root,
        originMessageId: 'human',
        title: 'Legacy proposal',
        instruction: 'Original instruction',
      },
      target
    );
    expect(service.askRecords.forWork('legacy-loose')).toBeNull();
    await service.recover();
    const ask = service.askRecords.forWork('legacy-loose')!;
    const question = ask.doneItems!.find((item) => item.state === 'needs_you')!;
    expect(question).toMatchObject({
      question: '开始「Legacy proposal」？',
      options: ['先不做', '开始'],
    });
    await service.start('legacy-loose');
    expect(starts).toEqual([]);
    await service.recover();
    expect(service.askRecords.forWork('legacy-loose')).toEqual(ask);
    expect(
      await invoke('neo.ask.answer', {
        askId: ask.id,
        itemId: question.id,
        choice: '开始',
        expectedRevision: ask.revision,
      })
    ).toMatchObject({ value: { ok: true } });
    expect(starts).toEqual(['Legacy proposal']);
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

describe('readNeoAskAnswerChoice', () => {
  test('retains legacy choices without inventing an answer time', () => {
    for (const evidence of [
      'The human answered: 开始',
      'The human answered with option: {"choice":"可以","option":"开始"}',
    ]) {
      expect(readNeoAskAnswerChoice(evidence)).toBeTruthy();
      expect(readNeoAskAnswerAt(evidence)).toBeNull();
    }
  });
  test.each(['{bad', 'null', '{"choice":1,"option":"开始"}', '{"choice":"开始"}'])(
    'keeps malformed historical option evidence unknown: %s',
    (body) => {
      const evidence = `The human answered with option: ${body}`;
      expect(readNeoAskAnswerChoice(evidence)).toBeNull();
      expect(readNeoAskAnswerOption(evidence)).toBeNull();
      expect(readNeoAskAnswerAt(evidence)).toBeNull();
    }
  );
});
