import { describe, expect, test } from 'bun:test';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import {
  createNeoTodoOperations,
  type NeoTodoControls,
} from '../../../../src/lib/neo/todo-operations.ts';
import { resolveNeoInputAsk, type NeoInputReads } from '../../../../src/lib/neo/input-ask.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const conversationId = 'b0b5d1de-49a4-4f0e-9a3f-2f6f2a0d8f11';
const session = `neo:${conversationId}`;
const owner: OperationCaller = { source: 'mcp', sessionId: session, role: 'neo' };

function setup() {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  const store = new NeoAskTodoRepository(db);
  const publications = new NeoPublicationRepository(db);
  const inputs = new Map<string, NeoConversationAsk>();
  const human = (words: string, replyTo?: NeoConversationAsk['replyTo']) => {
    const id = crypto.randomUUID();
    inputs.set(id, {
      conversationId,
      requestId: id,
      askOrigin: { sessionId: session, messageId: id },
      content: words,
      sequence: inputs.size + 1,
      createdAt: new Date(0).toISOString(),
      ...(replyTo ? { replyTo } : {}),
    });
    return id;
  };
  const reads: NeoInputReads = {
    input: (_caller, id) => inputs.get(id) ?? null,
    publication: (id) => publications.get(conversationId, id),
  };
  const open = (id: string, title: string) =>
    store.openAsk({
      id,
      sessionId: session,
      originMessageId: null,
      projectId: null,
      title,
      request: 'Synthetic',
      createdAt: 1,
    });
  const slow = open('slow-sql', 'Slow sdk_messages SQL');
  const questionOps = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reads
  );
  const askOp = questionOps.find((op) => op.name === 'neo.question.ask')!;
  const ask = async (input: Record<string, unknown>) =>
    (await askOp.execute(
      askOp.inputSchema.parse({
        retireWhen: pendingTodoCheck,
        kind: 'reply',
        text: 'Which button?',
        ...input,
      }),
      owner
    )) as { ok: true; question: NeoQuestion; records?: string[] } | { ok: false; reason: string };
  const controls = {
    resolveTarget: async (ref) => ({ value: ref }),
    start: async () => ({ ok: false, reason: 'unused' }),
  } as unknown as NeoTodoControls;
  const todoOps = createNeoTodoOperations(
    store,
    new NeoTodoSessionRepository(db),
    controls,
    () => createTodoCheckPacks(db),
    () => null,
    undefined,
    reads
  );
  const addOp = todoOps.find((op) => op.name === 'neo.todo.add')!;
  const add = async (input: Record<string, unknown>) =>
    (await addOp.execute(
      addOp.inputSchema.parse({
        title: 'Fix the two Open buttons',
        check: { pack: 'core', kind: 'human_confirmed', params: { questionId: 'q' } },
        ...input,
      }),
      owner
    )) as
      | { ok: true; todo?: { askId: string }; records?: string[] }
      | { ok: false; reason: string };
  return { db, store, publications, human, reads, slow, open, ask, add };
}

