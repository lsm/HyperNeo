import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const evidence: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const sender = 'neo:10000000-0000-4000-8000-000000000002';
  const insert = (id: string, folder: string, title: string) => db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, ?, ?, '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(id, title, folder);
  insert(sender, join(run, 'workspace'), 'Synthetic coordinator');
  const projects = new NeoRepository(db);
  projects.reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  projects.saveProject({ id: 'project:synthetic-life', title: 'Life admin', summary: '', context: '' }, 0);
  const store = new NeoAskTodoRepository(db);
  const starts: { folder: string; title: string }[] = [];
  app.sessionManager.createSession = async (input) => {
    const id = crypto.randomUUID();
    assert(input.workspacePath);
    starts.push({ folder: input.workspacePath, title: input.title ?? '' });
    insert(id, input.workspacePath, input.title ?? 'Synthetic worker');
    return id;
  };
  const registry = app.sessionManager.getOperationRegistry();
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
  const invented = join(run, 'home/life-admin');
  open('invented', 'Organize my life admin');
  const inventedReply = await add('invented', { place: { machine: hostname(), folder: invented, name: 'Invented folder' }, createFolder: true });
  const named = join(run, 'home/user-named');
  open('named', `Please create the session in ${named}`);
  const namedReply = await add('named', { place: { machine: hostname(), folder: named, name: 'User named folder' }, createFolder: true });
  const workspace = join(run, 'workspace/inside');
  open('workspace', 'Organize my life admin');
  const workspaceReply = await add('workspace', { place: { machine: hostname(), folder: workspace, name: 'Inside workspace' }, createFolder: true });
  const checks = {
    projectDefault: defaultReply.ok === true && !!homePath && defaultStart?.folder === join(run, 'data/Neo', homePath) && existsSync(defaultStart.folder),
    inventedRefused: !existsSync(invented) && !starts.some(start => start.title === 'invented') && /user.named|user.*path|path.*user/i.test(String(store.getTodo(inventedReply.todo?.id)?.reason ?? inventedReply.reason)),
    namedAllowed: namedReply.ok === true && existsSync(named) && starts.some(start => start.folder === named),
    workspaceAllowed: workspaceReply.ok === true && existsSync(workspace) && starts.some(start => start.folder === workspace),
  };
  evidence.push({ homePath, starts, checks });
  console.log(JSON.stringify(checks));
  assert(Object.values(checks).every(Boolean), 'Project placement regression: see evidence/project-start-home.json');
  console.log(`PASS: actual daemon Neo MCP -> todo runner -> work.start -> HyperNeo adapter; project home persisted; invented folder refused; user-named and workspace folders created. Worker creation is synthetic; no model or GUI. ${run}/evidence/project-start-home.json`);
} finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/project-start-home.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
