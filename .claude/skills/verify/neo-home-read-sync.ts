import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';

const [run] = process.argv.slice(2);
assert(run?.startsWith('/') && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GIT_CONFIG_GLOBAL, join(run, 'gitconfig'));
await writeFile(join(run, 'gitconfig'), '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
async function git(cwd: string, ...args: string[]) {
 const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
 const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 if (code) throw new Error(error);
 return text.trim();
}
const peer = join(run, 'first-machine'), remote = join(run, 'shared.git'), root = join(run, 'data', 'Neo');
await mkdir(peer); await git(peer, 'init', '--initial-branch=main', '--quiet');
await writeFile(join(peer, '.gitignore'), '.coordinators/\n.claude/\nworktrees/\n');
await writeFile(join(peer, 'direction.md'), 'Initial'); await writeFile(join(peer, 'mandate.md'), 'Initial mandate');
await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Initial');
await git(run, 'clone', '--bare', peer, remote); await git(peer, 'remote', 'add', 'origin', remote);
async function version(text: string) {
 await writeFile(join(peer, 'direction.md'), text); await writeFile(join(peer, 'mandate.md'), `Mandate ${text}`);
 await git(peer, 'add', '.'); await git(peer, 'commit', '-m', text); await git(peer, 'push', 'origin', 'main');
}
async function pulls() { return (await readFile(join(run, 'evidence', 'pulls'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length; }
const evidence: Record<string, unknown> = { run, peer, remote, root };
let daemon: Awaited<ReturnType<typeof import('../../../packages/daemon/src/app.ts').createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let server: ReturnType<typeof createOperationMcpServer> | undefined;
const { Client } = await import('../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { InMemoryTransport } = await import('../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const client = new Client({ name: 'isolated-home-read-sync', version: '1.0' });
try {
 const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
 const { getConfig } = await import('../../../packages/daemon/src/config.ts');
 daemon = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data', 'daemon.db'), workspaceRoot: run }), port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
 assert.notEqual(daemon.server.port, 8399);
 const hub = new MessageHub({ defaultSessionId: 'global' });
 transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
 hub.registerTransport(transport); await transport.initialize();
 const rpc = (name: string, input: unknown) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
 assert.equal((await rpc('neo.home.init', { remoteUrl: remote })).ok, true);
 const opened = await rpc('neo.open', {}); const sessionId = String(opened.sessionId); assert(sessionId.startsWith('neo:'));
 server = createOperationMcpServer(() => daemon!.sessionManager.getOperationRegistry(), () => ({ sessionId, role: 'neo' }));
 const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
 await server.instance.connect(serverTransport); await client.connect(clientTransport);
 const mcpRead = async (path = 'direction.md') => {
  const result = await client.callTool({ name: 'invoke', arguments: { name: 'neo.home.read', input: { path } } });
  assert.notEqual(result.isError, true); const content = result.content as { type: string; text?: string }[];
  assert.equal(content[0].type, 'text'); return JSON.parse(content[0].text!);
 };
 await version('Peer one'); evidence.first = await mcpRead();
 await writeFile(join(run, 'evidence', 'neo-home-read-sync.json'), JSON.stringify(evidence, null, 2));
 assert.equal((evidence.first as { content: string }).content, 'Peer one');
 await version('Peer two'); evidence.repeated = await Promise.all([mcpRead(), mcpRead('mandate.md')]);
 assert.deepEqual((evidence.repeated as { content: string }[]).map((x) => x.content), ['Peer two', 'Mandate Peer two']);
 assert.equal(await pulls(), 3);
 evidence.secondWake = await mcpRead(); assert.equal((evidence.secondWake as { content: string }).content, 'Peer two'); assert.equal(await pulls(), 4);
 await git(root, 'remote', 'set-url', 'origin', join(run, 'missing.git'));
 evidence.failed = await mcpRead(); assert.equal((evidence.failed as { ok: boolean }).ok, false);
 await git(root, 'remote', 'set-url', 'origin', remote); await version('Peer three');
 evidence.failedRetry = await mcpRead('mandate.md'); assert.equal((evidence.failedRetry as { content: string }).content, 'Mandate Peer three'); assert.equal(await pulls(), 6);
 assert.equal((await mcpRead()).content, 'Peer three'); assert.equal(await pulls(), 7);
 await version('Human four'); evidence.humanFirst = await rpc('neo.home.read', { path: 'direction.md' });
 assert.equal((evidence.humanFirst as { content: string }).content, 'Human four');
 await version('Human five'); evidence.humanSecond = await rpc('neo.home.read', { path: 'direction.md' });
 assert.equal((evidence.humanSecond as { content: string }).content, 'Human five'); assert.equal(await pulls(), 9);
 await writeFile(join(root, 'direction.md'), 'Human uncommitted edit'); const head = await git(root, 'rev-parse', 'HEAD');
 evidence.dirty = await mcpRead(); assert.match((evidence.dirty as { reason: string }).reason, /dirty/);
 assert.equal(await readFile(join(root, 'direction.md'), 'utf8'), 'Human uncommitted edit'); assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
 assert.equal(await pulls(), 9); evidence.pullCount = await pulls(); evidence.localEditPreserved = true;
 console.log(`PASS: home read-sync RPC/MCP proof. ${run}/evidence/neo-home-read-sync.json`);
} finally {
 await writeFile(join(run, 'evidence', 'neo-home-read-sync.json'), JSON.stringify(evidence, null, 2));
 await client.close(); await server?.instance.close(); await transport?.close(); await daemon?.cleanup();
}
