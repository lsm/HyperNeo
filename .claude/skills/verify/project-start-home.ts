import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NEO_ROOT_PROMPT, NEO_FOCUSED_DISCUSSION } from '../../../packages/prompts/src/mod.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const workspaceRoot = process.argv[3] === 'without-workspace' ? undefined : join(run, 'HyperNeo-Rui');
if (process.argv[3] === 'env-workspace') process.env.HYPERNEO_WORKSPACE_PATH = workspaceRoot;
const expectedHome = workspaceRoot ?? join(run, 'home/HyperNeo');
const evidence: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
let preview: ReturnType<typeof Bun.serve> | undefined;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: process.argv[3] === 'env-workspace' ? undefined : workspaceRoot }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const sender = 'neo:10000000-0000-4000-8000-000000000002';
  const insert = (id: string, folder: string, title: string) => db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, ?, ?, '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(id, title, folder);
  insert(sender, join(run, 'data/Neo'), 'Synthetic coordinator');
  const projects = new NeoRepository(db);
  projects.reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  projects.saveProject({ id: 'project:synthetic-life', title: 'Life admin', summary: '', context: '' }, 0);
  const store = new NeoAskTodoRepository(db);
  const starts: { folder: string; title: string; mode?: string }[] = [];
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', process.argv[3] === 'without-workspace' ? join(run, 'home') : run]);
  assert(!existsSync(expectedHome));
  app.sessionManager.createSession = async (input) => {
    const id = crypto.randomUUID();
    assert(input.workspacePath);
    starts.push({ folder: input.workspacePath, title: input.title ?? '', mode: input.worktreeMode });
    insert(id, input.workspacePath, input.title ?? 'Synthetic worker');
    return id;
  };
  const registry = app.sessionManager.getOperationRegistry();
  const openedNeo = await invokeOperation(registry, 'neo.open', {}, { source: 'rpc', principal: 'local' });
  assert(openedNeo.kind === 'completed' && typeof openedNeo.value === 'object' && openedNeo.value !== null && 'ok' in openedNeo.value && openedNeo.value.ok === true, JSON.stringify(openedNeo));
  const coordinatorPrompt = String(app.db.getSession(sender)?.config.systemPrompt ?? '');
  evidence.push({ openedNeo, coordinatorPrompt, rootWords: NEO_ROOT_PROMPT.split(/\s+/).length, discussionWords: NEO_FOCUSED_DISCUSSION.split(/\s+/).length });
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
  const invoke = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    const result = JSON.parse(reply.content[0].text);
    evidence.push({ name, input, result });
    return result;
  };
  const open = (id: string, request: string, projectId: string | null = 'project:synthetic-life') => store.openAsk({ id, projectId, sessionId: sender, originMessageId: null, title: 'Synthetic task', request, createdAt: Date.now() });
  const target = { verb: 'start', adapter: 'hyperneo' };
  const add = (askId: string, extra: Record<string, unknown> = {}) => invoke('neo.todo.add', { askId, title: askId, doneWhen: 'Synthetic session started', instruction: 'Synthetic work only', start: true, target: { ...target, ...extra } });
  open('default', 'Organize my life admin');
  const defaultReply = await add('default');
  const homePath = projects.getProject('project:synthetic-life')?.homePath;
  const defaultStart = starts.find(start => start.title === 'default');
  projects.saveProject({ id: 'project:another-life', title: 'Another life project', summary: '', context: '' }, 0);
  open('second-project', 'Organize another non-coding task', 'project:another-life');
  const secondReply = await add('second-project');
  const secondStart = starts.find(start => start.title === 'second-project');
  const invented = join(run, 'home/life-admin');
  open('invented', 'Organize my life admin');
  const inventedReply = await add('invented', { place: { machine: hostname(), folder: invented, name: 'Invented folder' }, createFolder: true });
  const named = join(run, 'home/user-named');
  const messageId = crypto.randomUUID();
  assert(new NeoConversationAskRepository(db).append({ conversationId: projects.conversationId(), requestId: messageId, askOrigin: { sessionId: sender, messageId }, content: `Please create the session in ${named}` }).accepted);
  open('named', `Please create the session in ${named}`);
  const namedReply = await add('named', { place: { machine: hostname(), folder: named, name: 'User named folder' }, createFolder: true });
  const rejectedFolder = join(run, 'home/refused-model');
  const rejectedMessageId = crypto.randomUUID();
  assert(new NeoConversationAskRepository(db).append({ conversationId: projects.conversationId(), requestId: rejectedMessageId, askOrigin: { sessionId: sender, messageId: rejectedMessageId }, content: `Please use ${rejectedFolder}` }).accepted);
  open('refused-model', `Please use ${rejectedFolder}`);
  const rejectedReply = await add('refused-model', { place: { machine: hostname(), folder: rejectedFolder, name: 'Refused model' }, createFolder: true, model: 'synthetic-model-does-not-exist' });
  const missingParent = join(run, 'home/missing-parent');
  const nestedFolder = join(missingParent, 'child');
  const nestedMessageId = crypto.randomUUID();
  assert(new NeoConversationAskRepository(db).append({ conversationId: projects.conversationId(), requestId: nestedMessageId, askOrigin: { sessionId: sender, messageId: nestedMessageId }, content: `Please use ${nestedFolder}` }).accepted);
  open('missing-parent', `Please use ${nestedFolder}`);
  const nestedReply = await add('missing-parent', { place: { machine: hostname(), folder: nestedFolder, name: 'Missing parent' }, createFolder: true });
  const workspace = join(run, 'workspace/inside');
  open('workspace', 'Organize my life admin');
  const workspaceReply = await add('workspace', { place: { machine: hostname(), folder: workspace, name: 'Inside workspace' }, createFolder: true });
  const codingFolder = join(run, 'repo');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', codingFolder]);
  open('coding', 'Synthetic coding work');
  db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('synthetic/repo', 'coding');
  const codingReply = await add('coding', { place: { machine: hostname(), folder: codingFolder, name: 'Repo' } });
  const codingStart = starts.find(start => start.title === 'coding');
  const intake = db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as { payload: string }[];
  const workerIntake = intake.map(row => JSON.parse(row.payload)).filter(entry => entry.to?.sessionId === defaultReply.todo?.worker?.id);
  const checks = {
    refusedModelNoFolder: rejectedReply.todo?.state === 'failed' && !existsSync(rejectedFolder) && !starts.some(start => start.title === 'refused-model'),
    namedParentGuard: nestedReply.todo?.state === 'failed' && !existsSync(missingParent),
    coordinatorGuidance: coordinatorPrompt.includes(NEO_ROOT_PROMPT) && coordinatorPrompt.includes(NEO_FOCUSED_DISCUSSION) && coordinatorPrompt.includes('~/HyperNeo') && coordinatorPrompt.includes('旅行/2026圣诞') && NEO_ROOT_PROMPT.split(/\s+/).length < 260 && NEO_FOCUSED_DISCUSSION.split(/\s+/).length < 250,
    coordinatorSeparate: app.db.getSession(sender)?.workspacePath === join(run, 'data/Neo') && expectedHome !== join(run, 'data/Neo'),
    codingUnchanged: codingReply.ok === true && codingStart?.folder === codingFolder && codingStart?.mode === 'worktree',
    nonCodingFileGuidance: workerIntake.length === 1 && JSON.stringify(workerIntake[0]).includes('Most non-coding tasks write nothing') && JSON.stringify(workerIntake[0]).includes('旅行/2026圣诞'),
    sharedHomeInPlace: defaultStart?.mode === 'direct' && secondStart?.mode === 'direct',
    sharedDefault: defaultReply.ok === true && homePath === null && defaultStart?.folder === expectedHome && existsSync(defaultStart.folder) && secondReply.ok === true && secondStart?.folder === defaultStart.folder,
    inventedRefused: !existsSync(invented) && !starts.some(start => start.title === 'invented') && /user.named|user.*path|path.*user/i.test(String(store.getTodo(inventedReply.todo?.id)?.reason ?? inventedReply.reason)),
    namedAllowed: namedReply.ok === true && existsSync(named) && starts.some(start => start.folder === named),
    differentWorkspaceRefused: !existsSync(workspace) && !starts.some(start => start.folder === workspace) && workspaceReply.todo?.state === 'failed',
  };
  evidence.push({ homePath, starts, checks, workerIntake });
  console.log(JSON.stringify(checks));
  assert(Object.values(checks).every(Boolean), 'Project placement regression: see evidence/project-start-home.json');
  console.log(`PASS: actual daemon Neo MCP -> todo runner -> work.start -> HyperNeo adapter; one non-coding home shared across projects in direct mode despite a Git parent; invented and different workspace folders refused; user-named folder created; coordinator home unchanged. Worker creation is synthetic; no model called. ${run}/evidence/project-start-home.json`);
  if (process.argv.includes('--show-header')) {
    const { Hono } = await import(Bun.resolveSync('hono', resolve(import.meta.dir, '../../../packages/cli')));
    const { serveStatic } = await import(Bun.resolveSync('hono/bun', resolve(import.meta.dir, '../../../packages/cli')));
    const { createWebSocketHandlers } = await import('../../../packages/daemon/src/routes/setup-websocket.ts');
    const dist = resolve(import.meta.dir, '../../../packages/web/dist');
    const web = new Hono();
    web.use('/*', serveStatic({ root: dist }));
    web.get('*', async c => c.html(await Bun.file(join(dist, 'index.html')).text()));
    preview = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: async (req, server) => {
        const refused = app.guardRequest(req);
        if (refused) return refused;
        if (new URL(req.url).pathname === '/ws') {
          const device = await app.authenticateUpgrade(req, server.requestIP(req)?.address ?? null);
          if (server.upgrade(req, { data: { connectionSessionId: 'global', device } })) return;
          return new Response('Upgrade failed', { status: 500 });
        }
        return web.fetch(req);
      }, websocket: createWebSocketHandlers(app.transport, app.sessionManager)
    });
    console.log(`HEADER: http://127.0.0.1:${preview.port}/session/${defaultReply.todo.worker.id} PID=${process.pid}`);
    await new Promise<void>(done => process.once('SIGTERM', () => done()));
  }
} finally {
  preview?.stop(true);
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/project-start-home.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
