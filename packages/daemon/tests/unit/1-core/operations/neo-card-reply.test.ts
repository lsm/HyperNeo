import { pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import type { MessageHub } from '@hyperneo/shared';
import { readNeoPublications } from '../../../../../web/src/neo/publication-client.ts';
import { describe, expect, test, spyOn } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const conversationId = 'e18b6e82-9847-4b12-b61b-921377e8e61d';
const human1 = 'd69afc04-c504-4f78-b093-dc4b90372b45';
const human2 = 'ea5ba7fc-2f15-48ac-8f75-fcf91244c33d';
const owner: OperationCaller = { source: 'mcp', sessionId: `neo:${conversationId}`, role: 'neo' };
function setup() {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: owner.sessionId!,
    originMessageId: human1,
    projectId: null,
    title: '#8442 sign-off',
    request: 'Synthetic',
    createdAt: 1,
  });
  const publications = new NeoPublicationRepository(db);
  const ops = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true }),
    (_caller, id) => [human1, human2].includes(id),
    undefined,
    undefined,
    (caller, ids) => {
      const sourceMessageIds = ids ?? (caller.consumedInputId ? [caller.consumedInputId] : []);
      return sourceMessageIds.length
        ? { conversationId, sourceMessageIds, language: 'zh-Hans' }
        : null;
    }
  );
  const op = ops.find((op) => op.name === 'neo.question.ask')!;
  const ask = async (input: Record<string, unknown>, caller = owner) =>
    (await op.execute(
      op.inputSchema.parse({
        retireWhen: pendingTodoCheck,
        askId: 'ask',
        kind: 'choice',
        options: ['Keep', 'Change'],
        text: 'How should we sign off?',
        ...input,
      }),
      caller
    )) as { ok: boolean; question: NeoQuestion };
  return { db, store, publications, ask, rows: () => publications.list(conversationId)! };
}

