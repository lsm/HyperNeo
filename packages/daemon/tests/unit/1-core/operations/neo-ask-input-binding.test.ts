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
import { createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';
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
      askOp.inputSchema.parse({ kind: 'reply', text: 'Which button?', ...input }),
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
  test('a new human request opens its own ask even when Neo names an unrelated one', async () => {
    const f = setup();
    try {
      const input = f.human('There are two Open buttons on the card');
      const result = await f.ask({ input, askId: f.slow.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.question.askId).not.toBe(f.slow.id);
      const opened = f.store.getAsk(result.question.askId)!;
      expect(opened.originMessageId).toBe(input);
      expect(opened.request).toBe('There are two Open buttons on the card');
      expect(opened.title).toBe('Which button?');
      expect(result.records?.join(' ')).toContain('ask_rebound');
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
      const added = await f.add({ input, askId: other.id });
      expect(added.ok && added.todo?.askId).toBe(f.slow.id);
      expect(added.ok && added.records?.join(' ')).toContain('ask_rebound');
    } finally {
      f.db.close();
    }
  });

  test('a reply to a Neo message tied to an ask binds to that ask', () => {
    const f = setup();
    try {
      const origin = f.human('Make the query fast');
      const bound = resolveNeoInputAsk(f.store, f.reads, owner, { input: origin }, 'Speed');
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
      const again = resolveNeoInputAsk(f.store, f.reads, owner, { input }, 'Count');
      expect(again).toEqual({ value: { askId: bound.value.askId, records: [] } });
    } finally {
      f.db.close();
    }
  });

  test('askId alone stays valid; unknown input and neither field are rejected', async () => {
    const f = setup();
    try {
      expect(resolveNeoInputAsk(f.store, f.reads, owner, { askId: f.slow.id }, 't')).toEqual({
        value: { askId: f.slow.id, records: [] },
      });
      const unknown = await f.add({ input: crypto.randomUUID() });
      expect(unknown.ok ? '' : unknown.reason).toContain('unknown_input');
      expect(() => f.store.listAsks(null, 10)).not.toThrow();
      expect(resolveNeoInputAsk(f.store, f.reads, owner, {}, 't')).toEqual({
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
