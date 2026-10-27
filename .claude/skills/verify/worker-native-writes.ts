import { strict as assert } from 'node:assert';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
const engine = resolve(process.argv[3]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'evidence', 'home/.claude', 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account']) mkdirSync(join(run, dir), { recursive: true });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-b1-cli.ts', import.meta.url));
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--session-id')) writeFileSync(${JSON.stringify(join(run, 'evidence/worker-cwd'))}, process.cwd());\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/script'), `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(run, 'evidence/handoffs.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nprocess.argv.push('--synthetic-desktop-import');\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['open', 'gh']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'home/.claude/settings.json'), JSON.stringify({ apiKeyHelper: 'printf synthetic-loopback-only', permissions: { allow: ['Read', 'Edit', 'Write'] } }));
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: join(run, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const remote = join(run, 'remote');
const mainName = 'main [café]';
const main = join(run, mainName);
const caseMain = join(run, mainName.toUpperCase());
const unicodeMain = join(run, mainName.normalize('NFD'));
git(run, 'init', '--initial-branch=dev', remote);
git(remote, 'config', 'user.name', 'Synthetic');
git(remote, 'config', 'user.email', 'synthetic@example.invalid');
writeFileSync(join(remote, 'AGENTS.md'), '## Verify\nRun the synthetic file-tool proof.\n');
writeFileSync(join(remote, 'code.txt'), 'original\n');
mkdirSync(join(remote, 'neo-read'));
writeFileSync(join(remote, 'neo-read/keep.txt'), 'synthetic tracked namespace trap\n');
git(remote, 'add', '.');
git(remote, 'commit', '-m', 'synthetic');
git(run, 'clone', remote, main);
for (const alias of [caseMain, unicodeMain]) assert.equal(statSync(join(alias, 'code.txt')).ino, statSync(join(main, 'code.txt')).ino, 'this journey requires a case/normalization-insensitive volume');
const protectedMain = [{ path: caseMain, denied: true }, { path: unicodeMain, denied: true }, { path: main, denied: true }];
const unlisted = join(run, 'unlisted');
mkdirSync(unlisted);
writeFileSync(join(unlisted, 'code.txt'), 'original\n');
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let step = 0;
let phase = 'initial';
let tools: { name: string; input: Record<string, unknown> }[] = [];
let results: Record<string, { is_error?: boolean; content: unknown }> = {};
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 100 });
  const body = await request.json() as { messages?: { content?: unknown }[] };
  for (const message of body.messages ?? []) if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_result') results[block.tool_use_id] = block;
  const n = step++;
  const tool = tools[n];
  const usage = { input_tokens: 10, output_tokens: 10 };
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `${phase}-native-${n}`, name: tool.name, input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Synthetic native file-tool proof complete.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
assert.notEqual(server.port, 8399);
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
}
const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => { ws!.removeEventListener('message', receive); fail(new Error('RPC timed out')); }, 30000);
  const receive = (event: MessageEvent) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    ws!.removeEventListener('message', receive);
    clearTimeout(timer);
    evidence.push({ name, input, reply });
    if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
  };
  ws!.addEventListener('message', receive);
  ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
async function start(title: string, folder = main) {
  await rpc('rpc:settings.global.update', { updates: { workerSandbox: 'always' } });
  const result = await rpc('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder, name: 'Synthetic fixture' }, title, message: 'Synthetic task only', preparation: { pack: 'coding', parameters: { target: 'dev' } } }) as Result<WorkStarted>;
  assert(result.ok, JSON.stringify(result));
  const root = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  assert.equal(dirname(root), join(run, 'data/claude-worktrees', basename(folder)));
  assert.equal(git(root, 'status', '--porcelain'), '', 'generated native policy stays out of worker commits');
  return root;
}
async function exercise(worker: string, roots: { path: string; denied: boolean }[], session: string, resume: boolean, mode = 'dontAsk') {
  step = 0;
  results = {};
  tools = roots.flatMap(({ path }) => [
    { name: 'Read', input: { file_path: join(path, 'code.txt') } },
    { name: 'Edit', input: { file_path: join(path, 'code.txt'), old_string: 'original', new_string: 'changed' } },
    { name: 'Write', input: { file_path: join(path, 'created.txt'), content: 'created\n' } },
  ]);
  tools.push({ name: 'Write', input: { file_path: join(worker, '.claude/settings.local.json'), content: '{}' } });
  phase = mode === 'bypassPermissions' ? 'bypass-disabled' : resume ? 'resume' : 'initial';
  const r = await promisify(execFile)(engine, ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(tools.length + 2), '--model', 'claude-sonnet-4-20250514', '--permission-mode', mode, '--tools', 'Read,Edit,Write', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', resume ? '--resume' : '--session-id', session, 'Execute the scripted synthetic native file-tool fixture.'], { cwd: worker, timeout: 60000, maxBuffer: 10 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(run, 'home'), CLAUDE_CONFIG_DIR: join(run, 'home/.claude'), NODE_ENV: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  writeFileSync(join(run, `evidence/${phase}-stdout.jsonl`), r.stdout);
  writeFileSync(join(run, `evidence/${phase}-stderr.log`), r.stderr);
  evidence.push({ phase, worker, tools, results });
  for (const [i, { path, denied }] of roots.entries()) {
    for (const offset of [1, 2]) {
      const result = results[`${phase}-native-${i * 3 + offset}`];
      assert(result, `missing ${phase} result ${i * 3 + offset}`);
      assert.equal(result.is_error ?? false, denied, JSON.stringify(result));
      if (denied) assert.match(JSON.stringify(result.content), /denied|not allowed|permission/i);
    }
    assert.equal(readFileSync(join(path, 'code.txt'), 'utf8'), denied ? 'original\n' : 'changed\n');
    assert.equal(existsSync(join(path, 'created.txt')), !denied);
  }
  assert.equal(results[`${phase}-native-${tools.length - 1}`]?.is_error, true, 'native Write cannot replace its own policy');
}
try {
  await open();
  const first = await start('First synthetic worker');
  const session = crypto.randomUUID();
  await exercise(first, [...protectedMain, { path: first, denied: false }, { path: unlisted, denied: false }], session, false);
  ws!.close();
  await app!.cleanup();
  app = undefined;
  await open();
  const second = await start('Second synthetic worker');
  const siblingAliases = [second, join(dirname(second), basename(second).toUpperCase()), second.normalize('NFD')];
  for (const alias of siblingAliases) assert.equal(statSync(join(alias, 'code.txt')).ino, statSync(join(second, 'code.txt')).ino);
  const protectedRoots = [...protectedMain, ...siblingAliases.map(path => ({ path, denied: true })), { path: first, denied: false }];
  writeFileSync(join(first, 'code.txt'), 'original\n');
  await exercise(first, protectedRoots, session, true);
  writeFileSync(join(first, 'code.txt'), 'original\n');
  await exercise(first, protectedRoots, session, true, 'bypassPermissions');
  const plainMain = join(run, 'plain-source');
  git(run, 'clone', remote, plainMain);
  const third = await start('Namespace trap worker', plainMain);
  assert(existsSync(join(third, 'neo-read/keep.txt')));
  const handoffs = readFileSync(join(run, 'evidence/handoffs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(handoffs.length, 3);
  for (const [i, root] of [first, second, third].entries()) {
    assert.equal(handoffs[i].cwd, root);
    assert.equal(handoffs[i].args.slice(0, 6).join(' '), '-q /dev/null claude --desktop --resume ' + root.split('/').at(-1));
  }
  evidence.push({ daemonRestarted: true, sessionResumed: session, desktopHandoffs: 3, protectedMainAndLaterSibling: true, caseAndUnicodeAliasesDenied: true, ownEditsAndWrites: true, unlistedOutsideAllowed: true, actualDesktopRendering: 'not tested; synthetic handoff', bashAndMcpContainment: 'not tested; next OS sandbox slice' });
  console.log(`PASS: persistent native denials, own edits/writes, later sibling after daemon restart, same CLI session resumed; unlisted outside remains allowed. ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await app?.cleanup();
  await server.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