describe('card reply notices', () => {
  test('#8442 choice response creates one typed notice without options or answered association', async () => {
    const f = setup();
    try {
      const result = await f.ask({ replyTo: [human1] });
      expect(result.ok).toBe(true);
      const [row] = f.rows();
      expect(f.rows()).toHaveLength(1);
      expect(row.cardReply).toEqual({
        sourceMessageIds: [human1],
        askId: 'ask',
        questionId: result.question.id,
        mutationId: result.question.id,
      });
      expect(row.shortText).toContain('我给你回了 · 查看卡片');
      expect(row.fullText).not.toContain('Keep');
      expect(row.replyTo).toBeUndefined();
      expect(result.question.state).toBe('open');
      const retry = await f.ask({ replyTo: [human1] });
      expect(retry.question.id).toBe(result.question.id);
      expect(f.rows()).toHaveLength(1);
      expect(new NeoPublicationRepository(f.db).list(conversationId)).toEqual(f.rows());
    } finally {
      f.db.close();
    }
  });
  test('replacements coalesce, old retries do not rewind, later human replies get a row', async () => {
    const f = setup();
    try {
      const first = await f.ask({ replyTo: [human1] });
      const replacementInput = {
        replyTo: [human1],
        replaces: first.question.id,
        text: 'Revised sign-off',
      };
      const second = await f.ask(replacementInput);
      expect(second.ok).toBe(true);
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0].cardReply?.questionId).toBe(second.question.id);
      expect(f.rows()[0].sequence).toBe(1);
      expect((await f.ask(replacementInput)).question.id).toBe(second.question.id);
      await f.ask({ replyTo: [human1] });
      expect(f.rows()[0].cardReply?.questionId).toBe(second.question.id);
      await f.ask({ replyTo: [human2], text: 'A later human reply' });
      expect(f.rows()).toHaveLength(2);
      const { sequence: _sequence, createdAt: _createdAt, ...row } = f.rows()[0];
      const manual = f.publications.append({
        ...row,
        publicationId: crypto.randomUUID(),
        shortText: 'Manual same association',
        fullText: 'Manual same association',
        replyTo: [human1],
      });
      expect(manual.accepted).toBe(true);
      expect(f.rows()).toHaveLength(2);
      expect(f.rows()[0].shortText).toBe('Manual same association');
      expect(f.rows()[0].replyTo).toBeUndefined();
    } finally {
      f.db.close();
    }
  });
  test('recorded consumed input works without replyTo, background and rejected writes do not notify', async () => {
    const f = setup();
    try {
      await f.ask({ text: 'Unrelated background question' });
      expect(f.rows()).toHaveLength(0);
      await f.ask({ replyTo: [crypto.randomUUID()] });
      expect(f.rows()).toHaveLength(0);
      await f.ask({}, { ...owner, consumedInputId: human1 });
      expect(f.rows()).toHaveLength(1);
      const question = f.store.getQuestion(f.rows()[0].cardReply!.questionId)!;
      f.store.answerQuestion(question, ['Keep'], 'button', 4);
      expect(f.rows()).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  test('in-place start rewording coalesces and a stale retry cannot undo the current card', async () => {
    const f = setup();
    try {
      f.store.askQuestion(
        'start',
        'ask',
        {
          text: 'Start?',
          kind: 'start',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: ['todo'],
        },
        1
      );
      const first = { kind: 'start', text: 'Start the reviewed work?', replyTo: [human1] };
      const second = { ...first, text: 'Start the revised work?' };
      expect((await f.ask(first)).ok).toBe(true);
      expect((await f.ask(second)).ok).toBe(true);
      expect(f.rows()).toHaveLength(1);
      await f.ask(first);
      expect(f.store.getQuestion('start')?.text).toBe(second.text);
      expect(f.rows()[0].cardReply?.questionId).toBe('start');
    } finally {
      f.db.close();
    }
  });

  test('overlapping reconnect retries reserve one mutation and one replacement', async () => {
    const f = setup();
    try {
      const requests = { replyTo: [human1] };
      const [a, b] = await Promise.all([f.ask(requests), f.ask(requests)]);
      expect(a.ok && b.ok).toBe(true);
      expect(a.question.id).toBe(b.question.id);
      const replacement = { ...requests, replaces: a.question.id, text: 'Concurrent revision' };
      const [c, d] = await Promise.all([f.ask(replacement), f.ask(replacement)]);
      expect(c.ok && d.ok).toBe(true);
      expect(c.question.id).toBe(d.question.id);
      expect(f.rows()).toHaveLength(1);
      expect(f.store.listQuestions('ask')).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });

  test.each(['replacement', 'rewording', 'manual'] as const)(
    'an edited notice survives %s without losing history or edit retry identity',
    async (mode) => {
      const f = setup();
      try {
        if (mode === 'rewording')
          f.store.askQuestion(
            'start',
            'ask',
            {
              text: 'Start?',
              kind: 'start',
              options: null,
              multiple: false,
              noLabel: null,
              yesLabel: null,
              startTodos: ['todo'],
            },
            1
          );
        const initial = await f.ask({
          replyTo: [human1],
          ...(mode === 'rewording' ? { kind: 'start' } : {}),
        });
        const before = f.rows()[0];
        const revisionId = crypto.randomUUID();
        const origin = { sessionId: owner.sessionId!, messageId: human1 };
        const text = { shortText: 'An edited reply', fullText: 'An edited reply in detail' };
        expect(
          f.publications.edit(
            conversationId,
            before.publicationId,
            text,
            '2026-10-24T16:00:00.000Z',
            'neo',
            origin,
            revisionId
          ).accepted
        ).toBe(true);
        f.db.exec(
          "UPDATE neo_publications SET payload_json = json_set(payload_json, '$.awaiting', 'Human choice')"
        );
        if (mode === 'manual') {
          expect(
            f.publications.append({
              conversationId,
              publicationId: crypto.randomUUID(),
              shortText: 'Manual revision',
              fullText: 'Manual revision',
              links: [],
              cardReply: before.cardReply,
            }).accepted
          ).toBe(true);
        } else {
          expect(
            (
              await f.ask({
                replyTo: [human1],
                text: 'Revised question',
                ...(mode === 'rewording' ? { kind: 'start' } : { replaces: initial.question.id }),
              })
            ).ok
          ).toBe(true);
        }
        const current = f.rows()[0];
        expect(current).toMatchObject({
          publicationId: before.publicationId,
          sequence: before.sequence,
          editedAt: '2026-10-24T16:00:00.000Z',
          editedBy: 'neo',
          awaiting: 'Human choice',
          answerInput: origin,
          answerOrigin: origin,
        });
        const page = await readNeoPublications(
          { conversationId, after: 0 },
          async () =>
            ({
              request: async () => ({
                ok: true,
                conversationId,
                items: f.rows(),
                nextAfter: current.sequence,
              }),
            }) as unknown as MessageHub,
          () => true
        );
        expect(page.state).toBe('ready');
        expect(
          f.publications.edit(
            conversationId,
            before.publicationId,
            text,
            '2026-10-24T16:01:00.000Z',
            'neo',
            origin,
            revisionId
          )
        ).toMatchObject({ accepted: true, created: false });
        expect(f.rows()).toEqual([current]);
        const ids = [
          current.revisionId ?? current.publicationId,
          ...(current.revisions?.map((item) => item.revisionId) ?? []),
        ];
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        f.db.close();
      }
    }
  );

  test.each([
    ['system', 'zh-CN', '我给你回了 · 查看卡片'],
    ['system', 'en-US', 'I replied · View card'],
    ['en', 'zh-CN', 'I replied · View card'],
    ['zh-Hans', 'en-US', '我给你回了 · 查看卡片'],
    [undefined, 'zh-CN', '我给你回了 · 查看卡片'],
    [undefined, 'en-US', 'I replied · View card'],
  ] as const)('notice language %s on host %s', (language, host, expected) => {
    const f = setup();
    const options = Intl.DateTimeFormat().resolvedOptions();
    const locale = spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      locale: host,
    });
    try {
      const id = crypto.randomUUID();
      f.store.writeCardReply({ conversationId, sourceMessageIds: [human1], language }, id, () =>
        f.store.askQuestion(
          id,
          'ask',
          {
            text: 'Choose a path',
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
          },
          1
        )
      );
      expect(f.rows()[0].shortText).toBe(`${expected} · Choose a path`);
      expect(f.rows()[0].fullText).toBe(f.rows()[0].shortText);
    } finally {
      locale.mockRestore();
      f.db.close();
    }
  });

  test('publication failure rolls the question mutation back', async () => {
    const f = setup();
    try {
      f.db.exec(
        "CREATE TRIGGER reject_notice BEFORE INSERT ON neo_publications BEGIN SELECT RAISE(ABORT,'synthetic rejection'); END"
      );
      await expect(f.ask({ replyTo: [human1] })).rejects.toThrow('synthetic rejection');
      expect(f.store.listQuestions('ask')).toHaveLength(0);
      expect(f.rows()).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });
});
