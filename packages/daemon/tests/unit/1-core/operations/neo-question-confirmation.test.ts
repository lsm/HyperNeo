import { pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-proof', role: 'neo' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const confirm = {
  path: 'projects/verify/mandate.md',
  sha256: createHash('sha256').update('New mandate.\n').digest('hex'),
};
const text = `Replace the old mandate with New mandate.\nPath: ${confirm.path}\nSHA-256: ${confirm.sha256}`;
let db: Database;
let store: NeoAskTodoRepository;
const call = async (name: string, input: unknown, caller = owner) => {
  const registry = createOperationRegistry(
    createNeoQuestionOperations(
      store,
      async () => {},
      async () => ({ ok: true })
    )
  );
  const outcome = await invokeOperation(registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value as {
    ok: boolean;
    reason?: string;
    answeredByHuman?: boolean;
    question: {
      id: string;
      state: string;
      answer: unknown;
      text: string;
      replacedBy?: string;
      confirm?: typeof confirm | null;
    };
  };
};
const ask = (input: Record<string, unknown> = {}) =>
  call('neo.question.ask', {
    retireWhen: pendingTodoCheck,
    askId: 'ask-proof',
    kind: 'yesno',
    text,
    noLabel: 'Keep the old mandate',
    yesLabel: 'Replace the mandate',
    confirm,
    ...input,
  });
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask-proof',
    projectId: null,
    sessionId: 'neo-proof',
    originMessageId: null,
    title: 'Synthetic mandate proposal',
    request: 'Review the new mandate',
    createdAt: 1,
  });
});
afterEach(() => db.close());

describe('Neo question confirmation binding', () => {
  test('persists path/hash and returns them with human-answer state', async () => {
    const created = await ask();
    expect(created).toMatchObject({ ok: true, question: { confirm } });
    store = new NeoAskTodoRepository(db);
    const before = await call('neo.question.get', { questionId: created.question.id });
    expect(before).toMatchObject({
      ok: true,
      question: { text, confirm, state: 'open', answer: null },
      answeredByHuman: false,
    });
    expect(
      await call('neo.question.answer', { questionId: created.question.id, answer: 'yes' })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('user') });
    expect(await call('neo.question.get', { questionId: created.question.id })).toMatchObject({
      answeredByHuman: false,
    });
    expect(
      await call('neo.question.answer', { questionId: created.question.id, answer: 'yes' }, human)
    ).toMatchObject({ ok: true, question: { confirm, state: 'answered', answer: 'yes' } });
    expect(await call('neo.question.get', { questionId: created.question.id })).toMatchObject({
      question: { confirm, state: 'answered', answer: 'yes' },
      answeredByHuman: true,
    });
  });
  test('preserves a no answer without losing the proposed content identity', async () => {
    const created = await ask();
    await call('neo.question.answer', { questionId: created.question.id, answer: 'no' }, human);
    expect(await call('neo.question.get', { questionId: created.question.id })).toMatchObject({
      question: { confirm, state: 'answered', answer: 'no' },
      answeredByHuman: true,
    });
  });
  test.each(['Approve the mandate?', `Approve ${confirm.path}?`, `Approve ${confirm.sha256}?`])(
    'requires both path and hash in the visible body',
    async (text) => {
      expect(await ask({ text })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_body'),
      });
      expect(store.listQuestions('ask-proof')).toHaveLength(0);
    }
  );
  test.each([
    `${confirm.path}.bak ${confirm.sha256}`,
    `archive/${confirm.path} ${confirm.sha256}`,
    `é${confirm.path} ${confirm.sha256}`,
    `other_${confirm.path} ${confirm.sha256}`,
    `${confirm.path}_backup ${confirm.sha256}`,
    `${confirm.path} ${confirm.sha256}a`,
    `${confirm.path} 0${confirm.sha256}`,
  ])('refuses a path/hash shown only inside a longer token', async (text) => {
    expect(await ask({ text })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('confirmation_body'),
    });
    expect(store.listQuestions('ask-proof')).toHaveLength(0);
  });
  test.each([
    `Approve \`${confirm.path}\` (SHA-256: ${confirm.sha256})?`,
    `Approve "${confirm.path}"? Hash: '${confirm.sha256}'.`,
    `${confirm.path}.bak ${confirm.sha256}a; exact: ${confirm.path} ${confirm.sha256}`,
  ])('accepts exact visible tokens with prose punctuation', async (text) => {
    expect(await ask({ text })).toMatchObject({ ok: true, question: { confirm } });
  });
  test.each(['*', '**', '***', '_', '__', '~~'])(
    'accepts an exact path inside matching Markdown emphasis %s',
    async (marker) => {
      expect(
        await ask({ text: `Use ${marker}${confirm.path}${marker}? ${confirm.sha256}` })
      ).toMatchObject({ ok: true, question: { confirm } });
    }
  );
  test.each(['reply', 'choice', 'start'])(
    'refuses confirmation binding on %s questions',
    async (kind) => {
      expect(await ask({ kind, options: ['A', 'B'] })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_kind'),
      });
    }
  );
  test.each(['../outside.md', '.git/config', '.coordinators/transcript.md'])(
    'refuses an internal/outside confirmation path',
    async (path) => {
      expect(
        await ask({ confirm: { ...confirm, path }, text: `${path} ${confirm.sha256}` })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('path') });
    }
  );
  test.each(['not-a-hash', confirm.sha256 + '\n', confirm.sha256.toUpperCase()])(
    'rejects malformed hashes through the input schema',
    async (sha256) => {
      await expect(ask({ confirm: { ...confirm, sha256 } })).rejects.toThrow();
      expect(store.listQuestions('ask-proof')).toHaveLength(0);
    }
  );
  test('replaces a proposal atomically and preserves the old binding', async () => {
    const old = await ask();
    expect(await ask({ text: 'Missing hash', replaces: old.question.id })).toMatchObject({
      ok: false,
    });
    expect(store.getQuestion(old.question.id)?.state).toBe('open');
    const next = {
      ...confirm,
      sha256: createHash('sha256').update('Different mandate.').digest('hex'),
    };
    const replacement = await ask({
      text: `${next.path} ${next.sha256}`,
      confirm: next,
      replaces: old.question.id,
    });
    expect(replacement).toMatchObject({ ok: true, question: { confirm: next, state: 'open' } });
    expect(await call('neo.question.get', { questionId: old.question.id })).toMatchObject({
      question: { confirm, state: 'retired' },
      answeredByHuman: false,
    });
    expect(store.getQuestion(old.question.id)?.replacedBy).toBe(replacement.question.id);
  });
  test('ordinary questions stay unbound', async () => {
    const ordinary = await ask({ confirm: undefined, text: 'Keep the ordinary question?' });
    expect(ordinary).toMatchObject({ ok: true, question: { confirm: null } });
    expect(await call('neo.question.get', { questionId: ordinary.question.id })).toMatchObject({
      question: { confirm: null },
      answeredByHuman: false,
    });
  });
});
