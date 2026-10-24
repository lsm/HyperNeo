import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { sweepNeoPacks } from '../../../packages/daemon/src/lib/neo/pack-sweep.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const execFile = promisify(execFileCallback), run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const hour = 3_600_000, at = Date.UTC(2026, 9, 24, 12), realNow = Date.now;
const root = 'neo:00000000-0000-4000-8000-000000008420';
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), receipts: [] };
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, service: ReturnType<typeof createNeoService> | undefined;
const open = async () => {
  app = await createDaemonApp({ config: { ...config, disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  service.pack('coding')!.sweep = async () => {};
};
const close = async () => { await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const read = async (name: string, expected: number) => {
  const { stdout } = await execFile(process.execPath, ['.claude/skills/verify/rpc.ts', 'neo.conversation.read', JSON.stringify({ conversationId: root.slice(4), limit: 100 })], { env: { ...process.env, VERIFY_PORT: String(app!.server.port) } });
  const receipt = JSON.parse(stdout);
  (evidence.receipts as unknown[]).push({ name, receipt });
  const reply = receipt.reply;
  assert.equal(reply?.ok, true, JSON.stringify(receipt));
  const messages = reply.items.filter((entry: { role: string }) => entry.role === 'neo');
  assert.equal(messages.length, expected, name);
  return messages;
};
try {
  await open();
  app!.db.getDatabase().prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(root, 'Synthetic coordinator', 'general', join(run, 'workspace'), new Date(at).toISOString(), new Date(at).toISOString(), 'active', '{}', '{}');
  service!.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const id of ['stalled', 'waiting', 'idle']) {
    service!.todos.openAsk({ id, sessionId: root, projectId: null, originMessageId: null, title: id, request: 'Synthetic task', createdAt: at - 3 * hour });
    if (id !== 'stalled') {
      const item = service!.todos.addTodo(id, id, { title: id, doneWhen: 'Done', check: null, instruction: null, named: null }, at - 3 * hour);
      if (id === 'idle') {
        service!.todos.updateTodo(item, { state: 'doing' }, at - 3 * hour);
        service!.todoSessions.create(id, { verb: 'adopt', ref: { adapter: 'hyperneo', id: 'synthetic-worker' } });
        service!.todoSessions.recordLive(id, 'stopped', null);
        service!.todoSessions.recordCardCheck(id, { checkedAt: at, unchecked: false });
      }
    }
  }
  new CodingPrLedgerRepository(app!.db.getDatabase()).replace('synthetic/plan', [ { repo: 'synthetic/plan', number: 1, title: 'Synthetic ready item', branch: 'one', head: 'synthetic-head', state: 'approved_green', closedAt: null } ], at - hour - 1);
  await Promise.all([sweepNeoPacks(app!.jobQueue, service!), sweepNeoPacks(app!.jobQueue, service!)]);
  const first = (await read('daily message reaches conversation RPC', 1))[0].publication;
  for (const text of ['stalled asks: 1', 'todos waiting >2h: 1', 'idle workers without a report: 1', 'coding', 'ready to merge >1h: 1']) assert(first.fullText.includes(text), text);
  await close();
  await open();
  await sweepNeoPacks(app!.jobQueue, service!);
  await read('restart does not repeat today', 1);
  service!.todos.settleAsk(service!.todos.getAsk('stalled')!, 'done', 'Settled', clock);
  clock += 24 * hour;
  await sweepNeoPacks(app!.jobQueue, service!);
  const messages = await read('next day keeps history and new counts', 2);
  assert.equal(messages[0].publication.fullText, first.fullText);
  assert(messages[1].publication.fullText.includes('stalled asks: 0'));
  clock += 24 * hour;
  let hookAttempts = 0;
  service!.filePacks = [
    { id: 'broken', describe: 'Synthetic failure', instructions: () => null, stats: () => { hookAttempts++; throw new Error('Synthetic stats failure'); } },
    { id: 'healthy', describe: 'Synthetic count', instructions: () => null, stats: () => ({ waiting: 4 }) },
    { id: 'large', describe: 'Synthetic large count', instructions: () => null, stats: () => ({ ['x'.repeat(17000)]: 1 }) },
  ];
  app!.db.updateGlobalSettings({ neo: { packs: ['broken', 'healthy', 'large'] } });
  await sweepNeoPacks(app!.jobQueue, service!);
  const bounded = (await read('faulty and oversized packs preserve the core report', 3)).at(-1).publication;
  assert(bounded.fullText.includes('Core: stalled asks: 0'));
  assert(bounded.fullText.includes('broken: unavailable'));
  assert(bounded.fullText.includes('healthy: waiting: 4'));
  assert(bounded.fullText.length <= 16000 && bounded.shortText.length <= 2000);
  await sweepNeoPacks(app!.jobQueue, service!);
  await read('a faulty hook does not repeat all day', 3);
  assert.equal(hookAttempts, 1);
  evidence.hookAttempts = hookAttempts;
  evidence.passed = true;
} catch (error) { evidence.error = String(error); throw error; }
finally { await close(); Date.now = realNow; evidence.resourcesClosed = true; writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2)); }
