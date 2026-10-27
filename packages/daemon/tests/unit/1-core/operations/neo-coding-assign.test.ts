import { afterEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { CodingAssignmentsRepository } from '../../../../src/lib/neo/packs/coding/assignments.ts';
import { createCodingAssignmentOperation } from '../../../../src/lib/neo/packs/coding/assign-operation.ts';
import { runCodingReview } from '../../../../src/lib/neo/packs/coding/review.ts';
import { StartWorkInputSchema } from '../../../../src/lib/drivers/work-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation, type OperationOutcome } from '../../../../src/lib/operations/invoke.ts';

const initialPath = process.env.PATH;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.env.PATH = initialPath;
});
const url = 'https://github.com/synthetic/actors/pull/7';
const head = 'a'.repeat(40),
  next = 'b'.repeat(40);
const write = { adapter: 'codex-desktop', id: 'author' };
const place = { machine: 'fixture', name: 'Fixture' };
const author = { adapter: write.adapter, place, model: 'gpt-6' };
const reviewer = { adapter: 'claude-code', place, model: 'claude-opus-5-5' };
type Start = z.infer<typeof StartWorkInputSchema>;
function fixture(
  simulate?: (input: Start, count: number) => Promise<OperationOutcome> | OperationOutcome
) {
  const root = mkdtempSync(join(tmpdir(), 'neo-actor-'));
  const pr = {
    body: 'Agent: gpt-6-sol (effort: high) via codex-desktop',
    headRefOid: head,
    state: 'OPEN',
  };
  const publish = () => writeFileSync(join(root, 'pr.json'), JSON.stringify(pr));
  publish();
  writeFileSync(
    join(root, 'gh'),
    `#!${process.execPath}\nimport{readFileSync}from'node:fs';if(process.argv[2]!=='pr'||process.argv[3]!=='view')process.exit(1);process.stdout.write(readFileSync(${JSON.stringify(join(root, 'pr.json'))},'utf8'));`,
    { mode: 0o700 }
  );
  process.env.PATH = `${root}:${initialPath}`;
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES ('ask','neo-fixture','Actors','Actors',1,1); INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo','ask',1,'Actors','Merged','doing',1,1)"
  );
  const ledger = new CodingPrLedgerRepository(db),
    todos = new CodingTodoPrRepository(db),
    assignments = new CodingAssignmentsRepository(db),
    sessions = new NeoTodoSessionRepository(db);
  sessions.bind('todo', write, 1);
  todos.claim('todo', [{ url, claim: 'named' }], 1);
  ledger.stageFacts.observeHead(url, head, 1);
  const starts: Start[] = [],
    stops: unknown[] = [];
  const success = (input: Start, count: number): OperationOutcome => ({
    kind: 'completed',
    value: {
      ok: true,
      value: {
        ref: { adapter: input.adapter, id: `fresh-${count}` },
        title: input.title,
        place: input.place,
        status: 'running',
        lastActivityAt: 1,
        model: input.model ?? reviewer.model,
        effort: input.effort,
      },
    },
  });
  const registry = createOperationRegistry([
    createCodingAssignmentOperation({
      db,
      ledger,
      todos,
      review: runCodingReview,
      invoke: async (name, input) => {
        if (name === 'work.stop') {
          stops.push(input);
          return { kind: 'completed', value: { ok: true, value: { stopped: true } } };
        }
        expect(name).toBe('work.start');
        const request = StartWorkInputSchema.parse(input);
        starts.push(request);
        return simulate ? simulate(request, starts.length) : success(request, starts.length);
      },
    }),
  ]);
  const assign = async (patch: Record<string, unknown> = {}) => {
    const outcome = await invokeOperation(
      registry,
      'neo.coding.assign',
      {
        todoId: 'todo',
        url,
        head,
        acceptanceContract: 'artifact:contract',
        stage: 'review',
        candidates: [author, reviewer],
        ...patch,
      },
      { source: 'internal', role: 'neo' }
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    return outcome.value as {
      ok: boolean;
      reason?: string;
      assignment?: ReturnType<typeof assignments.read>['review'];
    };
  };
  const set = (key: string, value: unknown) =>
    db
      .prepare(`INSERT INTO neo_pack_preferences
    (pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES ('coding','repo','synthetic/actors',?,?,'human',1)
    ON CONFLICT DO UPDATE SET value_json=excluded.value_json`)
      .run(key, JSON.stringify(value));
  return { db, ledger, assignments, sessions, assign, starts, stops, pr, publish, set, success };
}

