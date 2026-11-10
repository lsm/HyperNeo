import { deliverNeoTurnReport } from '../../../../src/lib/neo/turn-report.ts';
import { withCodingWorkerStartBrief } from '../../../../src/lib/neo/packs/coding/worker-worktree-brief';
import { createDelegationPack } from '../../../../src/lib/neo/packs/delegation/pack.ts';
import { createPackPreferenceOperations } from '../../../../src/lib/neo/preference-operations.ts';
import { configureWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox';
import { NEO_PACK_CODING_WORKER_RULES } from '@hyperneo/prompts';
import { createNeoQuestionAnswerDelivery } from '../../../../src/lib/neo/question-answer-delivery.ts';
import { driverExchangeReport, readDriverLanded } from '../../../../src/lib/neo/driver-work.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { planNudge } from '../../../../src/lib/neo/nudge.ts';
import { withCodingWorkerProvenance } from '../../../../src/lib/neo/packs/coding/worker-provenance.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from '../../../../src/lib/neo/pack-contract.ts';
import {
  createNeoTodoRunner,
  neoTodoNote,
  neoTurnQuestionDue,
  neoTurnQuestionGone,
  planNeoTodoCheck,
  planNeoTodoSettled,
  requireNeoTodoStartable,
} from '../../../../src/lib/neo/todo-runner.ts';
import { recordedWorkInvoke } from '../../helpers/recorded-work-invoke.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { qualifyRemoteOrigin, renderAddress } from '../../../../src/lib/mailbox/address.ts';
import { sessionSender } from '../../../../src/lib/messaging/message-send.ts';

const ref = { adapter: 'hyperneo', id: 'worker-1' };
const receipt = { executionId: ref.id, inputId: 'input-1' };
const observed = (text: string, at: number) => ({
  receipt,
  state: 'observed',
  exchange: [{ at, role: 'agent', text }],
  exchangeCut: false,
});
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function setup(
  packDone: boolean | null = null,
  dbPath = ':memory:',
  beforeInvoke?: (name: string) => void | Promise<void>,
  beforeTell?: () => void
) {
  const db = new Database(dbPath);
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: string[] = [];
  const toldKeys: (string | undefined)[] = [];
  let prOpen: boolean | Promise<boolean> = false;
  const checkedTodos: string[] = [];
  let status: unknown = null;
  let sendResult: unknown;
  let result: NeoTodoCheckResult | null | undefined;
  const pack = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    workerRules: 'Rules for this work: prove it by running it.',
    workerBrief: withCodingWorkerProvenance,
    todos: {
      schema: () => {},
      check: async (todo: NeoTodo) => {
        checkedTodos.push(todo.id);
        if (result !== undefined) return result;
        return packDone === null ? null : { done: packDone, evidence: '#1 已合并' };
      },
      statusLine: () => null,
      waiting: () => prOpen,
    },
  } satisfies NeoPack;
  const packs: NeoPack[] = [pack];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: recordedWorkInvoke(sessions.inputs, async (_caller, name, input) => {
      await beforeInvoke?.(name);
      calls.push({ name, input });
      if (name === 'work.start')
        return completed({
          ok: true,
          value: { ref, receipt, lastActivityAt: 1_000, link: '/session/w' },
        });
      if (name === 'work.send')
        return completed(sendResult ?? { ok: true, value: { delivered: true, receipt } });
      return completed(status);
    }),
    packs: () => packs,
    tell: async (_ask, _todo, note, key) => {
      beforeTell?.();
      told.push(note);
      toldKeys.push(key);
    },

    changed: () => {},
  });
  const add = (check: NeoTodo['check'] = null, instruction: string | null = 'Build the rows.') => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      {
        approvedAt: 1,
        dependsOn: [],
        title: 'Rows',
        doneWhen: 'PR merged',
        check,
        instruction,
        named: null,
      },
      1
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    return todo;
  };
  return {
    db,
    store,
    sessions,
    runner,
    calls,
    told,
    toldKeys,
    checkedTodos,
    packs,
    add,
    setStatus: (value: unknown) => {
      status = value;
    },
    setPrOpen: (value: boolean | Promise<boolean>) => {
      prOpen = value;
    },
    setSend: (value: unknown) => {
      sendResult = value;
    },
    setResult: (value: NeoTodoCheckResult | null) => {
      result = value;
    },
  };
}