describe('neo ask binding from human input', () => {
  test('a plain follow-up binds to an open ask and later input-only calls reuse it', async () => {
    const f = setup();
    try {
      const input = f.human('Also check the count query');
      const first = await f.add({ input, askId: f.slow.id });
      expect(first.ok && first.todo?.askId).toBe(f.slow.id);
      const repeated = await f.add({ input, title: 'Check the count result' });
      expect(repeated.ok && repeated.todo?.askId).toBe(f.slow.id);
      const question = await f.ask({ input });
      expect(question.ok && question.question.askId).toBe(f.slow.id);
      expect(f.store.listOpenAsks()).toHaveLength(1);
      expect(
        f.db
          .prepare('SELECT ask_id FROM neo_ask_inputs WHERE session_id = ? AND message_id = ?')
          .get(session, input)
      ).toEqual({ ask_id: f.slow.id });
    } finally {
      f.db.close();
    }
  });

  test.each(['settled', 'foreign', 'unknown'] as const)(
    'a %s target refuses binding without writing an ask or input link',
    async (kind) => {
      const f = setup();
      try {
        const input = f.human('Also check the count query');
        if (kind === 'settled') f.store.settleAsk(f.slow, 'done', 'Finished', 2);
        if (kind === 'foreign')
          f.db
            .prepare('UPDATE neo_asks SET session_id = ? WHERE id = ?')
            .run('neo:other', f.slow.id);
        const before = f.store.listAsks(null, 10).length;
        const result = await f.add({ input, askId: kind === 'unknown' ? 'missing' : f.slow.id });
        expect(result).toMatchObject({
          ok: false,
          reason: expect.stringContaining(kind === 'settled' ? 'ask_settled' : 'not_owned'),
        });
        expect(f.store.listAsks(null, 10)).toHaveLength(before);
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM neo_ask_inputs').get()).toEqual({
          count: 0,
        });
        expect(f.store.listTodos(f.slow.id)).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  );

  test('competing bindings retain the winner and name it in the refusal', async () => {
    const f = setup();
    try {
      const other = f.open('other', 'Other request');
      const input = f.human('Also check the count query');
      const results = await Promise.all([
        f.add({ input, askId: f.slow.id }),
        f.add({ input, askId: other.id }),
      ]);
      const winner = results.find((result) => result.ok);
      const loser = results.find((result) => !result.ok);
      expect(winner?.ok && winner.todo?.askId).toBe(f.slow.id);
      expect(loser).toMatchObject({
        ok: false,
        reason: expect.stringContaining(`ask_mismatch: input ${input} belongs to ask ${f.slow.id}`),
      });
      expect(f.store.listTodos(other.id)).toEqual([]);
      expect(f.db.prepare('SELECT ask_id FROM neo_ask_inputs').all()).toEqual([
        { ask_id: f.slow.id },
      ]);
    } finally {
      f.db.close();
    }
  });

  test('an insert racing a stale decision preserves the other binding', async () => {
    const f = setup();
    try {
      const other = f.open('other', 'Other request');
      const input = f.human('Also check the count query');
      const bind = f.store.claimNeoInputAsk.bind(f.store);
      let interleave = true;
      f.store.claimNeoInputAsk = async (...args) => {
        if (interleave) {
          interleave = false;
          expect(
            await resolveNeoInputAsk(f.store, f.reads, owner, { input, askId: other.id }, 'Other')
          ).toEqual({ value: { askId: other.id } });
        }
        return bind(...args);
      };
      const result = await resolveNeoInputAsk(
        f.store,
        f.reads,
        owner,
        { input, askId: f.slow.id },
        'Slow'
      );
      expect(result).toMatchObject({
        reason: {
          ok: false,
          reason: expect.stringContaining(
            `ask_mismatch: input ${input} belongs to ask ${other.id}`
          ),
        },
      });
      expect(f.db.prepare('SELECT ask_id FROM neo_ask_inputs').all()).toEqual([
        { ask_id: other.id },
      ]);
    } finally {
      f.db.close();
    }
  });

  test.each(['settled', 'missing', 'foreign'] as const)(
    'a target made %s after planning refuses the claim with its current reason',
    async (kind) => {
      const f = setup();
      try {
        const input = f.human('Also check the count query');
        const claim = f.store.claimNeoInputAsk.bind(f.store);
        f.store.claimNeoInputAsk = async (...args) => {
          if (kind === 'settled') f.store.settleAsk(f.slow, 'done', 'Finished', 2);
          if (kind === 'missing') f.db.prepare('DELETE FROM neo_asks WHERE id = ?').run(f.slow.id);
          if (kind === 'foreign')
            f.db
              .prepare('UPDATE neo_asks SET session_id = ? WHERE id = ?')
              .run('neo:other', f.slow.id);
          return claim(...args);
        };
        const result = await f.add({ input, askId: f.slow.id });
        expect(result).toMatchObject({
          ok: false,
          reason: expect.stringContaining(kind === 'settled' ? 'ask_settled' : 'not_owned'),
        });
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM neo_ask_inputs').get()).toEqual({
          count: 0,
        });
        expect(f.store.findAsk(session, input, null)).toBeNull();
        expect(f.store.listTodos(f.slow.id)).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  );

  test('a settled binding lets input-only calls open and reuse a new ask', async () => {
    const f = setup();
    try {
      const input = f.human('Also check the count query');
      expect((await f.add({ input, askId: f.slow.id })).ok).toBe(true);
      f.store.settleAsk(f.slow, 'done', 'Finished', 2);
      const next = await f.add({ input, title: 'Check again' });
      expect(next.ok && next.todo?.askId).toBeTruthy();
      if (!next.ok || !next.todo) throw new Error('The follow-up did not open a new ask');
      expect(next.todo.askId).not.toBe(f.slow.id);
      const repeated = await f.add({ input, title: 'Verify again' });
      expect(repeated.ok && repeated.todo?.askId).toBe(next.todo.askId);
      expect(f.store.getAsk(f.slow.id)?.status).toBe('done');
      expect(f.store.listOpenAsks()).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  test('an inactive settled binding can continue a different open ask', async () => {
    const f = setup();
    try {
      const input = f.human('Also check the count query');
      expect((await f.add({ input, askId: f.slow.id })).ok).toBe(true);
      f.store.settleAsk(f.slow, 'done', 'Finished', 2);
      const other = f.open('other', 'New request');
      const rebound = await f.add({ input, askId: other.id });
      expect(rebound.ok && rebound.todo?.askId).toBe(other.id);
      const repeated = await f.add({ input, title: 'Check the result' });
      expect(repeated.ok && repeated.todo?.askId).toBe(other.id);
      expect(f.store.getAsk(f.slow.id)?.status).toBe('done');
    } finally {
      f.db.close();
    }
  });

  test.each(['open', 'bind'] as const)(
    'concurrent input-only and explicit binding choose one owner when %s claims first',
    async (first) => {
      const f = setup();
      try {
        const input = f.human('Also check the count query');
        const claim = f.store.claimNeoInputAsk.bind(f.store);
        let release: () => void = () => {};
        const claimed = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.store.claimNeoInputAsk = async (request) => {
          const goesFirst = (first === 'bind') === Boolean(request.askId);
          if (!goesFirst) await claimed;
          const winner = await claim(request);
          if (goesFirst) release();
          return winner;
        };
        const results = await Promise.all([
          f.add({ input, title: 'Check the query' }),
          f.add({ input, askId: f.slow.id, title: 'Check the count' }),
        ]);
        const accepted = results.flatMap((result) =>
          result.ok && result.todo ? [result.todo.askId] : []
        );
        expect(new Set(accepted).size).toBe(1);
        if (first === 'bind') {
          expect(results.every((result) => result.ok)).toBe(true);
          expect(accepted).toEqual([f.slow.id, f.slow.id]);
        } else {
          expect(results[1]).toMatchObject({
            ok: false,
            reason: expect.stringContaining(`belongs to ask ${accepted[0]}`),
          });
        }
        const repeated = await f.add({ input, title: 'Check again' });
        expect(repeated.ok && repeated.todo?.askId).toBe(accepted[0]);
        expect(f.store.listOpenAsks()).toHaveLength(accepted[0] === f.slow.id ? 1 : 2);
      } finally {
        f.db.close();
      }
    }
  );

  test('a failed input link rolls back its newly opened ask', async () => {
    const f = setup();
    try {
      const input = f.human('Make the query faster');
      f.db.exec(`CREATE TRIGGER refuse_input_link BEFORE INSERT ON neo_ask_inputs
        BEGIN SELECT RAISE(ABORT, 'Synthetic link failure'); END`);
      await expect(f.add({ input })).rejects.toThrow('Synthetic link failure');
      expect(f.store.listOpenAsks().map((ask) => ask.id)).toEqual([f.slow.id]);
      expect(f.store.findAsk(session, input, null)).toBeNull();
      expect(await f.store.findAskInput(session, input)).toBeNull();
    } finally {
      f.db.close();
    }
  });

  test('parallel input-only calls open one ask for their shared human message', async () => {
    const f = setup();
    try {
      const input = f.human('Make the query faster');
      const results = await Promise.all([
        f.add({ input, title: 'Index the query' }),
        f.add({ input, title: 'Check the query result' }),
      ]);
      const askIds = results.map((result) => result.ok && result.todo?.askId);
      expect(askIds[0]).toBeTruthy();
      expect(askIds[1]).toBe(askIds[0]);
      expect(f.store.listOpenAsks()).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });

  test('a new human request opens its own ask', async () => {
    const f = setup();
    try {
      const input = f.human('There are two Open buttons on the card');
      const result = await f.ask({ input });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.question.askId).not.toBe(f.slow.id);
      const opened = f.store.getAsk(result.question.askId)!;
      expect(opened.originMessageId).toBe(input);
      expect(opened.request).toBe('There are two Open buttons on the card');
      expect(opened.title).toBe('Which button?');
      expect(f.store.listQuestions(f.slow.id)).toEqual([]);
      const todo = await f.add({ input });
      expect(todo.ok && todo.todo?.askId).toBe(opened.id);
    } finally {
      f.db.close();
    }
  });

  test('a reply to a question binds to that question’s ask', async () => {
    const f = setup();
    try {
      const other = f.open('other', 'Other request');
      const asked = await f.ask({ askId: f.slow.id });
      if (!asked.ok) throw new Error(asked.reason);
      const input = f.human('Use the index', { kind: 'question', id: asked.question.id });
      expect(await f.add({ input, askId: other.id })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('ask_mismatch'),
      });
      const added = await f.add({ input, askId: f.slow.id });
      expect(added.ok && added.todo?.askId).toBe(f.slow.id);
    } finally {
      f.db.close();
    }
  });

  test('a reply to a Neo message tied to an ask binds to that ask', async () => {
    const f = setup();
    try {
      const origin = f.human('Make the query fast');
      const bound = await resolveNeoInputAsk(f.store, f.reads, owner, { input: origin }, 'Speed');
      if ('reason' in bound) throw new Error(bound.reason.reason);
      const publicationId = crypto.randomUUID();
      const told = f.publications.append({
        conversationId,
        publicationId,
        askOrigin: { sessionId: session, messageId: origin },
        shortText: 'Working on it',
        fullText: 'Working on it',
        links: [],
      });
      expect(told.accepted).toBe(true);
      const input = f.human('Also the count query', {
        kind: 'message',
        id: publicationId,
        author: 'neo',
      });
      const again = await resolveNeoInputAsk(f.store, f.reads, owner, { input }, 'Count');
      expect(again).toEqual({ value: { askId: bound.value.askId } });
    } finally {
      f.db.close();
    }
  });

  test('askId alone stays valid; unknown input and neither field are rejected', async () => {
    const f = setup();
    try {
      expect(await resolveNeoInputAsk(f.store, f.reads, owner, { askId: f.slow.id }, 't')).toEqual({
        value: { askId: f.slow.id },
      });
      const unknown = await f.add({ input: crypto.randomUUID() });
      expect(unknown.ok ? '' : unknown.reason).toContain('unknown_input');
      expect(() => f.store.listAsks(null, 10)).not.toThrow();
      expect(await resolveNeoInputAsk(f.store, f.reads, owner, {}, 't')).toEqual({
        reason: {
          ok: false,
          reason: expect.stringContaining('input_required'),
        },
      });
    } finally {
      f.db.close();
    }
  });
});