describe('coding actor assignments', () => {
  test.each([
    'unsupported_model',
    'unsupported_effort',
    'unsupported_preparation',
    'unknown_adapter',
  ] as const)(
    'an unavailable default (%s) is attempted once after a cloned read-only plan reply',
    async (reason) => {
      const f = fixture(() => ({
        kind: 'completed',
        value: { ok: false, reason, detail: 'Synthetic default unavailable' },
      }));
      const gateway = new DbGateway(':memory:', f.db);
      const run = gateway.run.bind(gateway);
      gateway.run = (async (op, args) => {
        f.db.exec('PRAGMA query_only=ON');
        try {
          return structuredClone(await run(op, args));
        } finally {
          f.db.exec('PRAGMA query_only=OFF');
        }
      }) as typeof gateway.run;
      bindGateway(f.db, gateway);
      try {
        expect(await f.assign({ candidates: [reviewer] })).toMatchObject({
          ok: false,
          reason: expect.stringContaining(reason),
        });
        expect(f.starts).toHaveLength(1);
        expect(f.assignments.read('todo', url, head)).toEqual({});
      } finally {
        await gateway.close();
      }
    }
  );
  test('configured bot suppresses all reviewer starts, including explicit human/preferences, but permits independent Verify', async () => {
    const f = fixture();
    f.set('reviewBot', 'fixture-bot');
    f.set('review.model', 'unavailable');
    const review = await f.assign({ human: 'human-reviewer', candidates: [] });
    expect(review).toMatchObject({ ok: true, assignment: { bot: 'fixture-bot', write } });
    expect(f.starts).toHaveLength(0);
    const verify = await f.assign({ stage: 'verify', candidates: [author] });
    expect(verify).toMatchObject({
      ok: true,
      assignment: { ref: { adapter: author.adapter, id: 'fresh-1' } },
    });
    expect(f.starts[0].title).toContain('Verify');
    expect(f.starts[0].message).toContain("repository's .claude/skills/verify/SKILL.md");
    expect(f.starts[0].preparation).toEqual({
      pack: 'coding',
      parameters: { pullRequest: 7, head, role: 'verify' },
    });
  });
  test.each([true, false])(
    'a PR from a fork (%s) asks for the worker sandbox on its Review and Verify starts',
    async (fork) => {
      const f = fixture();
      Object.assign(f.pr, { isCrossRepository: fork });
      f.publish();
      await f.assign();
      await f.assign({ stage: 'verify', candidates: [author] });
      expect(f.starts.map((start) => start.preparation?.sandbox)).toEqual(
        fork ? [true, true] : [undefined, undefined]
      );
    }
  );
  test('one todo keeps its author and linked fresh reviewer/Verify; repeated calls reuse exact-head assignments', async () => {
    const f = fixture();
    const review = await f.assign();
    const verify = await f.assign({ stage: 'verify', candidates: [author] });
    expect(review).toMatchObject({
      ok: true,
      assignment: {
        actor: { model: reviewer.model, harness: reviewer.adapter },
        ref: { id: 'fresh-1' },
      },
    });
    expect(verify).toMatchObject({ ok: true, assignment: { ref: { id: 'fresh-2' } } });
    await f.assign();
    await f.assign({ stage: 'verify' });
    expect(f.starts).toHaveLength(2);
    expect(f.sessions.readCard('todo')?.ref).toEqual(write);
    expect(f.db.prepare('SELECT id,state FROM neo_todos').all()).toEqual([
      { id: 'todo', state: 'doing' },
    ]);
    expect(Object.keys(f.assignments.read('todo', url, head))).toEqual(['qa', 'review']);
  });
  test('an explicit human is an alternative with no reviewer session', async () => {
    const f = fixture();
    expect(await f.assign({ human: 'human-reviewer', candidates: [] })).toMatchObject({
      ok: true,
      assignment: {
        actor: { kind: 'human', id: 'human-reviewer' },
        ref: { adapter: 'human', id: 'human-reviewer' },
      },
    });
    expect(f.starts).toHaveLength(0);
    expect((await f.assign({ stage: 'verify', candidates: [author] })).ok).toBe(true);
  });
  test('missing provenance and same-model review cannot launch; explicit opt-out permits the default', async () => {
    const f = fixture();
    f.pr.body = '';
    f.publish();
    expect(await f.assign()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('author_provenance_required'),
    });
    f.pr.body = 'Agent: gpt-6-sol (effort: high) via codex-desktop';
    f.publish();
    expect(await f.assign({ candidates: [author] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('same_model'),
    });
    expect(f.starts).toHaveLength(0);
    f.set('provenance', false);
    f.pr.body = '';
    f.publish();
    expect((await f.assign({ candidates: [author] })).ok).toBe(true);
  });
  test('shared Review/Verify harness, model and effort preferences reach the started actor', async () => {
    const f = fixture();
    const preferred = { ...reviewer, adapter: 'hyperneo', effort: 'high' };
    for (const stage of ['review', 'verify'])
      for (const [key, value] of Object.entries({
        harness: preferred.adapter,
        model: preferred.model,
        effort: preferred.effort,
      }))
        f.set(`${stage}.${key}`, value);
    expect(await f.assign({ candidates: [reviewer, preferred] })).toMatchObject({
      ok: true,
      assignment: { effort: 'high', actor: { harness: 'hyperneo' }, fallback: [] },
    });
    expect(await f.assign({ stage: 'verify', candidates: [reviewer, preferred] })).toMatchObject({
      ok: true,
      assignment: { effort: 'high', actor: { harness: 'hyperneo' } },
    });
    expect(f.starts.map((start) => start.effort)).toEqual(['high', 'high']);
  });
  test.each([
    'unsupported_model',
    'unsupported_effort',
    'unsupported_preparation',
    'unknown_adapter',
  ] as const)(
    'an unavailable preferred configuration (%s) safely falls back to the qualifying default',
    async (reason) => {
      let f: ReturnType<typeof fixture>;
      const preferred = { ...reviewer, model: 'claude-sonnet-5-5' };
      f = fixture((input, count) =>
        input.model === preferred.model
          ? {
              kind: 'completed',
              value: { ok: false, reason, detail: 'synthetic unavailable' },
            }
          : f.success(input, count)
      );
      f.set('review.model', preferred.model);
      const result = await f.assign({ candidates: [reviewer, preferred] });
      expect(result).toMatchObject({
        ok: true,
        assignment: {
          actor: { model: reviewer.model },
          fallback: expect.arrayContaining([
            expect.stringContaining('using the qualifying default'),
          ]),
        },
      });
      expect(f.starts.map((start) => start.model)).toEqual([preferred.model, reviewer.model]);
    }
  );
  test('uncertain delivery is never retried or recorded as an assignment', async () => {
    const f = fixture(() => ({
      kind: 'completed',
      value: { ok: false, reason: 'not_delivered', detail: 'unknown submission' },
    }));
    expect(await f.assign()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_delivered'),
    });
    expect(f.starts).toHaveLength(1);
    expect(f.assignments.read('todo', url, head)).toEqual({});
  });
  test('a new head requires fresh assignments; contract changes and stale/closed PRs refuse before launch', async () => {
    const f = fixture();
    await f.assign();
    expect((await f.assign({ acceptanceContract: 'other' })).ok).toBe(false);
    f.pr.headRefOid = next;
    f.publish();
    expect((await f.assign()).ok).toBe(false);
    f.ledger.stageFacts.observeHead(url, next, 2);
    expect((await f.assign({ head: next, stage: 'verify' })).ok).toBe(false);
    expect((await f.assign({ head: next })).ok).toBe(true);
    expect(f.starts).toHaveLength(2);
    f.pr.state = 'CLOSED';
    f.publish();
    expect((await f.assign({ head: next })).ok).toBe(false);
    expect(f.starts).toHaveLength(2);
  });
  test('Verify cannot reuse the author or reviewer ref', async () => {
    let f: ReturnType<typeof fixture>;
    let reuse = write;
    f = fixture((input, count) =>
      input.preparation?.parameters.role === 'verify'
        ? {
            kind: 'completed',
            value: {
              ok: true,
              value: {
                ref: reuse,
                title: input.title,
                place,
                status: 'running',
                lastActivityAt: 1,
                model: input.model,
              },
            },
          }
        : f.success(input, count)
    );
    await f.assign();
    expect((await f.assign({ stage: 'verify', candidates: [author] })).ok).toBe(false);
    reuse = { adapter: reviewer.adapter, id: 'fresh-1' };
    expect((await f.assign({ stage: 'verify', candidates: [author] })).ok).toBe(false);
    expect(f.assignments.read('todo', url, head).qa).toBeUndefined();
    expect(f.stops).toEqual([]);
  });
  test('head changes during start stop only the new actor rather than persist stale ownership', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture((input, count) => {
      f.ledger.stageFacts.observeHead(url, next, 2);
      return f.success(input, count);
    });
    expect((await f.assign()).ok).toBe(false);
    expect(f.stops).toEqual([{ ref: { adapter: reviewer.adapter, id: 'fresh-1' } }]);
    expect(f.assignments.read('todo', url, head)).toEqual({});
  });
  test('simultaneous assignment requests do not duplicate session starts', async () => {
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((done) => {
        release = done;
      }),
      started = new Promise<void>((done) => {
        reached = done;
      });
    let f: ReturnType<typeof fixture>;
    f = fixture(async (input, count) => {
      reached();
      await waiting;
      return f.success(input, count);
    });
    const first = f.assign();
    await started;
    expect(await f.assign()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('already in progress'),
    });
    release();
    expect((await first).ok).toBe(true);
    expect(f.starts).toHaveLength(1);
  });
});