describe('neo todo runner', () => {
  test('long worker instructions retain shared delegation data after message truncation', async () => {
    const h = setup();
    try {
      h.packs.push(createDelegationPack(() => h.db));
      await h.runner.start(h.add(null, 'Long task. '.repeat(2000)).id);
      const message = String(h.calls.find((call) => call.name === 'work.start')!.input.message);
      expect(message).toContain('"payment":{"value":"self","configured":false}');
      expect(message).toContain('CAPTCHAs always belong to the human');
      expect(message).toContain('Long task.');
      expect(message.length).toBeLessThanOrEqual(20_000);
    } finally {
      h.db.close();
    }
  });
  test('coding workers receive shared delegation rules and the next worker sees changed values', async () => {
    const h = setup();
    try {
      const shared = createDelegationPack(() => h.db);
      h.packs.push(shared);
      const check = { pack: 'coding', kind: 'pr_merged', params: {} };
      await h.runner.start(h.add(check).id);
      const set = createPackPreferenceOperations(h.db, () => h.packs).find(
        (op) => op.name === 'pack.preferences.set'
      )!;
      await set.execute(
        set.inputSchema.parse({
          pack: 'delegation',
          scope: { kind: 'global', key: '' },
          key: 'payment',
          value: 'fillStop',
        }),
        { source: 'rpc', principal: 'local' }
      );
      await h.runner.start(h.add(check).id);
      const messages = h.calls
        .filter((call) => call.name === 'work.start')
        .map((call) => String(call.input.message));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('"payment":{"value":"self","configured":false}');
      expect(messages[1]).toContain('"payment":{"value":"fillStop","configured":true}');
      for (const message of messages) {
        expect(message).toContain('the saved password manager or browser autofill');
        expect(message).toContain('Rules for this work');
      }
    } finally {
      h.db.close();
    }
  });
  test.each(['doing', 'done', 'failed', 'closed_unverified', 'blocked', 'todo'] as const)(
    'reports direct human work once on an open ask with todo state %s',
    async (state) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const at = Date.now() + 100;
        h.store.updateTodo(h.store.getTodo(todo.id)!, { state, report: 'Prior work' }, at - 50);
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: at + 100,
            recentInputs: [
              {
                at,
                text: 'Please change the heading directly.',
                human: true,
                inputId: 'human-input',
              },
            ],
            turnEnds: [
              { id: 'human-turn', startedAt: at, at: at + 100, message: 'Changed the heading.' },
            ],
          },
        });
        await h.runner.refresh(() => {});
        await h.runner.refresh(() => {});
        const reports = h.told.filter((note) => note.startsWith('The human worked directly'));
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain(`ask iOS card, todo ${todo.id}`);
        expect(reports[0]).toContain('The human said: Please change the heading directly.');
        expect(reports[0]).toContain('The worker replied: Changed the heading.');
        expect(reports[0]).not.toContain('dispatch');
      } finally {
        h.db.close();
      }
    }
  );

  test('reports tracked human turns only after the follow anchor without a dispatch', async () => {
    const h = setup(false);
    try {
      const todo = h.add(null, null);
      const at = Date.now() + 100;
      h.sessions.create(todo.id, { verb: 'adopt', ref });
      h.sessions.recordRef(todo.id, ref, at);
      h.sessions.recordFollowAnchor(todo.id, at);
      h.store.updateTodo(todo, { state: 'done' }, at);
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: at + 100,
          recentInputs: [
            { at: at - 100, text: 'Before tracking', human: true },
            { at: at + 10, text: 'Do the new work', human: true },
          ],
          turnEnds: [
            { id: 'old-tracked', startedAt: at - 100, at: at - 10, message: 'Old answer' },
            { id: 'new-tracked', startedAt: at + 10, at: at + 100, message: 'New answer' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      expect(h.told).toHaveLength(1);
      expect(h.told[0]).toContain('The human said: Do the new work');
      expect(h.told[0]).toContain('The worker replied: New answer');
      expect(h.sessions.inputs.list(todo.id)).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('dispatch receipt identity wins over a driver human marker', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const dispatch = h.sessions.inputs.list(todo.id)[0];
      const at = dispatch.acceptedAt + 100;
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: at + 100,
          recentInputs: [{ at, text: 'Build the rows.', human: true, inputId: receipt.inputId }],
          turnEnds: [
            { id: 'dispatch-turn', startedAt: at, at: at + 100, message: 'Normal report' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      expect(h.told.filter((note) => note.startsWith('Worker turn report'))).toHaveLength(1);
      expect(h.told.some((note) => note.startsWith('The human worked directly'))).toBe(false);
    } finally {
      h.db.close();
    }
  });

  test.each([
    'before-start',
    'shared-dispatch',
    'closed-ask',
    'explicit-send',
    'sent-receipt',
    'agent-fallback',
  ])('classifies the initiating input without losing receipt protection: %s', async (scenario) => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const at = Date.now() + 100;
      const neo = ['shared-dispatch', 'sent-receipt'].includes(scenario);
      const inputId = neo ? 'other-neo-input' : 'human-input';
      if (scenario === 'shared-dispatch') {
        const other = h.add(null, null);
        const dispatch = await h.sessions.inputs.accept(
          other.id,
          'neo',
          { verb: 'send', ref },
          'Neo request',
          at
        );
        await h.sessions.inputs.recordOutcome(
          dispatch,
          { ref, receipt: { executionId: ref.id, inputId } },
          at
        );
      }
      if (scenario === 'sent-receipt')
        h.sessions.recordSent(todo.id, {
          inputBefore: at,
          opening: 'Neo request',
          receipt: { executionId: ref.id, inputId },
        });
      if (scenario === 'closed-ask')
        h.db.prepare("UPDATE neo_asks SET status='done' WHERE id='ask'").run();
      if (scenario === 'explicit-send')
        h.db
          .prepare(`INSERT INTO neo_session_messages
          (conversation_id,message_id,from_session,to_session,text,created_at)
          VALUES ('conversation','human-turn-milestone','worker-1','neo','Worker says done',?)`)
          .run(new Date(at + 10).toISOString());
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: at + 100,
          recentInputs: [
            { at, text: 'Direct user instruction', human: scenario !== 'agent-fallback', inputId },
          ],
          turnEnds: [
            {
              id: 'origin-case',
              startedAt: at + (scenario === 'before-start' ? 1 : 0),
              at: at + 100,
              message: 'Done with direct work',
            },
          ],
        },
      });
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      const humanReports = h.told.filter((note) => note.startsWith('The human worked directly'));
      expect(humanReports).toHaveLength(
        neo || ['closed-ask', 'agent-fallback'].includes(scenario) ? 0 : 1
      );
      if (neo)
        expect(h.told.filter((note) => note.startsWith('Worker turn report'))).toHaveLength(
          scenario === 'sent-receipt' ? 1 : 0
        );
    } finally {
      h.db.close();
    }
  });

  test('caps settled-worker observations per sweep without losing older workers', async () => {
    const h = setup(false);
    try {
      const at = Date.now() + 100;
      for (let index = 0; index < 21; index++) {
        const todo = h.add(null, null);
        const worker = { adapter: 'hyperneo', id: `settled-${index}` };
        h.sessions.create(todo.id, { verb: 'adopt', ref: worker });
        h.sessions.recordRef(todo.id, worker, at);
        h.sessions.recordFollowAnchor(todo.id, at);
        h.store.updateTodo(todo, { state: 'done' }, at);
        if (index === 0) {
          const sibling = h.add(null, null);
          h.sessions.create(sibling.id, { verb: 'adopt', ref: worker });
          h.sessions.recordRef(sibling.id, worker, at);
          h.sessions.recordFollowAnchor(sibling.id, at);
          h.store.updateTodo(sibling, { state: 'done' }, at);
        }
      }
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: at + 100,
          recentInputs: [{ at: at + 10, text: 'New human work', human: true }],
          turnEnds: [
            {
              id: 'fresh-human-turn',
              startedAt: at + 10,
              at: at + 100,
              message: 'Completed direct work',
            },
          ],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.calls.filter((call) => call.name === 'work.status')).toHaveLength(20);
      await h.runner.refresh(() => {});
      expect(h.told.filter((note) => note.startsWith('The human worked directly'))).toHaveLength(
        21
      );
    } finally {
      h.db.close();
    }
  });

  test('a refused check stamp preserves the prior worker status and needs-you incident', async () => {
    const h = setup();
    try {
      const todo = h.add(null, null);
      h.sessions.recordRef(todo.id, ref, 1_000);
      h.store.updateTodo(todo, { state: 'doing', startedAt: 1_000 }, 1_000);
      h.sessions.recordLive(todo.id, 'needs_you', undefined);
      h.sessions.recordNeedsYouSince(todo.id, 900);
      h.setStatus({ ok: true, value: { status: 'running', lastActivityAt: 1_001 } });
      h.db.exec(
        "CREATE TRIGGER reject_check BEFORE UPDATE OF checked_at ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic check refusal'); END"
      );
      const warnings: string[] = [];
      await h.runner.refresh((_message, error) => warnings.push(String(error)));
      expect(warnings.some((warning) => warning.includes('synthetic check refusal'))).toBe(true);
      const afterRefusal = {
        live: h.sessions.readLiveStatus(todo.id),
        needsYouSince: h.sessions.readNeedsYouSince(todo.id),
        check: h.sessions.readCardCheck(todo.id),
      };
      h.db.exec('DROP TRIGGER reject_check');
      h.setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 1_002 } });
      await h.runner.refresh((_message, error) => warnings.push(String(error)));
      expect(h.told).toEqual([]);
      expect(afterRefusal).toEqual({ live: 'needs_you', needsYouSince: 900, check: null });
    } finally {
      h.db.close();
    }
  });

  test('a refused receipt save leaves no partially recorded worker assignment', async () => {
    const h = setup();
    try {
      const todo = h.add();
      h.db.exec(
        "CREATE TRIGGER reject_receipt BEFORE UPDATE OF sent_opening ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic receipt refusal'); END"
      );
      await expect(h.runner.start(todo.id)).rejects.toThrow('synthetic receipt refusal');
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
      expect(h.sessions.readRef(todo.id)).toBeNull();
      expect(h.sessions.readSent(todo.id)).toBeNull();
      expect(h.sessions.inputs.list(todo.id)).toHaveLength(1);
      expect(h.sessions.inputs.list(todo.id)[0].outcome).toMatchObject({ ref, receipt });
    } finally {
      h.db.close();
    }
  });

  test.each([
    { mode: 'off', sandbox: true, prepared: false },
    { mode: 'off', sandbox: undefined, prepared: false },
    { mode: 'on-demand', sandbox: undefined, prepared: false },
    { mode: 'on-demand', sandbox: true, prepared: true },
    { mode: 'always', sandbox: undefined, prepared: true },
  ] as const)(
    'only a requested sandbox prepares a coding checkout: %j',
    async ({ mode, sandbox, prepared }) => {
      configureWorkerSandbox(() => mode);
      const h = setup();
      try {
        h.packs[0] = {
          ...h.packs[0],
          workerRules: NEO_PACK_CODING_WORKER_RULES,
          workerStartBrief: withCodingWorkerStartBrief,
          prepareExecution: async () => ({ ok: false, reason: 'unused' }),
        };
        const todo = h.store.addTodo(
          crypto.randomUUID(),
          'ask',
          {
            approvedAt: 1,
            dependsOn: [],
            title: 'Rows',
            doneWhen: 'PR merged',
            check: { pack: 'coding', kind: 'pr', params: {} },
            instruction: 'Build the rows.',
            named: null,
          },
          1
        );
        h.sessions.create(todo.id, {
          verb: 'start',
          adapter: 'hyperneo',
          place: { machine: 'laptop', name: 'repo', folder: '/repo' },
          preparationParameters: { target: 'dev' },
          ...(sandbox ? { sandbox } : {}),
        });
        await h.runner.start(todo.id);
        const start = h.calls.find((call) => call.name === 'work.start')!.input;
        expect(start.preparation).toEqual(
          prepared ? { pack: 'coding', parameters: { target: 'dev' }, sandbox: true } : undefined
        );
        expect(start.message).toContain(
          "Your folder is your own worktree and stays yours across tasks. For each new task: fetch origin, then switch to a new branch from the latest target, or check out the PR head you were given. Don't create other worktrees or clones."
        );
        expect(start.message).toContain('Before changing application code, locate');
        expect(start.message).toContain('Checkout parameters');
        expect(start.message).toContain('"target":"dev"');
      } finally {
        configureWorkerSandbox(() => 'off');
        h.db.close();
      }
    }
  );

  test('keeps the worktree and verify gate brief even when a long task is truncated', async () => {
    const h = setup();
    try {
      h.packs[0] = {
        ...h.packs[0],
        workerRules: NEO_PACK_CODING_WORKER_RULES,
        workerStartBrief: withCodingWorkerStartBrief,
      };
      const todo = h.add({ pack: 'coding', kind: 'pr', params: {} }, 'x'.repeat(19_900));
      await h.runner.start(todo.id);
      const message = h.calls.find((call) => call.name === 'work.start')!.input.message;
      expect(message).toContain('Your folder is your own worktree and stays yours across tasks.');
      expect(message).toContain('Before changing application code, locate');
    } finally {
      h.db.close();
    }
  });

  test('supplies recorded identity to follow-ups without guessing missing start metadata', async () => {
    const h = setup();
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr', params: {} });
      await h.runner.start(todo.id);
      const opening = h.calls.find((call) => call.name === 'work.start')!.input.message as string;
      expect(opening).not.toContain('<exact model id>');
      expect(h.calls.find((call) => call.name === 'work.start')!.input.provenance).toBe(true);
      expect(opening).toContain('Even when told to stay quiet');
      expect(opening).toContain(`todoId: "${todo.id}"`);
      expect(opening).toContain('2–6 short options');
      h.sessions.recordRef(todo.id, ref, 1_000, undefined, {
        model: 'gpt-6.1-sol',
        effort: 'high',
      });
      h.setStatus({
        ok: true,
        value: {
          ref,
          status: 'done',
          lastActivityAt: 1000,
          model: 'claude-opus-5-5',
          effort: 'medium',
        },
      });
      await h.runner.proceed(todo.id, 'Write the PR body.');
      const followup = h.calls.findLast((call) => call.name === 'work.send')!.input
        .message as string;
      expect(followup).toContain('Agent: claude-opus-5-5 (effort: medium) via HyperNeo');
      expect(followup).not.toContain('<effort>');
      expect(h.sessions.readCard(todo.id)).toMatchObject({
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
    } finally {
      h.db.close();
    }
  });
  test('refreshes an existing Claude ref for a file-check task and clears missing effort', async () => {
    const h = setup();
    try {
      const todo = h.add({ pack: 'core', kind: 'evidence', params: { path: '/tmp/report' } });
      const worker = { adapter: 'claude-desktop', id: 'local-fixture' };
      h.sessions.bind(todo.id, worker, 1);
      h.sessions.recordRef(
        todo.id,
        worker,
        1,
        undefined,
        { model: 'old-model', effort: 'low' },
        { verb: 'send', ref: worker }
      );
      h.setStatus({
        ok: true,
        value: {
          ref: worker,
          status: 'done',
          lastActivityAt: 1000,
          model: 'claude-opus-5-5',
          effort: 'medium',
        },
      });
      await h.runner.start(todo.id);
      const message = h.calls.findLast((call) => call.name === 'work.send')!.input
        .message as string;
      expect(message).toContain('Agent: claude-opus-5-5 (effort: medium) via Claude');
      expect(h.sessions.readCard(todo.id)).toMatchObject({
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
      h.setStatus({
        ok: true,
        value: { ref: worker, status: 'done', lastActivityAt: 1000, model: 'claude-sonnet-5' },
      });
      await h.runner.proceed(todo.id, 'Continue coding.');
      const next = h.calls.findLast((call) => call.name === 'work.send')!.input.message as string;
      expect(next).toContain('Agent: claude-sonnet-5 (effort: unknown) via Claude');
      expect(next).not.toContain('effort: medium');
      expect(h.sessions.readCard(todo.id)).toMatchObject({
        model: 'claude-sonnet-5',
        effort: null,
      });
    } finally {
      h.db.close();
    }
  });

  test('binding the same ref retains identity but a different ref clears it', () => {
    const h = setup();
    try {
      const todo = h.add();
      h.sessions.recordRef(todo.id, ref, 1, undefined, {
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
      h.sessions.bind(todo.id, ref, 2);
      expect(h.sessions.readCard(todo.id)).toMatchObject({
        model: 'claude-opus-5-5',
        effort: 'medium',
      });
      h.sessions.bind(todo.id, { ...ref, id: 'other' }, 3);
      expect(h.sessions.readCard(todo.id)).toMatchObject({ model: null, effort: null });
    } finally {
      h.db.close();
    }
  });

  test.each([
    { ok: false, reason: 'unreachable', detail: 'Synthetic remote outage' },
    { ok: false, reason: 'not_found', detail: 'Synthetic missing worker' },
    null,
    { ok: true, value: { status: 'done' } },
  ])(
    'keeps last observed identity when status is unsuccessful or malformed: %j',
    async (status) => {
      const h = setup();
      try {
        const todo = h.add();
        await h.runner.start(todo.id);
        h.sessions.recordRef(todo.id, ref, 1, undefined, {
          model: 'claude-opus-5-5',
          effort: 'medium',
        });
        h.setStatus(status);
        await h.runner.proceed(todo.id, 'Continue.');
        expect(h.sessions.readCard(todo.id)).toMatchObject({
          model: 'claude-opus-5-5',
          effort: 'medium',
        });
        expect(h.calls.findLast((call) => call.name === 'work.send')!.input.message).toContain(
          'Agent: claude-opus-5-5 (effort: medium) via HyperNeo'
        );
      } finally {
        h.db.close();
      }
    }
  );

  test('sending the worker on closes the card its todo waited on', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const question = h.store.askQuestion(
        'waiting-card',
        todo.askId,
        {
          text: 'Approve the step?',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          todoId: todo.id,
        },
        Date.now()
      );
      h.store.updateTodo(
        h.store.getTodo(todo.id)!,
        { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Awaiting approval' },
        Date.now()
      );
      await h.runner.proceed(todo.id, 'Carry on without approval.');
      expect(h.store.getQuestion(question.id)).toMatchObject({ state: 'retired' });
      expect(h.store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
    } finally {
      h.db.close();
    }
  });

  test('Codex identity-silent follow-ups retain the pair confirmed at start', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const worker = { adapter: 'codex-desktop', id: 'codex-thread' };
      h.sessions.recordRef(todo.id, worker, 1, undefined, { model: 'gpt-6.1-sol', effort: 'high' });
      h.setStatus({
        ok: true,
        value: { ref: worker, status: 'done', lastActivityAt: 2, recentInputs: [] },
      });
      await h.runner.proceed(todo.id, 'Continue coding.');
      expect(h.sessions.readCard(todo.id)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
      expect(h.calls.findLast((call) => call.name === 'work.send')!.input.message).toContain(
        'Agent: gpt-6.1-sol (effort: high) via Codex'
      );
    } finally {
      h.db.close();
    }
  });

  test('an explicit observation with unknown identity clears the prior pair', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      h.sessions.recordRef(todo.id, ref, 1, undefined, { model: 'previous-model', effort: 'high' });
      h.setStatus({
        ok: true,
        value: {
          ref,
          status: 'done',
          lastActivityAt: 2,
          identityObservation: { source: 'assistant-transcript', messageId: 'unknown-observation' },
        },
      });
      await h.runner.proceed(todo.id, 'Continue.');
      expect(h.sessions.readCard(todo.id)).toMatchObject({ model: null, effort: null });
      expect(h.calls.findLast((call) => call.name === 'work.send')!.input.message).toContain(
        'Agent: unknown (effort: unknown) via HyperNeo'
      );
    } finally {
      h.db.close();
    }
  });

  test.each(['landed', 'reply'])(
    'does not attribute another todo input by the provenance opening: %s',
    async (match) => {
      const h = setup();
      try {
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: 1,
            recentInputs: [],
            model: 'claude-opus-5-5',
            effort: 'medium',
          },
        });
        h.setSend({ ok: true, value: { delivered: false } });
        const first = h.add({ pack: 'coding', kind: 'pr', params: {} });
        const second = h.add({ pack: 'coding', kind: 'pr', params: {} });
        for (const todo of [first, second]) {
          h.sessions.recordRef(todo.id, ref, undefined, undefined, {}, { verb: 'send', ref });
          await h.runner.start(todo.id);
        }
        const messages = h.calls
          .filter((call) => call.name === 'work.send')
          .map((call) => String(call.input.message));
        const firstSent = h.sessions.readSent(first.id)!;
        const secondSent = h.sessions.readSent(second.id)!;
        const exchange = [
          { at: 100, role: 'user' as const, text: messages[1] },
          { at: 101, role: 'agent' as const, text: 'Only the second todo completed.' },
        ];
        if (match === 'landed') {
          const outcome = completed({
            ok: true,
            value: {
              status: 'done',
              lastActivityAt: 101,
              recentInputs: [{ at: 100, text: messages[1] }],
              exchange,
            },
          });
          expect(readDriverLanded(outcome, firstSent)).toBeNull();
          expect(readDriverLanded(outcome, secondSent)).toBe(100);
        } else {
          expect(driverExchangeReport(exchange, false, firstSent.opening)).toBeNull();
          expect(driverExchangeReport(exchange, false, secondSent.opening)).toContain(
            'Only the second todo completed.'
          );
        }
      } finally {
        h.db.close();
      }
    }
  );

  test('identical follow-up instructions have different delivery openings', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      h.setStatus({ ok: true, value: { status: 'running', lastActivityAt: 1, recentInputs: [] } });
      h.setSend({ ok: true, value: { delivered: false } });
      await h.runner.proceed(todo.id, 'Continue.');
      const first = h.sessions.readSent(todo.id)!;
      await h.runner.proceed(todo.id, 'Continue.');
      expect(h.sessions.readSent(todo.id)?.opening).not.toBe(first.opening);
    } finally {
      h.db.close();
    }
  });

  test('a late identity refresh cannot overwrite a replacement binding', async () => {
    const h = setup();
    try {
      const todo = h.add();
      h.sessions.bind(todo.id, ref, 1);
      const replacement = { ...ref, id: 'replacement' };
      h.sessions.bind(todo.id, replacement, 2);
      await h.sessions.write('recordIdentity', todo.id, ref, { model: 'stale', effort: 'low' });
      expect(h.sessions.readCard(todo.id)).toMatchObject({
        ref: replacement,
        model: null,
        effort: null,
      });
    } finally {
      h.db.close();
    }
  });

  test('every dispatched input has a durable intent before the tool sees it', async () => {
    const seen: unknown[] = [];
    const h = setup(null, ':memory:', (name) => {
      if (name !== 'work.start' && name !== 'work.send') return;
      const exists = h.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'work_delivery_inputs'")
        .get();
      seen.push(
        exists ? h.db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all() : []
      );
    });
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      h.setStatus({
        ok: true,
        value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
      });
      h.setSend({ ok: true, value: { delivered: false, queuedSubmissionId: 'queue-next' } });
      await h.runner.proceed(todo.id, 'A separate next instruction');
      expect(seen).toMatchObject([
        [{ todo_id: todo.id, origin_session_id: 'neo', outcome: null }],
        [{ todo_id: todo.id }, { todo_id: todo.id, origin_session_id: 'neo', outcome: null }],
      ]);
      const inputs = h.db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all() as {
        id: string;
        message: string;
        accepted_at: number;
        deadline_at: number;
        outcome: string;
      }[];
      expect(new Set(inputs.map((row) => row.id)).size).toBe(2);
      expect(inputs[0].message).toContain('Build the rows.');
      expect(inputs[1].message).toContain('A separate next instruction');
      for (const row of inputs) expect(row.deadline_at - row.accepted_at).toBe(30000);
      expect(JSON.parse(inputs[1].outcome)).toMatchObject({
        ref,
        delivery: { delivered: false, queuedSubmissionId: 'queue-next' },
      });
      h.store.updateTodo(h.store.getTodo(todo.id)!, { state: 'failed' }, Date.now());
      expect(h.db.prepare('SELECT count(*) AS n FROM work_delivery_inputs').get()).toEqual({
        n: 2,
      });
    } finally {
      h.db.close();
    }
  });

  test('accepted inbox input retains its baseline anchor without claiming consumption after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-dispatch-'));
    const dbPath = join(dir, 'synthetic.db');
    const delivery = {
      delivered: false,
      unconfirmed: true,
      receipt: { executionId: 'worker-1', inputId: 'input-1' },
    };
    let id = '';
    try {
      const h = setup(null, dbPath);
      try {
        const todo = h.add();
        id = todo.id;
        h.db
          .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
          .run(JSON.stringify({ verb: 'send', ref }), id);
        h.setStatus({
          ok: true,
          value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
        });
        h.setSend({ ok: true, value: delivery });
        await h.runner.start(id);
      } finally {
        h.db.close();
      }
      const db = new Database(dbPath);
      try {
        const sessions = new NeoTodoSessionRepository(db);
        expect(sessions.readSent(id)).toMatchObject({ delivery, receipt: delivery.receipt });
        expect(sessions.readStartedAt(id)).toBe(1000);
        db.prepare('UPDATE neo_todo_sessions SET sent_receipt = ? WHERE todo_id = ?').run(
          JSON.stringify({ ref: JSON.stringify(ref), receipt: delivery.receipt }),
          id
        );
        expect(sessions.readSent(id)).toMatchObject({ receipt: delivery.receipt });
        expect(sessions.readSent(id)).not.toHaveProperty('delivery');
        db.prepare('UPDATE neo_todo_sessions SET sent_receipt = ? WHERE todo_id = ?').run(
          JSON.stringify({
            ref: JSON.stringify(ref),
            receipt: delivery.receipt,
            delivery: { delivered: 'not a boolean' },
          }),
          id
        );
        expect(sessions.readSent(id)).toMatchObject({ receipt: delivery.receipt });
        expect(sessions.readSent(id)).not.toHaveProperty('delivery');
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { delivered: false, queuedSubmissionId: 'queue-1' },
    {
      delivered: false,
      unconfirmed: true,
      receipt: { executionId: 'worker-1', inputId: 'input-1' },
    },
    { delivered: true, steeredIntoTurnId: 'turn-1' },
  ])('retains the latest dispatch facts through start and continue: %j', async (delivery) => {
    const h = setup();
    try {
      const todo = h.add();
      h.db
        .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
        .run(JSON.stringify({ verb: 'send', ref }), todo.id);
      h.setStatus({
        ok: true,
        value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
      });
      h.setSend({ ok: true, value: delivery });
      await h.runner.start(todo.id);
      expect(new NeoTodoSessionRepository(h.db).readSent(todo.id)).toMatchObject({ delivery });
      expect(h.sessions.readStartedAt(todo.id)).toBe(
        'queuedSubmissionId' in delivery ? null : 1000
      );
      const next = { delivered: false, queuedSubmissionId: 'queue-2' };
      h.setSend({ ok: true, value: next });
      await h.runner.proceed(todo.id, 'Next synthetic instruction');
      expect(h.sessions.readStartedAt(todo.id)).toBeNull();
      expect(new NeoTodoSessionRepository(h.db).readSent(todo.id)).toMatchObject({
        delivery: next,
      });
      h.sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'different-worker' });
      expect(h.sessions.readSent(todo.id)).not.toHaveProperty('delivery');
    } finally {
      h.db.close();
    }
  });

  test('follows a stopped todo session for a later PR report without writing legacy work', async () => {
    const { db, store, sessions, runner, add, setStatus, calls, told } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'blocked', blockedBy: 'worker', report: 'Initial report' },
      2000
    );
    sessions.recordFollowAnchor(todo.id, 2000);
    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 4000,
        inputEvidence: observed('Later PR https://github.com/a/b/pull/9', 3000),
        exchange: [
          { at: 1000, role: 'user', text: String(calls[0].input.message) },
          { at: 3000, role: 'agent', text: 'Later PR https://github.com/a/b/pull/9' },
        ],
      },
    });
    await runner.refresh(() => {});
    const report = store.getTodo(todo.id)?.report;
    expect(report).toContain('https://github.com/a/b/pull/9');
    expect(report).toContain('Initial report');
    expect(store.getTodo(todo.id)?.state).toBe('doing');
    expect(sessions.readFollowAnchor(todo.id)).toBe(4000);
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'doing',
      report: expect.stringContaining('https://github.com/a/b/pull/9'),
    });
    expect(told).toEqual([]);
    db.close();
  });
  test.each([false, true])(
    'delivers one input per shared worker turn, explicit send: %s',
    async (sent) => {
      const h = setup(false);
      try {
        const todos = [
          h.add({ pack: 'coding', kind: 'pr_merged', params: {} }),
          h.add({ pack: 'coding', kind: 'pr_merged', params: {} }),
        ];
        for (const todo of todos) await h.runner.start(todo.id);
        const startedAt = Date.now() + 10;
        if (sent)
          h.db
            .prepare(`INSERT INTO neo_session_messages
        (conversation_id,message_id,from_session,to_session,text,created_at)
        VALUES ('conversation','explicit','worker-1','neo','PR opened',?)`)
            .run(new Date(startedAt + 10).toISOString());
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: startedAt + 100,
            turnEnds: [{ id: 'shared-turn', startedAt, at: startedAt + 100, message: 'PR opened' }],
          },
        });
        await h.runner.refresh(() => {});
        await h.runner.refresh(() => {});
        expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(
          sent ? 0 : 1
        );
        for (const todo of todos) expect(h.store.getTodo(todo.id)?.state).toBe('doing');
      } finally {
        h.db.close();
      }
    }
  );

  test('delivers one shared turn when bound todos first observe different live statuses', async () => {
    let startedAt: number | null = null;
    let reads = 0;
    const h = setup(false, ':memory:', (name) => {
      if (name !== 'work.status' || startedAt === null) return;
      h.setStatus({
        ok: true,
        value: {
          status: ++reads === 1 ? 'done' : 'running',
          lastActivityAt: startedAt + 100,
          turnEnds: [{ id: 'shared-turn', startedAt, at: startedAt + 100, message: 'PR opened' }],
        },
      });
    });
    try {
      const todos = [
        h.add({ pack: 'coding', kind: 'pr_merged', params: {} }),
        h.add({ pack: 'coding', kind: 'pr_merged', params: {} }),
      ];
      for (const todo of todos) await h.runner.start(todo.id);
      startedAt = Date.now() + 10;
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      expect(reads).toBeGreaterThan(1);
      expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test.each([
    ['hyperneo', undefined, false],
    ['codex-desktop', undefined, false],
    ['claude-code', undefined, false],
    ['hyperneo', 'attached-alias', false],
    ['codex-desktop', 'attached-alias', false],
    ['claude-code', 'attached-alias', false],
    ['hyperneo', 'attached-alias', true],
  ] as const)(
    'matches a send from %s routed via %s using its recorded identity, other host: %s',
    async (adapter, daemon, otherHost) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const source = { adapter, id: 'source-worker', ...(daemon ? { daemon } : {}) };
        const startedAt = Date.now() + 10;
        h.sessions.recordRef(todo.id, source, startedAt);
        const dispatch = await h.sessions.inputs.accept(
          todo.id,
          'neo',
          { verb: 'send', ref: source },
          'Observe source',
          startedAt
        );
        await h.sessions.inputs.recordOutcome(dispatch, { ref: source }, startedAt);
        const localId = adapter === 'hyperneo' ? source.id : `${adapter}:${source.id}`;
        const origin = renderAddress({ kind: 'session', sessionId: localId });
        const sender = sessionSender(
          daemon
            ? qualifyRemoteOrigin(origin, otherHost ? 'another-host' : 'remote-self-name')
            : origin
        );
        h.db
          .prepare(`INSERT INTO neo_session_messages
        (conversation_id,message_id,from_session,to_session,text,created_at)
        VALUES ('conversation','source-send',?,'neo','PR opened',?)`)
          .run(sender, new Date(startedAt + 10).toISOString());
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: startedAt + 100,
            place: { machine: 'remote-self-name', name: 'Synthetic' },
            turnEnds: [{ id: 'source-turn', startedAt, at: startedAt + 100, message: 'PR opened' }],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(
          otherHost ? 1 : 0
        );
      } finally {
        h.db.close();
      }
    }
  );

  test('a turn started by another todo nudge neither reports nor blocks on this todo', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      const other = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const worker = { adapter: 'codex-desktop', id: 'shared-thread' };
      const nudgedAt = Date.now() + 10;
      h.sessions.recordRef(todo.id, worker, nudgedAt);
      const own = await h.sessions.inputs.accept(
        todo.id,
        'neo',
        { verb: 'send', ref: worker },
        'Docs PR',
        nudgedAt - 5
      );
      await h.sessions.inputs.recordOutcome(own, { ref: worker }, nudgedAt - 5);
      const nudge = await h.sessions.inputs.accept(
        other.id,
        'neo',
        { verb: 'send', ref: worker },
        'lsm/hyperneo#9553 has been waiting on requested changes for 20 min.',
        nudgedAt
      );
      await h.sessions.inputs.recordOutcome(nudge, { ref: worker }, nudgedAt);
      const before = h.store.getTodo(todo.id)!;
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: nudgedAt + 100,
          turnEnds: [
            {
              id: 'nudged-turn',
              startedAt: nudgedAt,
              at: nudgedAt + 100,
              message: 'Reproduced the finding.\n\nBlocked (needs_human): clarify the approval.',
            },
          ],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.store.getTodo(todo.id)).toMatchObject({
        state: before.state,
        report: before.report,
      });
      expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('a turn started by a notice reaches Neo once, attached to no todo', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      const other = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      await h.runner.start(other.id);
      const worker = { adapter: 'codex-desktop', id: 'shared-thread' };
      const nudgedAt = Date.now() + 10;
      h.sessions.recordRef(todo.id, worker, nudgedAt);
      h.sessions.recordRef(other.id, worker, nudgedAt);
      const nudge = await h.sessions.inputs.accept(
        null,
        'neo',
        { verb: 'send', ref: worker },
        'lsm/hyperneo#1 has failing CI.',
        nudgedAt
      );
      await h.sessions.inputs.recordOutcome(nudge, { ref: worker }, nudgedAt);
      const before = h.store.getTodo(todo.id)!;
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: nudgedAt + 100,
          turnEnds: [
            {
              id: 'notice-turn',
              startedAt: nudgedAt,
              at: nudgedAt + 100,
              message: 'Blocked (needs_human): which CI fix do you want?',
            },
          ],
        },
      });
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      const reports = h.told.filter((text) => text.includes('which CI fix do you want?'));
      expect(reports).toHaveLength(1);
      expect(reports[0]).not.toContain(todo.id);
      expect(reports[0]).not.toContain(other.id);
      expect(h.store.getTodo(todo.id)).toMatchObject({
        state: before.state,
        report: before.report,
      });
    } finally {
      h.db.close();
    }
  });

  test.each(['earlier', 'later', 'other-sender', 'other-recipient', 'unknown-start'])(
    'does not silence a new worker report for an unrelated send: %s',
    async (scenario) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const startedAt = Date.now() + 100;
        const sentAt = startedAt + (scenario === 'earlier' ? -10 : scenario === 'later' ? 200 : 10);
        h.db
          .prepare(`INSERT INTO neo_session_messages
          (conversation_id,message_id,from_session,to_session,text,created_at)
          VALUES ('conversation','unrelated',?,?, 'Old milestone',?)`)
          .run(
            scenario === 'other-sender' ? 'another-worker' : ref.id,
            scenario === 'other-recipient' ? 'another-neo' : 'neo',
            new Date(sentAt).toISOString()
          );
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: startedAt + 100,
            turnEnds: [
              {
                id: 'new-turn',
                ...(scenario === 'unknown-start' ? {} : { startedAt }),
                at: startedAt + 100,
                message: 'Blocked for a new reason',
              },
            ],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(1);
        expect(h.told.at(-1)).toContain('Blocked for a new reason');
      } finally {
        h.db.close();
      }
    }
  );

  test.each([
    'empty',
    'whitespace',
    'meaningful',
    'unknown-prior',
    'changed-status',
    'question',
    'turn-question',
    'waiting',
    'new-block',
    'legacy-observation',
  ] as const)(
    'empty automatic reports preserve the nearest actionable case: %s',
    async (scenario) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        if (scenario !== 'unknown-prior')
          h.sessions.recordLive(
            todo.id,
            scenario === 'changed-status' ? 'running' : 'done',
            undefined
          );
        if (scenario === 'question') askForWorker(h, todo.id);
        if (scenario === 'new-block')
          h.store.updateTodo(
            h.store.getTodo(todo.id)!,
            {
              state: 'blocked',
              blockedBy: 'needs-human',
              blockedReason: 'A new decision is required',
            },
            Date.now()
          );
        const dispatch = h.sessions.inputs.list(todo.id)[0]!;
        const at = dispatch.acceptedAt + 100;
        const message =
          scenario === 'meaningful' ? 'A new decision' : scenario === 'whitespace' ? '  \n' : '';
        if (scenario === 'legacy-observation')
          await h.sessions.turnReports.observe(
            todo.id,
            dispatch.id,
            ref,
            { status: 'done' },
            { id: 'empty-observation', at, message },
            'neo'
          );
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: at,
            ...(scenario === 'waiting' ? { waitingFor: 'Human approval' } : {}),
            ...(scenario === 'turn-question'
              ? {
                  turnQuestion: {
                    id: 'worker-question',
                    at,
                    text: 'Choose next step',
                    actions: ['Continue'],
                  },
                }
              : {}),
            turnEnds: [{ id: 'empty-observation', at, message }],
          },
        });
        await h.runner.refresh(() => {});
        const reports = h.told.filter((text) => text.startsWith('Worker turn report'));
        expect(reports).toHaveLength(['empty', 'whitespace'].includes(scenario) ? 0 : 1);
        expect(h.store.getTodo(todo.id)?.state).not.toBe('done');
      } finally {
        h.db.close();
      }
    }
  );

  test('a failed actionable empty report remains retryable after idle state is recorded', async () => {
    let failDelivery = true;
    const h = setup(false, ':memory:', undefined, () => {
      if (failDelivery) throw new Error('Synthetic report admission failure');
    });
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      h.sessions.recordLive(todo.id, 'running', undefined);
      const dispatch = h.sessions.inputs.list(todo.id)[0]!;
      const at = dispatch.acceptedAt + 100;
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: at,
          turnEnds: [{ id: 'retry-empty', at, message: '' }],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.told).toHaveLength(0);
      h.sessions.recordLive(todo.id, 'done', undefined);
      failDelivery = false;
      await h.runner.refresh(() => {});
      expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(1);
      await h.runner.refresh(() => {});
      expect(h.told.filter((text) => text.startsWith('Worker turn report'))).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('a quiet assignment cannot acknowledge another assignment actionable retry', async () => {
    const h = setup(false);
    try {
      const quiet = h.add();
      const actionable = h.add();
      const ask = h.store.getAsk('ask')!;
      const turn = { id: 'shared-empty', at: Date.now() + 10, message: '' };
      let attempts = 0;
      const delivered: string[] = [];
      const tell = async (_ask: unknown, _todo: unknown, text: string) => {
        if (++attempts === 1) throw new Error('Synthetic admission failure');
        delivered.push(text);
      };
      const facts = {
        priorStatus: 'done' as const,
        state: 'doing' as const,
        blockedBy: null,
        questionOpen: false,
      };
      const sendQuiet = () =>
        deliverNeoTurnReport(
          ask,
          quiet,
          'quiet',
          ref,
          { status: 'done' },
          turn,
          tell,
          h.sessions.turnReports,
          facts
        );
      const sendActionable = () =>
        deliverNeoTurnReport(
          ask,
          actionable,
          'actionable',
          ref,
          { status: 'done' },
          turn,
          tell,
          h.sessions.turnReports,
          { ...facts, priorStatus: 'running' }
        );
      await sendQuiet();
      expect(attempts).toBe(0);
      await expect(sendActionable()).rejects.toThrow('Synthetic admission failure');
      await sendQuiet();
      await sendActionable();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain(`todo ${actionable.id}`);
    } finally {
      h.db.close();
    }
  });

  test.each([
    'covered',
    'uncovered',
    'closed',
    'changed',
    'new-card',
    'meaningful',
    'failed',
    'environment-covered',
    'environment-uncovered',
    'restart',
    'new-owner',
  ] as const)(
    'structured blocker repeats require a successful same-state receipt and live card: %s',
    async (scenario) => {
      const h = setup(false);
      try {
        const todo = h.add();
        const kind = scenario.startsWith('environment') ? 'environment' : 'needs_human';
        h.store.updateTodo(
          todo,
          {
            state: 'blocked',
            blockedBy: kind === 'environment' ? 'environment' : 'needs-human',
            blockedReason: 'Approval required',
          },
          2
        );
        const question = scenario.endsWith('uncovered') ? null : askForWorker(h, todo.id);
        const ask = h.store.getAsk('ask')!;
        let attempts = 0;
        const delivered: string[] = [];
        const tell = async (_ask: unknown, _todo: unknown, text: string) => {
          if (++attempts === 1 && scenario === 'failed')
            throw new Error('Synthetic delivery failure');
          delivered.push(text);
        };
        const send = (id: string, message: string) => {
          const current = h.store.getTodo(todo.id)!;
          const openCardIds = h.store
            .listQuestions('ask')
            .filter((card) => card.state === 'open' && card.todoId === todo.id)
            .map((card) => card.id);
          const facts = {
            priorStatus: 'done' as const,
            state: current.state,
            blockedBy: current.blockedBy,
            questionOpen: openCardIds.length > 0,
            openCardIds,
          };
          return deliverNeoTurnReport(
            ask,
            current,
            'dispatch',
            ref,
            { status: 'done' },
            { id, at: Date.now() + attempts + 10, message },
            tell,
            scenario === 'restart' && id === 'second-block'
              ? new NeoTodoSessionRepository(h.db).turnReports
              : h.sessions.turnReports,
            facts
          );
        };
        const first = send('first-block', `Blocked (${kind}): Approval required`);
        if (scenario === 'failed')
          await expect(first).rejects.toThrow('Synthetic delivery failure');
        else await first;
        expect(delivered).toHaveLength(scenario === 'failed' ? 0 : 1);
        if (scenario === 'new-owner') ask.sessionId = 'another-owner';
        if (scenario === 'closed') h.store.retireQuestion(question!, 'Resolved', null, 3);
        if (scenario === 'new-card') {
          h.store.retireQuestion(question!, 'Replaced', null, 3);
          askForWorker(h, todo.id);
        }
        if (scenario === 'changed')
          h.store.updateTodo(h.store.getTodo(todo.id)!, { blockedReason: 'Another decision' }, 3);
        const message =
          scenario === 'changed'
            ? `Blocked (${kind}): Another decision\r\n`
            : scenario === 'meaningful'
              ? `New evidence.\nBlocked (${kind}): Approval required\r\n`
              : `Blocked (${kind}): Approval required\r\n`;
        await send('second-block', message);
        expect(delivered).toHaveLength(
          ['covered', 'failed', 'environment-covered', 'restart'].includes(scenario) ? 1 : 2
        );
      } finally {
        h.db.close();
      }
    }
  );

  test.each(['', '  Final worker message 🔬\n'.repeat(400)])(
    'relays a terminal message verbatim as a report without changing the todo result: %s',
    async (message) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const dispatch = h.sessions.inputs.list(todo.id)[0];
        const prior = 'Keep the stored result';
        h.store.updateTodo(h.store.getTodo(todo.id)!, { report: prior }, Date.now());
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: dispatch.acceptedAt + 100,
            lastReply: 'Unverified prose says complete',
            turnEnds: [{ id: 'turn-1', at: dispatch.acceptedAt + 100, message }],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.told).toContain(
          `Worker turn report (todo ${todo.id}, dispatch ${dispatch.id}, status done):\n\n${message || 'worker ended its turn with no reply'}`
        );
        expect(h.store.getTodo(todo.id)).toMatchObject({ state: 'doing', report: prior });
      } finally {
        h.db.close();
      }
    }
  );

  test.each(['', 'Approve it and start implementation.\nVerbatim discussion text.'])(
    'labels focused discussion turns as status only without changing their bytes or results: %s',
    async (message) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const op = createNeoQuestionOperations(
          h.store,
          async () => {},
          async () => ({ ok: true }),
          undefined,
          undefined,
          async (source) => ({
            ...source,
            name: 'Discussion',
            label: 'Discussion',
            provider: 'Anthropic',
            link: '/session/worker-1',
          })
        ).find((op) => op.name === 'neo.question.ask')!;
        const input = {
          askId: 'ask',
          kind: 'reply',
          text: 'Prepared?',
          todoId: todo.id,
          focused: true,
          sourceSession: ref,
        };
        await op.execute(op.inputSchema.parse(input), {
          source: 'mcp',
          sessionId: 'neo',
          role: 'neo',
        });
        const dispatch = h.sessions.inputs.list(todo.id)[0];
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: dispatch.acceptedAt + 100,
            turnEnds: [{ id: 'focused-turn', at: dispatch.acceptedAt + 100, message }],
          },
        });
        await h.runner.refresh(() => {});
        const content = message || 'worker ended its turn with no reply';
        const report = h.told.find((note) => note.includes(content));
        expect(report).toContain('Focused discussion status only');
        expect(report).toContain('Do not act, reply, forward or treat this as approval.');
        expect(report).toContain(`ask ask, todo ${todo.id}, dispatch ${dispatch.id}`);
        expect(report?.endsWith(content)).toBe(true);
        expect(h.store.getTodo(todo.id)).toMatchObject({ state: 'doing', report: null });
        expect(h.store.getAsk('ask')).toMatchObject({ status: 'open', outcome: null });
      } finally {
        h.db.close();
      }
    }
  );

  test('does not relay a turn that predates this dispatch or belongs to the replaced worker', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const dispatch = h.sessions.inputs.list(todo.id)[0];
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: dispatch.acceptedAt - 1,
          turnEnds: [{ id: 'old', at: dispatch.acceptedAt - 1, message: 'Old worker turn' }],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.told).toEqual([]);
      h.sessions.recordRef(todo.id, { ...ref, id: 'replacement' });
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: dispatch.acceptedAt + 1,
          turnEnds: [
            { id: 'wrong-worker', at: dispatch.acceptedAt + 1, message: 'Wrong worker turn' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.told).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('starts a todo in its session, settles its report and lets the pack tick it done', async () => {
    const { store, sessions, runner, calls, told, add, setStatus } = setup(true);
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    const started = await runner.start(todo.id);
    expect(started.ok && started.todo).toMatchObject({
      title: 'Rows',
      state: 'doing',
      startedAt: expect.any(Number),
    });
    expect(calls[0]).toMatchObject({
      name: 'work.start',
      input: { adapter: 'hyperneo', title: 'HyperNeo repo 1' },
    });
    expect(String(calls[0].input.message)).toContain('Build the rows.');
    expect(sessions.readRef(todo.id)).toEqual(ref);
    expect(await runner.start(todo.id)).toEqual({
      ok: false,
      reason: 'already_started: this todo is doing.',
    });

    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        lastReply: 'Opened the PR',
        inputEvidence: observed('Opened https://github.com/a/b/pull/1', 2000),
        exchange: [
          { at: 1_500, role: 'user', text: String(calls[0].input.message) },
          { at: 2_000, role: 'agent', text: 'Opened https://github.com/a/b/pull/1' },
        ],
      },
    });
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'done',
      report: expect.stringContaining('pull/1'),
      evidence: '#1 已合并',
    });
    expect(told).toEqual(['Todo "Rows" is done: #1 已合并']);
  });

  test('a todo starting in another repository stays on its original card', async () => {
    const { store, sessions, runner } = setup();
    const todo = store.addTodo(
      'moving',
      'ask',
      {
        approvedAt: 1,
        dependsOn: [],
        title: 'Rows',
        doneWhen: 'PR merged',
        check: null,
        instruction: 'Go.',
        named: null,
      },
      1,
      'github.com/lsm/hyperneo'
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: {
        machine: 'laptop',
        name: 'ops',
        folder: '/ops',
        remotes: ['git@github.com:lsm/ops.git'],
      },
    });
    const started = await runner.start(todo.id);
    expect(started.ok && started.todo.askId).toBe('ask');
    expect(store.getTodo('moving')).toMatchObject({ state: 'doing', askId: 'ask' });
    expect(store.listChildAsks('ask')).toEqual([]);
  });

  test("a todo checked by a pack sends that pack's worker rules after its instruction", async () => {
    const { runner, calls, add } = setup();
    await runner.start(add({ pack: 'coding', kind: 'pr_merged', params: {} }).id);
    await runner.start(add().id);
    expect(
      calls.filter((call) => call.name === 'work.start').map((call) => call.input.message)
    ).toEqual([
      expect.stringMatching(/Build the rows\.[\s\S]*Rules for this work: prove it by running it\./),
      expect.not.stringContaining('Rules for this work'),
    ]);
  });

  test('lets the packs track a todo without a check, and never finishes it from them', async () => {
    const { runner, store, sessions, add, checkedTodos } = setup(true);
    const todo = store.updateTodo(add(null), { state: 'doing' }, 2);
    sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'w' });
    await runner.refresh(() => {});
    expect(checkedTodos).toEqual([todo.id]);
    expect(store.getTodo(todo.id)?.state).toBe('doing');
  });

  test('a start that lands after its ask settled stops its session', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const ask = store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'T',
      request: 'T',
      createdAt: 1,
    });
    const todo = store.addTodo(
      't',
      'ask',
      {
        approvedAt: 1,
        dependsOn: [],
        title: 'Rows',
        doneWhen: 'Done',
        check: null,
        instruction: 'Do',
        named: null,
      },
      1
    );
    sessions.create(todo.id, { verb: 'send', ref });
    const calls: string[] = [];
    const runner = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions,
      invoke: async (_caller, name) => {
        calls.push(name);
        if (name === 'work.send') {
          store.settleAsk(ask, 'dropped', 'Dropped', 2);
          return completed({ ok: true, value: { ref } });
        }
        return completed({ ok: true, value: { status: 'running' } });
      },
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    await runner.start(todo.id);
    expect(calls.at(-1)).toBe('work.stop');
  });

  test('a ref recorded while recovery reads are in flight keeps the started todo doing', async () => {
    const { db, store, sessions, runner, told, add, setStatus } = setup();
    try {
      const todo = add();
      store.claimStart(todo, 2);
      setStatus({ ok: true, value: { status: 'running', lastActivityAt: 1000 } });
      const read = vi.spyOn(sessions, 'read').mockImplementationOnce((async () => {
        const stale = sessions.unrecordedStarts();
        sessions.recordRef(todo.id, ref, 1000);
        return stale;
      }) as typeof sessions.read);
      try {
        await runner.refresh(() => {});
        expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', reason: null });
        expect(sessions.readRef(todo.id)).toEqual(ref);
        expect(told).toEqual([]);
      } finally {
        read.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  for (const state of ['done', 'blocked', 'failed', 'removed'] as const) {
    test(`a todo changed to ${state} during recovery keeps the recorded decision`, async () => {
      const { db, store, sessions, runner, told, add } = setup();
      try {
        const todo = add();
        store.claimStart(todo, 2);
        const read = vi.spyOn(sessions, 'read').mockImplementationOnce((async () => {
          const stale = sessions.unrecordedStarts();
          store.updateTodo(
            todo,
            {
              state,
              reason: 'Human decision',
              ...(state === 'blocked'
                ? ({ blockedBy: 'failure', blockedReason: 'Human decision' } as const)
                : {}),
            },
            3
          );
          return stale;
        }) as typeof sessions.read);
        try {
          await runner.refresh(() => {});
          expect(store.getTodo(todo.id)).toMatchObject({ state, reason: 'Human decision' });
          expect(told).toEqual([]);
        } finally {
          read.mockRestore();
        }
      } finally {
        db.close();
      }
    });
  }

  test('a start a restart interrupted fails the todo on the next refresh', async () => {
    const { store, runner, told, add } = setup();
    const todo = add();
    store.claimStart(todo, 2);
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'failed',
      reason: 'Start was interrupted; a session may have started without being recorded.',
    });
    expect(told).toEqual([expect.stringContaining('Start was interrupted')]);
    expect(await runner.retry(todo.id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('start_uncertain'),
    });
  });

  test('a start the driver refuses fails the todo with its reason', async () => {
    const { db, store, add, told } = setup();
    const todo = add();
    const failing = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'login expired' }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      changed: () => {},
    });
    const result = await failing.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({
      state: 'failed',
      reason: 'Could not start: unavailable: login expired',
    });
    expect(told).toEqual(['Todo "Rows" failed: Could not start: unavailable: login expired']);
  });

  test('a refused dispatch records failure after a concurrent report write', async () => {
    const h = setup();
    const todo = h.add();
    try {
      const runner = createNeoTodoRunner({
        limits: () => ({ running: 99, perGroup: 99 }),
        write: gatewayFor(h.db).run.bind(gatewayFor(h.db)),
        store: h.store,
        sessions: h.sessions,
        packs: () => [],
        invoke: async () => {
          const current = h.store.getTodo(todo.id)!;
          h.store.updateTodo(current, { report: 'Concurrent start report' }, current.updatedAt + 1);
          return completed({ ok: false, reason: 'unavailable', detail: 'Synthetic refusal' });
        },
        tell: async () => {},
        changed: () => {},
      });
      expect(await runner.start(todo.id)).toMatchObject({
        ok: true,
        todo: { state: 'failed', report: 'Concurrent start report' },
      });
    } finally {
      h.db.close();
    }
  });

  test('a start whose input was accepted but now waits on a prompt keeps its session', async () => {
    const { db, store, add } = setup();
    const todo = add();
    const accepted = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () =>
        completed({
          ok: true,
          value: {
            ref: { adapter: 'copilot', id: 's1' },
            title: 'Rows',
            place: { machine: 'laptop', name: 'repo' },
            status: 'needs_you',
            lastActivityAt: 1,
            receipt: { executionId: 's1', inputId: 'in-1' },
          },
        }),
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    const result = await accepted.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({ state: 'doing', blockedBy: null });
    expect(new NeoTodoSessionRepository(db).doingTodoOn({ adapter: 'copilot', id: 's1' })?.id).toBe(
      todo.id
    );
  });

  test('a start that needs the human blocks the todo with its plain hint, and retry starts it again', async () => {
    const { db, store, runner, add, told } = setup();
    const todo = add();
    const hint =
      'Claude Desktop did not import the new session. The task was not started. Open Claude Desktop, then ask Neo to start it again.';
    const waiting = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () =>
        completed({
          ok: true,
          value: {
            ref: { adapter: 'claude-desktop', id: 'local_u1' },
            title: 'Rows',
            place: { machine: 'laptop', name: 'repo' },
            status: 'needs_you',
            lastActivityAt: 1,
            watchHint: hint,
          },
        }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      changed: () => {},
    });
    const result = await waiting.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: `Could not start: ${hint}`,
      nextAction: 'Ask the human to open Claude Desktop, then retry this todo.',
    });
    expect(told).toEqual([expect.stringContaining(hint)]);
    expect(await runner.retry(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });
});

