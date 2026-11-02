import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordStartedWork, readFreeWorkers } from '../../../packages/daemon/src/storage/work-started-sessions.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { runCodingReview } from '../../../packages/daemon/src/lib/neo/packs/coding/review.ts';
import { createCodingAssignmentOperation } from '../../../packages/daemon/src/lib/neo/packs/coding/assign-operation.ts';
import { withCodingWorkerStartBrief } from '../../../packages/daemon/src/lib/neo/packs/coding/worker-worktree-brief.ts';
import { prepareCodingExecution } from '../../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts';
import { NEO_PACK_CODING_WORKER_RULES, REVIEWER_SYSTEM_CONTRACT } from '../../../packages/prompts/src/mod.ts';
import { createOperationRegistry, type OperationCaller } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { createFindWorkOperation } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import { createCodexDesktopAdapter, type CodexDesktopAdapterDeps } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { startCodexBootstrapServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { configureWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import type { NeoPack } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';
import type { WorkRef } from '../../../packages/daemon/src/lib/drivers/types.ts';

const [codex, runArg] = process.argv.slice(2);
const run = resolve(runArg);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(codex.startsWith('/') && existsSync(codex));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'data'));
const commands: unknown[] = [], calls: { name: string; input: unknown; result: unknown }[] = [], nativeCalls: { method: string; params: Record<string, unknown> }[] = [], requests: unknown[] = [];
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  commands.push({ cwd, args, code: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const source = join(run, 'source'), origin = join(run, 'origin.git'), workers = join(run, 'workers');
git(run, 'init', '--bare', '--initial-branch=dev', origin);
git(run, 'clone', origin, source);
git(source, 'config', 'user.name', 'Synthetic'); git(source, 'config', 'user.email', 'synthetic@example.invalid');
mkdirSync(join(source, '.claude/skills/verify'), { recursive: true });
writeFileSync(join(source, '.claude/skills/verify/SKILL.md'), '# Verify\nRead-only synthetic worker probe.\n');
writeFileSync(join(source, 'README.md'), 'Synthetic base\n');
git(source, 'add', '.'); git(source, 'commit', '-m', 'synthetic base'); git(source, 'push', 'origin', 'dev');
const base = git(source, 'rev-parse', 'HEAD');
git(source, 'switch', '-c', 'candidate');
writeFileSync(join(source, 'candidate.txt'), 'PR head\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'synthetic candidate');
const prHead = git(source, 'rev-parse', 'HEAD'); git(source, 'push', 'origin', 'HEAD:refs/pull/7/head'); git(source, 'switch', 'dev');
writeFileSync(join(source, 'README.md'), 'Preserve human work\n');
writeFileSync(join(run, 'proof-config.json'), JSON.stringify({ source, workers, prHead }));
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(run, 'evidence/gh.jsonl'))}, JSON.stringify(process.argv.slice(2))+'\\n');\nif (process.argv[2] !== 'pr' || process.argv[3] !== 'view') process.exit(2);\nconsole.log(${JSON.stringify(JSON.stringify({ body: '', headRefOid: prHead, state: 'OPEN', isCrossRepository: false }))});\n`, { mode: 0o700 });
const probe = fileURLToPath(new URL('./worker-owned-worktree-probe.py', import.meta.url));
const counts = new Map<string, number>();
const model = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const body = await request.json() as { input?: { role?: string; content?: unknown }[]; tools?: { name?: string }[] };
    requests.push(body);
    const content = body.input?.filter(item => item.role === 'user').at(-1)?.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const tag = text.includes('Exact head:') && text.includes('PR number: 7') ? 'review' : ['todo-one', 'todo-two', 'review-warmup'].find(tag => text.includes(`[[proof:${tag}]]`));
    assert(tag, text.slice(-500));
    const count = (counts.get(tag) ?? 0) + 1; counts.set(tag, count);
    const name = ['exec_command', 'shell_command', 'shell'].find(name => body.tools?.some(tool => tool.name === name));
    assert(name, 'Native shell tool was not offered');
    const command = ['/usr/bin/python3', probe, run, tag].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    const args = name === 'exec_command' ? { cmd: command, yield_time_ms: 10000, max_output_tokens: 2000 } : { command };
    const completedHead = count === 1 ? '' : JSON.parse(readFileSync(join(run, 'evidence', `${tag}.json`), 'utf8')).head;
    const item = count === 1
      ? { type: 'function_call', id: `fc_${tag}`, call_id: `call_${tag}`, name, arguments: JSON.stringify(args), status: 'completed' }
      : { type: 'message', id: `msg_${tag}`, role: 'assistant', content: [{ type: 'output_text', text: `Synthetic ${tag} complete. PASS at exact head ${completedHead}.`, annotations: [] }], status: 'completed' };
    const response = { id: `resp_${tag}_${count}`, object: 'response', created_at: 1, status: 'completed', model: 'synthetic', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response }],
    ];
    return new Response(events.map(([type, data], index) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: index, ...data as object })}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  },
});
assert.notEqual(model.port, 8399);
process.env.CODEX_HOME = join(run, 'home/.codex'); mkdirSync(process.env.CODEX_HOME, { recursive: true });
writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), `model = "synthetic"\nmodel_provider = "synthetic"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.synthetic]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\n`);
const db = new Database(join(run, 'data/daemon.db'));
runMigrations(db, () => {}); createTables(db); createCodingPackTables(db);
db.prepare("INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'proof-conversation',0)").run();
const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
const ledger = new CodingPrLedgerRepository(db), todoPrs = new CodingTodoPrRepository(db);
store.openAsk({ id: 'proof-ask', projectId: null, sessionId: 'proof-neo', originMessageId: 'proof-message', title: 'Worker ownership proof', request: 'Synthetic native proof', createdAt: Date.now() });
const caller: OperationCaller = { source: 'internal', role: 'neo', sessionId: 'proof-neo' };
let native: Awaited<ReturnType<typeof startCodexBootstrapServer>> | undefined;
try {
  native = await startCodexBootstrapServer(codex);
  const connection = {
    async call(method: string, params: Record<string, unknown>) { nativeCalls.push({ method, params }); return native!.call(method, params); },
    async close() {},
  };
  const statePath = join(process.env.CODEX_HOME, 'state_5.sqlite');
  let projectId: string | undefined;
  const deps: CodexDesktopAdapterDeps = {
    statePath, worktreesDir: workers, machine: 'synthetic', now: Date.now, spawn: spawnProcess,
    appServer: async () => connection, bootstrapServer: async () => connection,
    desktopRunning: async () => false,
    prepareDesktopProject: async folder => {
      assert.equal(folder, source);
      if (!projectId) {
        const created = await connection.call('project/create', { name: 'Synthetic project', roots: [{ path: folder }], idempotencyKey: crypto.randomUUID() }) as { project: { id: string } };
        projectId = created.project.id;
      }
      return projectId;
    },
    startDesktopTurn: async (_id, request) => { await connection.call('turn/start', request); },
    folderExists: existsSync, makeFolder: folder => mkdirSync(folder, { recursive: true }), homeDir: join(run, 'home'),
    gitCheckout: async folder => ({ repo: source, linked: realpathSync(folder) !== source }), newId: () => crypto.randomUUID(),
  };
  configureWorkerSandbox(() => 'off');
  const adapter = createCodexDesktopAdapter(deps), remote = { list: () => [], invoke: async () => ({}) };
  let registry = createOperationRegistry([]);
  const invoke = async (name: string, input: unknown, actor = caller) => {
    const result = await invokeOperation(registry, name, input, actor);
    calls.push({ name, input, result }); return result;
  };
  const assignment = createCodingAssignmentOperation({
    db, ledger, todos: todoPrs, invoke,
    review: runCodingReview,
  });
  registry = createOperationRegistry([
    ...createWorkVerbOperations({ adapters: () => [adapter], remote, daemonName: 'synthetic', freeWorkers: id => readFreeWorkers(db, id), recordStarted: ref => recordStartedWork(db, ref) }),
    createFindWorkOperation({ adapters: () => [adapter], remote }), assignment,
  ]);
  const pack: NeoPack = {
    id: 'coding', describe: 'Synthetic coding outcome; production worker checkout hooks', instructions: () => null,
    workerRules: NEO_PACK_CODING_WORKER_RULES, workerStartBrief: withCodingWorkerStartBrief,
    prepareExecution: prepareCodingExecution,
    todos: { schema: createCodingPackTables, check: async () => null, statusLine: () => null, waiting: async () => false },
  };
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)), store, sessions,
    invoke: (actor, name, input) => invoke(name, input, actor), packs: () => [pack],
    tell: async () => {}, changed: () => {}, limits: () => ({ running: 2, perGroup: 2 }),
  });
  const place = { machine: 'synthetic', folder: source, name: 'Synthetic project' };
  const target = { verb: 'start' as const, adapter: adapter.id, place, preparationParameters: { target: 'dev', repo: 'synthetic/owned-workers' } };
  async function done(ref: WorkRef, tag: string) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const status = await adapter.status!(ref);
      if (status.ok && status.value.status === 'done' && existsSync(join(run, 'evidence', `${tag}.json`))) return status.value;
      if (status.ok && ['failed', 'needs_you', 'stopped'].includes(status.value.status)) throw new Error(JSON.stringify(status));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Native ${tag} did not complete`);
  }
  function add(tag: string) {
    const todo = store.addTodo(tag, 'proof-ask', { title: tag, doneWhen: 'Synthetic native probe finished', check: { pack: 'coding', kind: 'pr_merged', params: {} }, instruction: `Read the verify skill and run the synthetic probe. [[proof:${tag}]]`, named: null }, Date.now());
    sessions.create(todo.id, target); return todo;
  }
  const first = add('todo-one');
  assert((await runner.start(first.id)).ok);
  const author = sessions.readRef(first.id)!; assert(author);
  await done(author, first.id);
  store.updateTodo(store.getTodo(first.id)!, { state: 'done', finishedAt: Date.now(), report: 'Observed native probe; synthetic completion bookkeeping.' }, Date.now());
  const publisher = join(run, 'publisher'); git(run, 'clone', origin, publisher);
  git(publisher, 'config', 'user.name', 'Synthetic'); git(publisher, 'config', 'user.email', 'synthetic@example.invalid');
  writeFileSync(join(publisher, 'new-target.txt'), 'New target after first task\n');
  git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'advance synthetic target'); git(publisher, 'push', 'origin', 'dev');
  const nextTarget = git(publisher, 'rev-parse', 'HEAD'); assert.notEqual(nextTarget, base);
  const second = add('todo-two'); assert((await runner.start(second.id)).ok);
  assert.deepEqual(sessions.readRef(second.id), author);
  await done(author, second.id);
  store.updateTodo(store.getTodo(second.id)!, { state: 'done', finishedAt: Date.now(), report: 'Observed native probe; synthetic completion bookkeeping.' }, Date.now());
  const warm = await invoke('work.start', { adapter: adapter.id, place, title: 'Review pool warmup', message: '[[proof:review-warmup]]' }, { source: 'rpc' });
  assert.equal(warm.kind, 'completed');
  const warmValue = (warm as { value: { ok: boolean; value: { ref: WorkRef } } }).value; assert(warmValue.ok, JSON.stringify(warm));
  const reviewer = warmValue.value.ref; assert.notDeepEqual(reviewer, author); await done(reviewer, 'review-warmup');
  const stage = add('stage-review'); store.updateTodo(stage, { state: 'doing' }, Date.now()); sessions.bind(stage.id, author, Date.now());
  const url = 'https://github.com/synthetic/owned-workers/pull/7';
  await todoPrs.write('claim', stage.id, [{ url, claim: 'named' }], Date.now()); await ledger.stageFacts.observeHead(url, prHead, Date.now());
  db.prepare('INSERT INTO neo_pack_preferences (pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES (?,?,?,?,?,?,?)').run('coding', 'repo', 'synthetic/owned-workers', 'provenance', 'false', 'synthetic', Date.now());
  const assigned = await invoke('neo.coding.assign', { todoId: stage.id, url, head: prHead, stage: 'review', acceptanceContract: 'artifact:synthetic-contract', candidates: [{ adapter: adapter.id, place }] });
  assert.equal(assigned.kind, 'completed');
  const selected = (assigned as { value: { ok: boolean; assignment: { ref: WorkRef } } }).value; assert(selected.ok, JSON.stringify(assigned));
  assert.deepEqual(selected.assignment.ref, reviewer); const reviewStatus = await done(reviewer, 'review');
  assert(reviewStatus.lastReply?.includes(prHead), JSON.stringify(reviewStatus));
  const read = (tag: string) => JSON.parse(readFileSync(join(run, 'evidence', `${tag}.json`), 'utf8'));
  const a = read(first.id), b = read(second.id), c = read('review-warmup'), d = read('review');
  assert.equal(a.cwd, b.cwd); assert.equal(c.cwd, d.cwd); assert.notEqual(a.cwd, c.cwd);
  assert.equal(a.head, base); assert.equal(b.head, nextTarget); assert.equal(d.head, prHead);
  assert.equal(git(source, 'rev-parse', 'HEAD'), base); assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'Preserve human work\n');
  const starts = calls.filter(call => call.name === 'work.start');
  assert(starts.every(call => !(call.input as { preparation?: unknown }).preparation));
  assert((starts.at(-1)!.input as { message: string }).message.includes(REVIEWER_SYSTEM_CONTRACT));
  assert.equal(nativeCalls.filter(call => call.method === 'thread/start').length, 2);
  writeFileSync(join(run, 'evidence/worker-owned-worktrees.json'), JSON.stringify({ author, reviewer, base, nextTarget, prHead, first: a, second: b, warm: c, review: d, reviewStatus, nativeThreadStarts: nativeCalls.filter(call => call.method === 'thread/start').length, limits: 'Real bundled Codex app-server, native shell/Git/rollouts, synthetic loopback model and PR metadata; real native project records; fixture todo completion bookkeeping; Desktop UI and external provider not driven.' }, null, 2));
  console.log('Native worker ownership/reuse and exact-head reused Review proof passed.');
} finally {
  configureWorkerSandbox(() => 'off');
  await native?.close(); model.stop(true); db.close();
  for (const [name, value] of Object.entries({ calls, nativeCalls, requests, commands })) writeFileSync(join(run, 'evidence', `${name}.json`), JSON.stringify(value, null, 2));
}
