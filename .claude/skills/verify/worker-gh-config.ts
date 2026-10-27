import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from '../../../packages/daemon/node_modules/smol-toml';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { installClaudeNativeWrites, readClaudeWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { codexWorkerSandbox, prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const [codex, gh, runArg] = process.argv.slice(2);
const run = resolve(runArg), home = join(run, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(codex.startsWith('/') && gh.startsWith('/'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(home, '.config/gh'), { recursive: true });
writeFileSync(join(home, '.config/gh/config.yml'), 'git_protocol: ssh\n');
const protectedFiles = [join(home, 'Library/Keychains/synthetic'), join(home, '.git-credentials'), join(home, '.config/gh/hosts.yml')];
for (const path of protectedFiles) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, path.endsWith('hosts.yml') ? 'github.com:\n  user: synthetic\n  oauth_token: synthetic-oauth-token\n' : 'synthetic-credential-never-real');
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const roots = ['codex', 'claude'].map(engine => join(run, `worker-${engine}`));
for (const root of roots) {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  await prepareWorkerSandbox(root);
  writeFileSync(join(root, 'probe.sh'), [
    `${quote(gh)} config get git_protocol > gh.out 2> gh.err; printf '%s' "$?" > gh.status`,
    ...protectedFiles.map((path, index) => `/bin/cat ${quote(path)} > secret-${index}.out 2> secret-${index}.err; printf '%s' "$?" > secret-${index}.status`),
    '/bin/sh -c \'printf changed > "$GH_CONFIG_DIR/config.yml"\' 2> gh-write.err; printf \'%s\' "$?" > gh-write.status',
    'printf repo-readable > repo.out',
  ].join('\n'));
}
const results: Record<string, unknown> = {};
let stream: ReturnType<typeof query> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const sandbox = codexWorkerSandbox(roots[0]);
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex/config.toml'), stringify({ ...sandbox.config, default_permissions: sandbox.permissions }));
  const args = ['sandbox', '-P', sandbox.permissions, '-C', roots[0]];
  args.push('/bin/sh', './probe.sh');
  const native = spawnSync(codex, args, { cwd: roots[0], env: { ...process.env, ...sandbox.config.shell_environment_policy.set }, encoding: 'utf8', timeout: 30000 });
  writeFileSync(join(run, 'evidence/codex-stderr.log'), native.stderr ?? '');
  results.codexProcess = { status: native.status, error: native.error?.message, stdout: native.stdout, stderr: native.stderr };
  await installClaudeNativeWrites(roots[1], [join(run, 'source')]);
  const settingsPath = join(roots[1], '.claude/settings.local.json');
  const previous = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const ghConfig = join(home, '.config/gh');
  previous.sandbox.filesystem.denyRead.push(ghConfig);
  previous.permissions.deny.push(`Read(/${ghConfig})`, `Read(/${ghConfig}/**)`);
  writeFileSync(settingsPath, JSON.stringify(previous));
  const policy = (await readClaudeWorkerSandbox(roots[1]))!;
  let turns = 0;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { tools?: { name: string }[] };
    if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 100 });
    const main = body.tools?.some(tool => tool.name === 'Bash');
    const tool = main && ++turns === 1;
    const usage = { input_tokens: 20, output_tokens: 20 };
    const events = [
      ['message_start', { type: 'message_start', message: { id: `msg_${turns}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'probe', name: 'Bash', input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: '/bin/sh ./probe.sh' }) } : { type: 'text_delta', text: 'Synthetic probe finished.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  stream = query({ prompt: 'Run the scripted synthetic configuration probe.', options: {
    cwd: roots[1], executable: 'bun', pathToClaudeCodeExecutable: resolveSDKCliPath(),
    model: 'claude-sonnet-4-20250514', tools: ['Bash'], allowedTools: ['Bash'],
    disallowedTools: policy.permissions.deny, settingSources: [], permissionMode: 'dontAsk',
    sandbox: policy.sandbox,
    env: { ...process.env, ...policy.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'sk-synthetic-loopback-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    stderr: data => writeFileSync(join(run, 'evidence/claude-stderr.log'), data, { flag: 'a' }),
  } });
  for await (const event of stream) writeFileSync(join(run, 'evidence/claude-events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
  for (const [index, engine] of ['codex', 'claude'].entries()) {
    const root = roots[index];
    const files = ['gh.out', 'gh.err', 'gh.status', 'secret-0.out', 'secret-0.err', 'secret-0.status', 'secret-1.out', 'secret-1.err', 'secret-1.status', 'secret-2.out', 'secret-2.err', 'secret-2.status', 'gh-write.status', 'gh-write.err', 'repo.out'];
    results[engine] = Object.fromEntries(files.map(file => [file, readFileSync(join(root, file), 'utf8')]));
  }
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(results, null, 2));
  for (const engine of ['codex', 'claude']) {
    const observed = results[engine] as Record<string, string>;
    assert.equal(observed['gh.status'], '0', `${engine} gh config read failed`);
    assert.equal(observed['gh.out'].trim(), 'ssh');
    for (const index of [0, 1, 2]) {
      assert.notEqual(observed[`secret-${index}.status`], '0', `${engine} secret read allowed`);
      assert.equal(observed[`secret-${index}.out`], '');
    }
    assert.equal(observed['repo.out'], 'repo-readable');
    assert.notEqual(observed['gh-write.status'], '0', `${engine} private gh metadata was writable`);
  }
  console.log('PASS: real Codex sandbox and HyperNeo/Claude SDK Bash read synthetic gh config; Keychains, git credentials and gh hosts.yml reads remain OS-denied; private gh metadata stays read-only.');
} finally {
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(results, null, 2));
  stream?.close(); await server?.stop(true);
  for (const root of roots) await releaseWorkerSandbox(root);
}