describe('neo todo runner follow-ups', () => {
  test('continue sends the next step and reopens the todo; retry goes again only before a session', async () => {
    const { store, runner, calls, add, setStatus } = setup();
    const todo = add();
    expect(await runner.proceed(todo.id, 'next')).toMatchObject({
      ok: true,
      todo: { id: todo.id, state: 'todo' },
      records: [expect.stringContaining('not_started:')],
    });
    await runner.start(todo.id);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'done', report: 'Done' }, 3);
    setStatus({ ok: true, value: { delivered: true } });
    const continued = await runner.proceed(todo.id, 'Now add tests.');
    expect(continued.ok && continued.todo).toMatchObject({ state: 'doing', report: null });
    expect(calls.at(-1)).toMatchObject({ name: 'work.send', input: { ref } });
    expect(String(calls.at(-1)?.input.message)).toContain('Now add tests.');
    expect(await runner.retry(todo.id)).toMatchObject({
      ok: true,
      todo: { id: todo.id, state: 'doing' },
      records: [expect.stringContaining('not_retryable:')],
    });
  });
});

describe('neoTurnQuestionDue', () => {
  const question = { id: 't', at: 100, text: 'Ship it?', actions: [] };
  const facts = { noted: undefined, anchor: 50, lastInputAt: null };
  test.each([
    ['a fresh question', facts, true],
    ['one already told', { ...facts, noted: 't' }, false],
    ['a new one after a told one', { ...facts, noted: 's' }, true],
    ['one from before the latest send', { ...facts, anchor: 100 }, false],
    ['while the human is in the session', { ...facts, lastInputAt: 900_000 }, false],
  ])('%s', (_label, given, due) => {
    expect(neoTurnQuestionDue(question, given, 960_000)).toBe(due);
  });
});

