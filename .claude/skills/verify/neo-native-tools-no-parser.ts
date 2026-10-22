import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { query, type Options } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { neoSecretReadRules } from '../../../packages/daemon/src/lib/neo/secret-read-rules.ts';

const run = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 9387);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(!existsSync(join(run, 'evidence.json')), 'use a fresh synthetic run');
for (const part of ['home', 'data', 'workspace', 'bin']) mkdirSync(join(run, part), { recursive: true });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const marker = join(run, 'executed.txt');
const fakeGh = join(run, 'bin', 'gh');
writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s\\n' 'SYNTHETIC_GH_ONLY' >> ${quote(marker)}\nprintf '%s\\n' 'SYNTHETIC_GH_ONLY'\n`, { mode: 0o700 });
const secret = join(run, 'home', '.ssh', 'synthetic.txt');
mkdirSync(join(run, 'home', '.ssh'), { recursive: true });
writeFileSync(secret, 'SYNTHETIC_SECRET_MUST_STAY_UNREAD');
const syntheticGh = `PATH=${quote(join(run, 'bin') + ':/usr/bin:/bin')} command gh pr merge 42`;
const commands = [
  `bash -c ${quote(syntheticGh)}`,
  `printf '%s\\n' "$(${syntheticGh})"`,
  'make publish',
  `PATH=${quote(dirname(process.execPath) + ':/usr/bin:/bin')} command bun run publish`,
];
const results: Record<string, string> = {};
let step = 0;
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('\n') : value && typeof value === 'object' && 'text' in value ? text(value.text) : JSON.stringify(value);
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    if (!request.url.includes('/v1/messages')) return new Response('{}');
    const body = await request.json() as { messages?: { content?: unknown }[] };
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) if (block.type === 'tool_result') results[block.tool_use_id] = text(block.content);
    }
    const id = `native-${step}`;
    const tool = step < commands.length
      ? { name: 'Bash', input: { command: commands[step] } }
      : step === commands.length ? { name: 'Read', input: { file_path: secret } } : undefined;
    step++;
    const usage = { input_tokens: 20, output_tokens: 20 };
    const events = [
      ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Synthetic native tools finished.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});
let stream: ReturnType<typeof query> | undefined;
try {
  const options: Options = {
    cwd: join(run, 'workspace'),
    executable: 'bun', pathToClaudeCodeExecutable: resolveSDKCliPath(),
    model: 'claude-sonnet-4-20250514',
    tools: ['Bash', 'Read'], allowedTools: ['Bash', 'Read'],
    disallowedTools: neoSecretReadRules(), settingSources: [],
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-devproxy-test-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    stderr: data => writeFileSync(join(run, 'sdk-stderr.log'), data, { flag: 'a' }),
  };
  writeFileSync(join(options.cwd!, 'Makefile'), `publish:\n\t${syntheticGh}\n`);
  writeFileSync(join(options.cwd!, 'package.json'), JSON.stringify({ name: 'synthetic-only', scripts: { publish: syntheticGh } }));
  stream = query({ prompt: 'Run the scripted synthetic native-tool verification.', options });
  for await (const event of stream) writeFileSync(join(run, 'sdk-events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
  const executions = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
  writeFileSync(join(run, 'evidence.json'), JSON.stringify({ commands, executions, results, hookCount: options.hooks?.PreToolUse?.length ?? 0, disallowedTools: options.disallowedTools }, null, 2));
  assert.equal(executions.length, commands.length, 'all four command forms must execute the synthetic gh stub');
  for (let i = 0; i < commands.length; i++) assert(results[`native-${i}`]?.includes('SYNTHETIC_GH_ONLY'));
  assert(results['native-4'] && !results['native-4'].includes('SYNTHETIC_SECRET_MUST_STAY_UNREAD'));
  assert.match(results['native-4'], /denied|not allowed|permission/i);
  console.log(`PASS: four synthetic Bash forms execute; direct secret Read denied. ${run}/evidence.json`);
} finally { stream?.close(); await server.stop(true); }