describe('neoTurnQuestionGone', () => {
  test('only when a told question is no longer the live one', () => {
    const live = { turnQuestion: { id: 't', at: 1, text: 'x', actions: [] } };
    expect(neoTurnQuestionGone('t', live)).toBe(false);
    expect(neoTurnQuestionGone('t', {})).toBe(true);
    expect(neoTurnQuestionGone('s', live)).toBe(true);
    expect(neoTurnQuestionGone(undefined, {})).toBe(false);
    expect(neoTurnQuestionGone('t', null)).toBe(false);
  });
});

describe('a todo session waiting on the human', () => {
  const warn = () => {};

  test('tells Neo once with the link, holds sends, and clears when the session runs again', async () => {
    const { runner, told, calls, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    const waiting = {
      ok: true,
      value: {
        status: 'needs_you',
        lastActivityAt: 2_000,
        waitingFor: 'permission prompt',
        link: 'claude://claude.ai/epitaxy/local_x',
      },
    };
    setStatus(waiting);
    await runner.refresh(warn);
    await runner.refresh(warn);
    const notes = told.filter((note) => note.includes('waiting on the human'));
    expect(notes).toEqual([
      'Todo "Rows": its session is waiting on the human (permission prompt). Ask the human once to answer it there: claude://claude.ai/epitaxy/local_x. Do not send to it until it runs again.',
    ]);
    const sends = calls.filter((call) => call.name === 'work.send').length;
    expect(await runner.proceed(todo.id, 'next')).toEqual({
      ok: false,
      reason:
        'needs_you: its session is waiting on the human; ask them to answer it there, then continue.',
    });
    expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(sends);
    setStatus({ ok: true, value: { status: 'running', lastActivityAt: 3_000 } });
    await runner.refresh(warn);
    setStatus(waiting);
    await runner.refresh(warn);
    expect(told.filter((note) => note.includes('waiting on the human'))).toHaveLength(2);
  });

  test('a question the worker ended its turn on goes to Neo, and Neo can answer it', async () => {
    const { runner, told, calls, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    setStatus({
      ok: true,
      value: {
        status: 'needs_you',
        lastActivityAt: 2_000,
        waitingFor: 'Ship it?',
        turnQuestion: {
          id: 'tool-1',
          at: Date.now() + 60_000,
          text: 'Ship it?',
          actions: ['Yes', 'Not now'],
        },
        link: 'claude://claude.ai/epitaxy/local_x',
      },
    });
    await runner.refresh(warn);
    expect(told.filter((note) => note.includes('ended its turn'))).toEqual([
      `Todo "Rows": its session ended its turn with a question: Ship it? Options: Yes; Not now. If the plan, saved rules or your authority settle it, answer with neo.todo.continue. If not, relay it with neo.question.relay {todoId:"${todo.id}",title,options}.`,
    ]);
    const sends = calls.filter((call) => call.name === 'work.send').length;
    expect(await runner.proceed(todo.id, 'Yes, ship it')).toMatchObject({ ok: true });
    expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(sends + 1);
  });

  test('continue reads the session fresh, so a todo closed while it waited is not stuck', async () => {
    const { store, runner, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 2_000 } });
    await runner.refresh(warn);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'done', report: 'Closed' }, 3);
    setStatus({ ok: true, value: { status: 'done', lastActivityAt: 4_000 } });
    expect(await runner.proceed(todo.id, 'next')).toMatchObject({ ok: true });
  });

  test('a worker-blocked todo whose session waits on the human tells Neo too', async () => {
    const { store, runner, told, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'blocked', blockedBy: 'worker', report: 'Stopped', blockedReason: 'x' },
      3
    );
    setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 4_000 } });
    await runner.refresh(warn);
    expect(told.filter((note) => note.includes('waiting on the human'))).toHaveLength(1);
  });
});

describe('neo todo runner uncertainty', () => {
  test('a start that may have opened a session is not retried, and a running session is stopped', async () => {
    const { db, store, add, calls } = setup();
    const todo = add();
    const sessions = new NeoTodoSessionRepository(db);
    const flaky = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions,
      invoke: async (_caller, name, input) => {
        calls.push({ name, input });
        return { kind: 'failed', code: 'execution_failed', message: 'socket hang up' } as never;
      },
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    const result = await flaky.start(todo.id);
    expect(result.ok && result.todo.state).toBe('failed');
    expect(await flaky.retry(todo.id)).toEqual({
      ok: false,
      reason:
        'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.',
    });
    const running = add();
    sessions.recordRef(running.id, ref);
    sessions.recordLive(running.id, 'running', undefined);
    await flaky.stop(store.updateTodo(running, { state: 'done', report: 'Claimed done' }, 5));
    expect(calls.at(-1)).toMatchObject({ name: 'work.stop', input: { ref } });
    const resumed = add();
    sessions.recordRef(resumed.id, ref);
    sessions.recordLive(resumed.id, 'done', undefined);
    const before = calls.length;
    await flaky.stop(store.updateTodo(resumed, { state: 'done' }, 6));
    expect(calls).toHaveLength(before);
    await flaky.stop(store.updateTodo(resumed, { state: 'doing' }, 7));
    expect(calls.at(-1)).toMatchObject({ name: 'work.stop', input: { ref } });
    const unsupported = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions,
      invoke: async () =>
        completed({ ok: false, reason: 'unsupported', detail: 'This adapter cannot stop.' }),
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    expect(await unsupported.stop(store.getTodo(resumed.id)!)).toBeNull();
    const refusing = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions,
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'Offline.' }),
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    expect(await refusing.stop(store.getTodo(resumed.id)!)).toBe('stop_failed: Offline.');
  });
});

describe('requireNeoTodoStartable', () => {
  test('refuses daemon-checked todos and read targets', () => {
    const todo = { state: 'todo', instruction: null } as NeoTodo;
    const ask = { status: 'open' } as never;
    expect(requireNeoTodoStartable({ todo, ask, target: null })).toEqual({
      reason: {
        ok: false,
        reason: 'no_session: this todo has no instruction and target; the daemon checks it.',
      },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'read', operation: 'x', input: {} } as never,
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot read a session.' },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'adopt', ref: { adapter: 'hyperneo', id: 'w' } },
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot adopt a session.' },
    });
  });
});

describe('planNeoTodoSettled', () => {
  test('a stopped session keeps a todo doing with its report; a failure fails it, and the same failure twice blocks it', () => {
    const doing = { state: 'doing', check: { pack: 'coding' }, reason: null } as NeoTodo;
    expect(planNeoTodoSettled(doing, { status: 'reported', report: 'Opened #12' }, 5)).toEqual({
      report: 'Opened #12',
    });
    expect(
      planNeoTodoSettled({ ...doing, check: null }, { status: 'reported', report: 'Done' }, 5)
    ).toEqual({ report: 'Done' });
    expect(planNeoTodoSettled(doing, { status: 'failed', report: 'It stopped.' }, 5)).toEqual({
      state: 'failed',
      reason: 'It stopped.',
      finishedAt: 5,
    });
    expect(
      planNeoTodoSettled(
        { ...doing, reason: 'It stopped.' },
        { status: 'failed', report: 'It stopped.' },
        5
      )
    ).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: It stopped.',
    });
  });
});

describe('planNeoTodoCheck', () => {
  const blocked = {
    reason: 'No progress for 2 hours',
    nextAction: 'Ask the worker what is stuck.',
  };
  test('a passing check finishes an unfinished todo; a failing one fails it', () => {
    const doing = { state: 'doing', reason: null } as NeoTodo;
    expect(planNeoTodoCheck(doing, { done: true, evidence: 'ok' }, 1)).toMatchObject({
      state: 'done',
      evidence: 'ok',
      finishedAt: 1,
    });
    expect(planNeoTodoCheck(doing, { done: false, evidence: null }, 1)).toBeNull();
    expect(
      planNeoTodoCheck(doing, { done: false, evidence: null, failed: '#2 closed' }, 1)
    ).toMatchObject({ state: 'failed', reason: '#2 closed', finishedAt: 1 });
    expect(
      planNeoTodoCheck({ state: 'done' } as NeoTodo, { done: true, evidence: 'ok' }, 1)
    ).toBeNull();
  });

  test('a pack block blocks once and stays until the check passes or fails', () => {
    const doing = { state: 'doing', reason: null } as NeoTodo;
    const patch = planNeoTodoCheck(doing, { done: false, evidence: null, blocked }, 1);
    expect(patch).toEqual({
      state: 'blocked',
      blockedBy: 'check',
      blockedReason: blocked.reason,
      nextAction: blocked.nextAction,
    });
    const held = { ...doing, ...patch } as NeoTodo;
    expect(planNeoTodoCheck(held, { done: false, evidence: null, blocked }, 2)).toBeNull();
    expect(planNeoTodoCheck(held, { done: false, evidence: null }, 2)).toBeNull();
    expect(planNeoTodoCheck(held, { done: true, evidence: 'ok' }, 3)).toMatchObject({
      state: 'done',
    });
    expect(
      planNeoTodoCheck({ ...held, blockedBy: 'worker' }, { done: false, evidence: null }, 2)
    ).toBeNull();
    expect(
      planNeoTodoCheck(
        { ...held, blockedBy: 'worker' },
        { done: false, evidence: null, blocked },
        2
      )
    ).toBeNull();
  });
});

describe('neoTodoNote', () => {
  test('an unverified closure is disclosed instead of described as done or blocked', () => {
    const note = neoTodoNote({
      title: 'T',
      state: 'closed_unverified',
      reason: 'Outcome not checked',
    } as NeoTodo);
    expect(note).toContain('closed unverified');
    expect(note).toContain('Outcome not checked');
    expect(note).not.toContain('is done');
    expect(note).not.toContain('is blocked');
  });

  test('passes on the report without promising Done for an unchecked close', () => {
    expect(
      neoTodoNote({
        title: 'T',
        state: 'doing',
        doneWhen: 'Lane merged',
        check: null,
        report: 'Waiting on CI',
      } as NeoTodo)
    ).toBe(
      'Todo "T" reported, and nothing checks it: record evidence for "Lane merged"; closing it without a passed outcome check leaves it blocked, never done.\nIts report:\nWaiting on CI'
    );
  });

  test('says a failure with its reason', () => {
    expect(neoTodoNote({ title: 'T', state: 'failed', reason: 'gone' } as NeoTodo)).toBe(
      'Todo "T" failed: gone'
    );
  });

  test('says a blocked todo with its reason, next action and last report', () => {
    expect(
      neoTodoNote({
        title: 'T',
        state: 'blocked',
        blockedReason: 'Its session finished its turn; nothing confirms the todo is done yet.',
        nextAction: 'Close it.',
        report: 'Waiting on CI',
      } as NeoTodo)
    ).toBe(
      'Todo "T" is blocked: Its session finished its turn; nothing confirms the todo is done yet.\nNext: Close it.\nIts last report:\nWaiting on CI'
    );
  });
});

describe('a todo sent to an existing session', () => {
  test('starts when its own message is confirmed there, not at the session’s last activity', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: 'm1',
      title: 'Two sends',
      request: 'Send twice',
      createdAt: 1,
    });
    const claude = { adapter: 'claude-desktop', id: 'local_fs3' };
    const lastActivity = Date.parse('2026-10-17T20:14:36Z');
    let confirmedAt = 0;
    const runner = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions,
      invoke: async (_caller, name) =>
        name === 'work.send'
          ? completed({
              ok: true,
              value: {
                delivered: true,
                receipt: { executionId: 'cli-fs3', inputId: `in-${confirmedAt}` },
                confirmedAt,
              },
            })
          : completed({ ok: true, value: { status: 'done', lastActivityAt: lastActivity } }),
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    const sent = (id: string) => {
      const todo = store.addTodo(
        id,
        'ask',
        {
          approvedAt: 1,
          dependsOn: [],
          title: id,
          doneWhen: 'Done',
          check: null,
          instruction: `Do ${id}`,
          named: null,
        },
        1
      );
      sessions.create(todo.id, { verb: 'send', ref: claude });
      return todo;
    };
    for (const [id, at] of [
      ['first', Date.parse('2026-10-17T20:30:00Z')],
      ['second', Date.parse('2026-10-17T21:18:25Z')],
    ] as const) {
      confirmedAt = at;
      await runner.start(sent(id).id);
      expect(sessions.readStartedAt(id)).toBe(at);
    }
    confirmedAt = Date.parse('2026-10-17T21:40:00Z');
    expect(await runner.proceed('second', 'Next step')).toMatchObject({ ok: true });
    expect(sessions.readStartedAt('second')).toBe(confirmedAt);
  });
});

describe('blocked todos', () => {
  const blocked = {
    reason: 'No progress for 2 hours',
    nextAction: 'Ask the worker what is stuck.',
  };
  const warn = () => {};

  test('a pack block is stored once, survives a restart and stays until the check passes', async () => {
    const { db, store, runner, told, add, setResult } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    store.updateTodo(store.getTodo(todo.id)!, { startedAt: null }, 2);
    setResult({ done: false, evidence: null, blocked });
    await runner.checkNow([todo.id], warn);
    await runner.checkNow([todo.id], warn);
    expect(told).toEqual([
      expect.stringContaining('Todo "Rows" is blocked: No progress for 2 hours'),
    ]);
    expect(new NeoAskTodoRepository(db).getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'check',
      blockedReason: blocked.reason,
      nextAction: blocked.nextAction,
    });
    setResult({ done: false, evidence: null });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'check' });
    setResult({ done: true, evidence: '#1 merged' });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'done', blockedReason: null });
    expect(told).toEqual([
      expect.stringContaining('is blocked:'),
      'Todo "Rows" is done: #1 merged',
    ]);
  });

  test('the same failure twice blocks instead of failing, and continuing unblocks it', async () => {
    const { store, runner, told, add, setResult, setStatus } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    setResult({ done: false, evidence: null, failed: 'CI keeps failing' });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'failed', reason: 'CI keeps failing' });
    setStatus({ ok: true, value: { delivered: true } });
    expect(await runner.proceed(todo.id, 'Fix the test.')).toMatchObject({ ok: true });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: CI keeps failing',
    });
    expect(told.at(-1)).toContain('Todo "Rows" is blocked: Failed twice: CI keeps failing');
    await runner.proceed(todo.id, 'Try another approach.');
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });

  test('a session that stops again after a follow-up keeps the todo doing and reports again', async () => {
    const { store, runner, told, add, setStatus, calls } = setup();
    const todo = add();
    await runner.start(todo.id);
    const opening = { at: 1_500, role: 'user', text: String(calls[0].input.message) };
    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        lastReply: 'Opened the PR',
        inputEvidence: observed('Opened the PR', 2000),
        exchange: [opening, { at: 2_000, role: 'agent', text: 'Opened the PR' }],
      },
    });
    await runner.refresh(warn);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'doing', report: 'Pushed a fix' }, 3);
    await runner.refresh(warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
    expect(told.filter((note) => note.includes('nothing checks it'))).toHaveLength(2);
  });

  test('a todo held by its start question still starts, and starting clears the hold', async () => {
    const { store, runner, add } = setup();
    const todo = store.updateTodo(
      add(),
      {
        state: 'blocked',
        blockedBy: 'question',
        blockedReason: 'Waiting for the human to start it.',
      },
      2
    );
    expect(await runner.start(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'doing',
      blockedBy: null,
      blockedReason: null,
    });
  });

  test('settling the ask removes a blocked todo with the rest', () => {
    const { store, add } = setup();
    const todo = add();
    store.updateTodo(todo, { state: 'blocked', blockedBy: 'worker', blockedReason: 'Stopped' }, 2);
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'Not needed', 3);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'removed',
      blockedBy: null,
      blockedReason: null,
    });
  });

  test('a start that fails the same way twice is blocked, and retry starts it again', async () => {
    const { db, store, runner, add, told } = setup();
    const todo = add();
    const failing = createNeoTodoRunner({
      limits: () => ({ running: 99, perGroup: 99 }),
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'login expired' }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      changed: () => {},
    });
    await failing.start(todo.id);
    await failing.retry(todo.id);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: Could not start: unavailable: login expired',
    });
    expect(await runner.retry(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });

  test('a blocked todo closed or ticked done keeps no block', () => {
    const { store, add } = setup();
    const todo = store.updateTodo(
      add(),
      { state: 'blocked', blockedBy: 'worker', blockedReason: 'Stopped', nextAction: 'Close it' },
      2
    );
    expect(store.updateTodo(todo, { state: 'done', evidence: 'Closed' }, 3)).toMatchObject({
      state: 'done',
      blockedBy: null,
      blockedReason: null,
      nextAction: null,
    });
  });

  test('a check block on a todo that never started finishes once its check passes', async () => {
    const { store, runner, told, add, setResult } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    setResult({ done: false, evidence: null, blocked });
    await runner.checkNow([todo.id], warn);
    setResult({ done: true, evidence: '#1 merged' });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'done', blockedBy: null });
    expect(told).toEqual([
      expect.stringContaining('is blocked: No progress for 2 hours'),
      'Todo "Rows" is done: #1 merged',
    ]);
  });
});

describe('stopped worker ladder', () => {
  const MIN = 60_000;

  async function stopped(
    check: NeoTodo['check'] = { pack: 'coding', kind: 'pr_merged', params: {} },
    instruction: string | null = 'Build the rows.',
    beforeInvoke?: (name: string) => void | Promise<void>,
    beforeTell?: () => void
  ) {
    const harness = setup(null, ':memory:', beforeInvoke, beforeTell);
    const todo = harness.add(check, instruction);
    if (instruction) await harness.runner.start(todo.id);
    else {
      harness.sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'w' }, 1_000);
      harness.store.updateTodo(todo, { state: 'doing', startedAt: 1_000, report: 'Working.' }, 1);
    }
    harness.setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        inputEvidence: observed('Pushed the first half.', 2000),
        exchange: [
          { at: 1_500, role: 'user', text: String(harness.calls[0]?.input.message ?? 'Hi') },
          { at: 2_000, role: 'agent', text: 'Pushed the first half.' },
        ],
      },
    });
    await harness.runner.refresh(() => {});
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    const warnings: string[] = [];
    const at = async (minutes: number) => {
      clock.mockReturnValue(base + minutes * MIN);
      await harness.runner.refresh((message, error) => warnings.push(`${message}: ${error}`));
    };
    const sends = () =>
      harness.calls
        .filter((call) => call.name === 'work.send')
        .map((call) => String(call.input.message));
    return { ...harness, todo, at, sends, clock, warnings };
  }

  test('overlapping refreshes send one reminder while delivery is pending', async () => {
    let entered = 0;
    let release!: () => void;
    let firstSend!: () => void;
    let secondSend!: () => void;
    const delivery = new Promise<void>((done) => {
      release = done;
    });
    const firstEntered = new Promise<void>((done) => {
      firstSend = done;
    });
    const secondEntered = new Promise<void>((done) => {
      secondSend = done;
    });
    const h = await stopped(null, 'Build the rows.', async (name) => {
      if (name !== 'work.send') return;
      if (++entered === 1) firstSend();
      else secondSend();
      await delivery;
    });
    try {
      const first = h.at(20);
      await firstEntered;
      const second = h.at(20);
      await Promise.race([second, secondEntered]);
      release();
      await Promise.all([first, second]);
      expect(h.sends()).toHaveLength(1);
      expect(h.sessions.readNudge(h.todo.id)?.nudges).toBe(1);
    } finally {
      release();
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a late reminder completion preserves a newer activity incident', async () => {
    let release!: () => void;
    let sending!: () => void;
    const delivery = new Promise<void>((done) => {
      release = done;
    });
    const entered = new Promise<void>((done) => {
      sending = done;
    });
    const h = await stopped(null, 'Build the rows.', async (name) => {
      if (name !== 'work.send') return;
      sending();
      await delivery;
    });
    try {
      const pending = h.at(20);
      await entered;
      const newer = { since: Date.now(), nudges: 0 };
      h.sessions.recordNudge(h.todo.id, newer);
      release();
      await pending;
      expect(h.sends()).toHaveLength(1);
      expect(h.sessions.readNudge(h.todo.id)).toEqual(newer);
    } finally {
      release();
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a refused stall notice for an unreachable worker releases its reservation so it can retry', async () => {
    let refused = true;
    const h = await stopped(null, 'Build the rows.', undefined, () => {
      if (refused) throw new Error('synthetic notification refusal');
    });
    try {
      h.setSend({ ok: false, reason: 'not_open', notSent: true });
      await h.at(20);
      expect(h.told).toEqual([]);
      expect(h.sessions.readNudge(h.todo.id)?.nudges).toBe(0);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
      refused = false;
      await h.at(20);
      expect(h.told[0]).toContain('did not reach its worker');
      expect(h.store.getTodo(h.todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
      await h.at(21);
      await h.at(22);
      expect(h.told.filter((note) => note.includes('has nobody working on it'))).toHaveLength(1);
      expect(h.store.listQuestions(h.todo.askId).filter((q) => q.state === 'open')).toEqual([]);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a stopped worker is reminded at 20 and 40, then moved to a fresh worker at 60', async () => {
    const h = await stopped();
    try {
      for (const minutes of [19, 20, 39, 40, 59, 60]) await h.at(minutes);
      expect(h.warnings).toEqual([]);
      expect(h.sends()).toEqual([
        expect.stringContaining('stopped for 20 min'),
        expect.stringContaining('stopped for 40 min'),
      ]);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(2);
      expect(h.told).toEqual([expect.stringContaining('moved it to a fresh worker')]);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test.each([
    ['unreachable', 'remote send timed out'],
    ['not_delivered', 'thread-follower-steer-turn-timeout'],
  ])(
    'a reminder whose delivery is uncertain (%s) keeps the todo going and tells Neo',
    async (reason, detail) => {
      const h = await stopped(null);
      try {
        h.setSend({ ok: false, reason, detail });
        await h.at(20);
        expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
        expect(h.told.filter((note) => note.includes('could not be reached'))).toHaveLength(1);
      } finally {
        h.clock.mockRestore();
        h.db.close();
      }
    }
  );

  test('an unreachable worker is reminded once, then the todo stalls instead of being reminded again', async () => {
    const h = await stopped(null);
    try {
      h.setSend({ ok: false, reason: 'not_open', notSent: true });
      await h.at(20);
      await h.at(40);
      expect(h.sends()).toHaveLength(1);
      expect(h.told.filter((note) => note.includes('stalled'))).toEqual([
        expect.stringContaining('did not reach its worker (not_open)'),
      ]);
      expect(h.store.getTodo(h.todo.id)?.blockedBy).toBe('stalled');
      expect(h.warnings).toEqual([]);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a todo without a check follows the same ladder and then stalls', async () => {
    const h = await stopped(null);
    try {
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toHaveLength(2);
      expect(h.store.getTodo(h.todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
      expect(h.told.filter((note) => note.includes('stalled'))).toHaveLength(1);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('open PRs use ledger reminders only', async () => {
    const h = await stopped(null);
    try {
      h.setPrOpen(true);
      const count = h.told.length;
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toHaveLength(0);
      expect(h.told).toHaveLength(count);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('an asynchronous false waiting result permits the worker reminder ladder', async () => {
    const h = await stopped(null);
    try {
      h.setPrOpen(Promise.resolve(false));
      for (const minutes of [20, 40, 60]) await h.at(minutes);
      expect(h.warnings).toEqual([]);
      expect(h.sends()).toHaveLength(2);
      expect(h.told.filter((note) => note.includes('fresh worker'))).toHaveLength(1);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a waiting decision is awaited and short-circuits later pack hooks', async () => {
    const h = await stopped(null);
    let release!: (waiting: boolean) => void;
    const waiting = new Promise<boolean>((done) => {
      release = done;
    });
    const later: string[] = [];
    h.packs.push({
      ...h.packs[0],
      id: 'later',
      todos: {
        ...h.packs[0].todos!,
        waiting: () => {
          later.push('called');
          return false;
        },
      },
    });
    try {
      h.setPrOpen(waiting);
      let settled = false;
      const pending = h.at(20).then(() => {
        settled = true;
      });
      await new Promise((done) => setImmediate(done));
      const beforeReply = { settled, sends: h.sends().length, later: [...later] };
      release(true);
      await pending;
      expect(beforeReply).toEqual({ settled: false, sends: 0, later: [] });
      expect(later).toEqual([]);
      expect(h.sends()).toEqual([]);
      expect(h.warnings).toEqual([]);
    } finally {
      release(true);
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a failed waiting read sends no worker reminder and reports the failure', async () => {
    const h = await stopped(null);
    try {
      h.packs[0].todos!.waiting = async () => {
        throw new Error('synthetic waiting read refusal');
      };
      await h.at(20);
      expect(h.sends()).toEqual([]);
      expect(h.warnings).toEqual([expect.stringContaining('synthetic waiting read refusal')]);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a todo without an instruction idle for hours stalls with no fresh worker', async () => {
    const h = await stopped(null, null);
    try {
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toEqual([]);
      expect(h.calls.filter((call) => call.name === 'work.start')).toEqual([]);
      expect(h.store.getTodo(h.todo.id)).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });
});

describe('planNudge', () => {
  test('the single ladder reminds at 20/40, escalates at 60 and remains quiet', () => {
    const at = (minutes: number, nudges: number) =>
      planNudge({ since: 0, nudges }, minutes * 60_000);
    expect(at(19, 0)).toBeNull();
    expect(at(20, 0)).toEqual({ kind: 'remind', nudges: 1 });
    expect(at(39, 1)).toBeNull();
    expect(at(40, 1)).toEqual({ kind: 'remind', nudges: 2 });
    expect(at(60, 2)).toEqual({ kind: 'escalate', nudges: 3 });
    expect(at(300, 3)).toBeNull();
  });
});

describe('current explicit removal behavior before recompute', () => {
  const remove = (h: ReturnType<typeof setup>, todoId: string) => {
    const operation = createNeoTodoOperations(
      h.store,
      h.sessions,
      { ...h.runner, resolveTarget: async (ref) => ({ value: ref }) },
      () => [],
      () => null
    ).find((operation) => operation.name === 'neo.todo.remove')!;
    return operation.execute(operation.inputSchema.parse({ todoId, reason: 'Synthetic removal' }), {
      source: 'mcp',
      sessionId: 'neo',
      role: 'neo',
    });
  };

  test('removal prunes only its pending start choice and cannot be applied twice', async () => {
    const h = setup();
    try {
      const removed = h.add(),
        remaining = h.add();
      for (const todo of [removed, remaining])
        h.store.updateTodo(todo, { approvedAt: null }, Date.now());
      h.store.joinStartQuestion(removed, Date.now());
      h.store.joinStartQuestion(remaining, Date.now());
      const question = h.store.listQuestions('ask').find((question) => question.kind === 'start')!;
      expect(question.startTodos).toEqual([removed.id, remaining.id]);
      expect(await remove(h, removed.id)).toMatchObject({ ok: true, todo: { state: 'removed' } });
      expect(h.store.getQuestion(question.id)).toMatchObject({
        state: 'open',
        startTodos: [remaining.id],
      });
      expect(h.store.listTodos('ask').map(({ id, state }) => ({ id, state }))).toEqual([
        { id: removed.id, state: 'removed' },
        { id: remaining.id, state: 'todo' },
      ]);
      expect(await remove(h, removed.id)).toMatchObject({ ok: false });
      expect(h.store.getQuestion(question.id)?.startTodos).toEqual([remaining.id]);
    } finally {
      h.db.close();
    }
  });

  test('a stop refusal leaves the working todo and its complete report unchanged', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const report = 'Complete worker result 🦊\n'.repeat(4000);
      h.store.updateTodo(h.store.getTodo(todo.id)!, { report }, Date.now());
      const before = h.store.getTodo(todo.id);
      h.setStatus({ ok: false, reason: 'synthetic_stop_refused' });
      expect(await remove(h, todo.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('synthetic_stop_refused'),
      });
      expect(h.store.getTodo(todo.id)).toEqual(before);
      expect(h.calls.filter((call) => call.name === 'work.stop')).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('reused worker activity and restart cannot revive a removed todo or discard its report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-todo-removal-pin-'));
    const path = join(dir, 'synthetic.db');
    const h = setup(null, path);
    let closed = false;
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const report = 'Complete previous result 🦊\n'.repeat(4000);
      h.store.updateTodo(h.store.getTodo(todo.id)!, { report }, Date.now());
      expect(await remove(h, todo.id)).toMatchObject({ ok: true });
      const removed = h.store.getTodo(todo.id);
      const sibling = h.add();
      await h.runner.start(sibling.id);
      expect(h.sessions.readRef(sibling.id)).toEqual(h.sessions.readRef(todo.id));
      h.setStatus({ ok: true, value: { status: 'running', lastActivityAt: Date.now() } });
      await h.runner.refresh(() => {});
      expect(h.store.getTodo(todo.id)).toEqual(removed);
      h.db.close();
      closed = true;
      const db = new Database(path);
      try {
        const store = new NeoAskTodoRepository(db),
          sessions = new NeoTodoSessionRepository(db);
        const effects: string[] = [];
        const runner = createNeoTodoRunner({
          limits: () => ({ running: 99, perGroup: 99 }),
          write: gatewayFor(db).run.bind(gatewayFor(db)),
          store,
          sessions,
          packs: () => [],
          invoke: async (_caller, name) => {
            effects.push(name);
            return completed({
              ok: true,
              value: { status: 'running', lastActivityAt: Date.now() },
            });
          },
          tell: async () => {},
          changed: () => {},
        });
        await runner.refresh(() => {});
        await runner.refresh(() => {});
        expect(await runner.start(todo.id)).toMatchObject({ ok: false });
        expect(await runner.proceed(todo.id, 'Stale continuation')).toMatchObject({
          ok: true,
          records: [expect.stringContaining('not_started:')],
        });
        expect(await runner.retry(todo.id)).toMatchObject({
          ok: true,
          records: [expect.stringContaining('not_retryable:')],
        });
        expect(store.getTodo(todo.id)).toEqual(removed);
        expect(store.getTodo(todo.id)?.report).toBe(report);
        expect(store.getTodo(sibling.id)?.state).toBe('doing');
        expect(
          effects.filter((name) => ['work.start', 'work.send', 'work.stop'].includes(name))
        ).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      if (!closed) h.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('failed todo retry in place', () => {
  test('reuses the todo and worker with a fresh durable input attempt', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const original = h.sessions.inputs.list(todo.id)[0];
      h.store.updateTodo(
        h.store.getTodo(todo.id)!,
        { state: 'failed', reason: 'Synthetic failure', report: 'Prior failure report' },
        3
      );
      h.setStatus({ ok: true, value: { status: 'failed', lastActivityAt: 2000 } });
      const result = await h.runner.retry(todo.id);
      expect(result).toMatchObject({
        ok: true,
        todo: { id: todo.id, state: 'doing' },
      });
      expect(h.store.listTodos('ask')).toHaveLength(1);
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
      expect(h.calls.at(-1)).toMatchObject({ name: 'work.send', input: { ref } });
      const inputs = h.sessions.inputs.list(todo.id);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toEqual(original);
      expect(inputs[1].id).not.toBe(original.id);
      expect(h.sessions.readRetries(todo.id)).toBe(1);
    } finally {
      h.db.close();
    }
  });
});

describe('worker final-line blockers', () => {
  test.each(['needs_human', 'environment'] as const)(
    'routes %s to its todo without nudging the worker',
    async (kind) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const dispatch = h.sessions.inputs.list(todo.id)[0];
        const message = `Work is unfinished.\nBlocked (${kind}): Awaiting a synthetic prerequisite${kind === 'needs_human' ? '\r\n' : ''}`;
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: dispatch.acceptedAt + 100,
            turnEnds: [{ id: 'blocker-turn', at: dispatch.acceptedAt + 100, message }],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.store.getTodo(todo.id)).toMatchObject({
          state: 'blocked',
          blockedBy: kind === 'needs_human' ? 'needs-human' : 'environment',
          blockedReason: 'Awaiting a synthetic prerequisite',
          report: message,
        });
        const questions = h.store
          .listQuestions('ask')
          .filter((q) => q.todoId === todo.id && q.state === 'open');
        expect(questions).toHaveLength(0);
        if (kind === 'needs_human') {
          const wake = h.told.filter((text) => text.includes('If you can answer this'));
          expect(wake).toHaveLength(1);
          expect(wake[0]).toContain(`todo ${todo.id}`);
          expect(wake[0]).toContain('Awaiting a synthetic prerequisite');
          expect(wake[0]).toContain(
            'neo.question.ask (yesno or choice with options) linked to this todo.'
          );
        }
        expect(h.calls.filter((c) => c.name === 'work.send')).toHaveLength(0);
        await h.runner.refresh(() => {});
        expect(
          h.store.listQuestions('ask').filter((q) => q.todoId === todo.id && q.state === 'open')
        ).toHaveLength(questions.length);
      } finally {
        h.db.close();
      }
    }
  );
  test.each(['unchanged', 'edited', 'question', 'closed', 'new-input'] as const)(
    'reminds Neo once after an untouched hour and never opens a card: %s',
    async (action) => {
      const h = setup(false);
      const clock = vi.spyOn(Date, 'now');
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const input = h.sessions.inputs.list(todo.id)[0];
        const start = Date.now() + 100;
        clock.mockReturnValue(start);
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: start,
            turnEnds: [
              {
                id: 'triage',
                at: start,
                message: 'Blocked (needs_human): Awaiting Neo confirmation',
              },
            ],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.store.listQuestions('ask').filter((q) => q.todoId === todo.id)).toHaveLength(0);
        const waiting = h.store.getTodo(todo.id)!;
        clock.mockReturnValue(start + 1);
        await h.runner.recompute(waiting);
        expect(h.store.getTodo(todo.id)?.updatedAt).toBe(waiting.updatedAt);
        clock.mockReturnValue(start + 60 * 60_000 - 1);
        await h.runner.refresh(() => {});
        expect(h.store.listQuestions('ask').filter((q) => q.todoId === todo.id)).toHaveLength(0);
        if (action === 'edited')
          h.store.updateTodo(h.store.getTodo(todo.id)!, { title: 'Neo acted' }, Date.now());
        if (action === 'question')
          h.store.askQuestion(
            'neo-choice',
            'ask',
            {
              text: 'Approve this?',
              kind: 'yesno',
              options: null,
              multiple: false,
              noLabel: null,
              yesLabel: null,
              startTodos: null,
              todoId: todo.id,
              document: null,
            },
            Date.now()
          );
        if (action === 'closed')
          h.store.updateTodo(h.store.getTodo(todo.id)!, { state: 'removed' }, Date.now());
        if (action === 'new-input')
          await h.sessions.inputs.accept(
            todo.id,
            'neo',
            { verb: 'send', ref },
            'Neo replied',
            Date.now()
          );
        clock.mockReturnValue(start + 60 * 60_000);
        await h.runner.refresh(() => {});
        const open = h.store
          .listQuestions('ask')
          .filter((q) => q.todoId === todo.id && q.state === 'open');
        expect(open).toHaveLength(action === 'question' ? 1 : 0);
        if (action === 'edited') expect(h.store.getTodo(todo.id)?.blockedBy).toBe('needs-human');
        const reminders = () => h.told.filter((note) => note.includes('still waits on'));
        expect(reminders()).toHaveLength(action === 'unchanged' ? 1 : 0);
        if (action === 'unchanged') {
          expect(reminders()[0]).toContain('Awaiting Neo confirmation');
          expect(reminders()[0]).toContain('neo.question.relay');
          await h.runner.refresh(() => {});
          expect(reminders()).toHaveLength(1);
          expect(h.store.listQuestions('ask').filter((q) => q.todoId === todo.id)).toHaveLength(0);
        }
        expect(h.calls.filter((c) => c.name === 'work.send')).toHaveLength(0);
      } finally {
        clock.mockRestore();
        h.db.close();
      }
    }
  );
  test.each([
    'Blocked (needs_human): Approval\nMore text',
    '> Blocked (needs_human): Approval',
    ' Blocked (needs_human): Approval',
    'Blocked (needs_human): Approval\n\n',
    'blocked (needs_human): Approval',
    'Blocked (needs-human): Approval',
    'Blocked (environment):',
    'Blocked (environment):   ',
    'Ordinary report',
  ])('leaves non-contract prose unchanged: %s', async (message) => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const dispatch = h.sessions.inputs.list(todo.id)[0];
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: dispatch.acceptedAt + 100,
          turnEnds: [{ id: 'ordinary-turn', at: dispatch.acceptedAt + 100, message }],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.store.getTodo(todo.id)).toMatchObject({
        state: 'doing',
        blockedBy: null,
        report: null,
      });
      expect(h.store.listQuestions('ask').filter((q) => q.todoId === todo.id)).toHaveLength(0);
    } finally {
      h.db.close();
    }
  });
});

function askForWorker(h: ReturnType<typeof setup>, todoId: string) {
  const question = h.store.askQuestion(
    crypto.randomUUID(),
    'ask',
    {
      text: 'Approve it?',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: null,
      todoId,
      document: null,
    },
    Date.now()
  );
  h.store.questionAnswers.bind(question.id, todoId, {
    ...workerIdentity(ref, null),
    provider: ref.adapter,
    link: null,
  });
  return question;
}

describe('worker blocker ownership', () => {
  test.each(['focused', 'old-input', 'held', 'replaced'] as const)(
    'ignores a %s report',
    async (guard) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const input = h.sessions.inputs.list(todo.id)[0],
          current = h.store.getTodo(todo.id)!;
        if (guard === 'focused')
          h.store.focusAsk(
            'ask',
            { ...ref, name: null, label: 'Worker', provider: 'claude', link: null },
            Date.now()
          );
        if (guard === 'held')
          h.store.updateTodo(current, { state: 'blocked', blockedBy: 'held' }, Date.now());
        if (guard === 'replaced')
          h.sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'replacement' }, Date.now());
        const at = input.acceptedAt + (guard === 'old-input' ? -1 : 100);
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: at,
            turnEnds: [{ id: 'stale', at, message: 'Blocked (needs_human): Stale approval' }],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.store.getTodo(todo.id)?.blockedBy).not.toBe('needs-human');
        expect(h.store.listQuestions('ask').filter((q) => q.todoId === todo.id)).toHaveLength(0);
      } finally {
        h.db.close();
      }
    }
  );
  test('releases a prior question answered after worker triage', async () => {
    const h = setup(false),
      clock = vi.spyOn(Date, 'now');
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const start = Date.now(),
        source = { ...ref, name: null, label: 'Worker', provider: 'hyperneo', link: null };
      const question = h.store.askQuestion(
        'older-card',
        'ask',
        {
          text: 'Prior approval?',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          todoId: todo.id,
          sourceSession: source,
        },
        start
      );
      h.store.questionAnswers.bind(question.id, todo.id, source);
      clock.mockReturnValue(start + 100);
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: start + 100,
          turnEnds: [
            {
              id: 'older-question',
              at: start + 100,
              message: 'Blocked (needs_human): Prior approval',
            },
          ],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.store.getTodo(todo.id)?.blockedBy).toBe('needs-human');
      clock.mockReturnValue(start + 200);
      h.store.answerQuestion(question, 'Approved', 'chat', Date.now());
      await createNeoQuestionAnswerDelivery(
        h.store,
        h.sessions,
        async () => completed({ ok: true, value: { delivered: true } }),
        async () => {},
        h.runner.recompute,
        (error) => {
          throw error;
        }
      )(question.id);
      expect(h.store.getTodo(todo.id)?.blockedBy).not.toBe('needs-human');
      clock.mockReturnValue(start + 61 * 60_000);
      await h.runner.refresh(() => {});
      expect(
        h.store.listQuestions('ask').filter((q) => q.todoId === todo.id && q.state === 'open')
      ).toHaveLength(0);
    } finally {
      clock.mockRestore();
      h.db.close();
    }
  });
  test('does not re-ask while an answered card cannot reach the worker', async () => {
    const h = setup(false);
    const clock = vi.spyOn(Date, 'now');
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const input = h.sessions.inputs.list(todo.id)[0],
        start = Date.now() + 100;
      clock.mockReturnValue(start);
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: start,
          turnEnds: [
            { id: 'answer-pending', at: start, message: 'Blocked (needs_human): Approval needed' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      clock.mockReturnValue(start + 60 * 60_000);
      const question = askForWorker(h, todo.id);
      h.store.answerQuestion(question, 'Approved', 'chat', Date.now());
      await createNeoQuestionAnswerDelivery(
        h.store,
        h.sessions,
        async () => completed({ kind: 'rejected', reason: 'Synthetic transport failure' }),
        async () => {},
        h.runner.recompute,
        (error) => {
          throw error;
        }
      )(question.id);
      expect(h.store.questionAnswers.pending().filter((r) => r.todoId === todo.id)).toHaveLength(1);
      clock.mockReturnValue(start + 61 * 60_000);
      await h.runner.refresh(() => {});
      await h.runner.refresh(() => {});
      expect(
        h.store.listQuestions('ask').filter((q) => q.todoId === todo.id && q.state === 'open')
      ).toHaveLength(0);
      expect(
        h.store.listQuestions('ask').filter((q) => q.todoId === todo.id && q.state === 'answered')
      ).toHaveLength(1);
      expect(h.store.getTodo(todo.id)?.blockedBy).toBe('needs-human');
      expect(h.calls.filter((c) => c.name === 'work.send')).toHaveLength(0);
    } finally {
      clock.mockRestore();
      h.db.close();
    }
  });
  test('keeps an answered blocker from reopening after incident reset', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const input = h.sessions.inputs.list(todo.id)[0];
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: input.acceptedAt + 100,
          turnEnds: [
            { id: 'once', at: input.acceptedAt + 100, message: 'Blocked (needs_human): Approval' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      const question = askForWorker(h, todo.id);
      h.store.answerQuestion(question, 'Approved', 'chat', Date.now());
      await createNeoQuestionAnswerDelivery(
        h.store,
        h.sessions,
        async () => completed({ ok: true, value: { delivered: true } }),
        async () => {},
        h.runner.recompute,
        (error) => {
          throw error;
        }
      )(question.id);
      h.sessions.recordNudge(todo.id, { since: Date.now(), nudges: 0 });
      await h.runner.refresh(() => {});
      expect(
        h.store.listQuestions('ask').filter((q) => q.todoId === todo.id && q.state === 'open')
      ).toHaveLength(0);
      expect(h.store.getTodo(todo.id)?.blockedBy).not.toBe('needs-human');
    } finally {
      h.db.close();
    }
  });
});

describe('a todo for a busy worker', () => {
  const MIN = 60_000;
  const waitingOn = (h: ReturnType<typeof setup>, priority?: 'high') => {
    const todo = h.add();
    h.sessions.queueOn(todo.id, ref, 'Build the rows.');
    return priority ? h.store.updateTodo(todo, { priority }, 2) : todo;
  };
  const sends = (h: ReturnType<typeof setup>) => h.calls.filter((c) => c.name === 'work.send');
  const running = { ok: true, value: { status: 'running', lastActivityAt: 1 } };
  const idle = { ok: true, value: { status: 'done', lastActivityAt: 2 } };

  test('stays todo with its reason, then goes one per turn by priority', async () => {
    const h = setup();
    try {
      const low = waitingOn(h);
      const high = waitingOn(h, 'high');
      h.setStatus(running);
      await h.runner.refresh(() => {});
      expect(sends(h)).toEqual([]);
      for (const { id } of [low, high]) {
        const todo = h.store.getTodo(id)!;
        expect(todo).toMatchObject({ state: 'todo', startedAt: null });
        expect(todo.reason).toBe(
          'Waiting for worker hyperneo:worker-1, which is working on something outside a todo.'
        );
      }

      h.setStatus(idle);
      await h.runner.refresh(() => {});
      expect(sends(h)).toHaveLength(1);
      expect(sends(h)[0].input.todoId).toBe(high.id);
      expect(h.store.getTodo(high.id)).toMatchObject({ state: 'doing', reason: null });
      h.setStatus(running);
      await h.runner.refresh(() => {});
      expect(sends(h)).toHaveLength(1);
      expect(h.store.getTodo(low.id)?.reason).toContain(`working on "${high.title}"`);
    } finally {
      h.db.close();
    }
  });

  test('queueOn says what it did with the message', () => {
    const h = setup();
    try {
      const withInstruction = h.add();
      expect(h.sessions.queueOn(withInstruction.id, ref, 'Other text')).toBe('instruction');
      expect(h.store.getTodo(withInstruction.id)?.instruction).toBe('Build the rows.');
      const empty = h.add(null, null);
      expect(h.sessions.queueOn(empty.id, ref, 'New text')).toBe('message');
      expect(h.store.getTodo(empty.id)?.instruction).toBe('New text');
      const doing = h.store.updateTodo(h.add(), { state: 'doing', startedAt: 1 }, 1);
      expect(h.sessions.queueOn(doing.id, ref, 'Lost text')).toBe('none');
    } finally {
      h.db.close();
    }
  });

  test('a todo counts as on its worker only while it is open there', () => {
    const h = setup();
    try {
      const todo = h.add();
      h.sessions.recordRef(todo.id, ref, 1);
      const doing = h.store.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
      expect(h.sessions.sendsNow(doing.id, ref)).toBe(true);
      const blocked = h.store.updateTodo(doing, { state: 'blocked', blockedBy: 'check' }, 2);
      expect(h.sessions.sendsNow(blocked.id, ref)).toBe(true);
      h.store.updateTodo(blocked, { state: 'failed', finishedAt: 3 }, 3);
      expect(h.sessions.sendsNow(todo.id, ref)).toBe(false);
    } finally {
      h.db.close();
    }
  });

  test('a send naming no todo is not a todo send, so it goes', () => {
    const h = setup();
    try {
      expect(h.sessions.sendsNow('https://github.com/o/r/pull/1', ref)).toBe(true);
    } finally {
      h.db.close();
    }
  });

  test('a wait keeps the mark that the todo was already moved once', async () => {
    const h = setup();
    try {
      const todo = waitingOn(h);
      h.sessions.recordNudge(todo.id, { since: 1, nudges: 0, redispatched: true });
      h.setStatus(running);
      await h.runner.refresh(() => {});
      expect(h.sessions.readNudge(todo.id)?.redispatched).toBe(true);
    } finally {
      h.db.close();
    }
  });

  test('a direct start waits too', async () => {
    const h = setup();
    try {
      const todo = waitingOn(h);
      h.setStatus(running);
      const started = await h.runner.start(todo.id);
      expect(started).toMatchObject({ ok: true, todo: { state: 'todo', startedAt: null } });
      expect(sends(h)).toEqual([]);
      expect(h.store.getTodo(todo.id)?.reason).toContain('Waiting for worker');
    } finally {
      h.db.close();
    }
  });

  test('a worker that stays busy tells Neo once, and the todo keeps waiting', async () => {
    const h = setup();
    const clock = vi.spyOn(Date, 'now');
    const base = Date.now();
    try {
      const todo = waitingOn(h);
      h.setStatus(running);
      for (const minutes of [0, 59, 60, 61]) {
        clock.mockReturnValue(base + minutes * MIN);
        await h.runner.refresh(() => {});
        expect(h.told.filter((note) => note.includes('is stalled'))).toHaveLength(
          minutes < 60 ? 0 : 1
        );
      }
      expect(h.store.getTodo(todo.id)?.state).toBe('todo');
    } finally {
      clock.mockRestore();
      h.db.close();
    }
  });

  test('a worker waiting on the human still gets its todo, as before', async () => {
    const h = setup();
    try {
      waitingOn(h);
      h.setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 1 } });
      await h.runner.refresh(() => {});
      expect(sends(h)).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });
});

describe('refresh worker status gate', () => {
  test('reads a synced worker only when it changed, and an unsynced one every time', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const ref = h.sessions.readRef(todo.id)!;
      h.db.prepare('UPDATE neo_todo_sessions SET started_at = 1 WHERE todo_id = ?').run(todo.id);
      h.setStatus({ ok: true, value: { status: 'running', lastActivityAt: 1 } });
      const reads = () => h.calls.filter((call) => call.name === 'work.status').length;
      const sync = (at: number) =>
        h.db
          .prepare(
            `INSERT OR REPLACE INTO work_sessions
             (adapter, id, name, status, last_activity_at, updated_at) VALUES (?, ?, 'W', 'running', ?, 0)`
          )
          .run(ref.adapter, ref.id, at);

      const start = reads();
      await h.runner.refresh(() => {});
      const unsynced = reads();
      expect(unsynced).toBeGreaterThan(start);
      await h.runner.refresh(() => {});
      expect(reads()).toBeGreaterThan(unsynced);

      sync(5);
      await h.runner.refresh(() => {});
      const first = reads();
      await h.runner.refresh(() => {});
      expect(reads()).toBe(first);

      sync(6);
      await h.runner.refresh(() => {});
      expect(reads()).toBeGreaterThan(first);
    } finally {
      h.db.close();
    }
  });
});
