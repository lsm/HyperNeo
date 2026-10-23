import { neoSettingsPackBriefs } from '../../../packages/daemon/src/lib/neo/packs/index.ts';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { query, type Options } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { handoffDraftDirectory } from '../../../packages/daemon/src/lib/handoffs/outbox.ts';
import { createHandoffOperations } from '../../../packages/daemon/src/lib/handoffs/operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { neoPrompt } from '../../../packages/daemon/src/lib/neo/prompt.ts';

const run = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 9361);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(!existsSync(join(run, 'evidence.json')), 'requires a fresh synthetic run');
for (const part of ['home', 'data', 'workspace']) mkdirSync(join(run, part), { recursive: true });
const worker = 'verify-worker';
const text = 'SYNTHETIC_HANDOFF_REPORT 🔬\n'.repeat(400);
const drafts = handoffDraftDirectory(join(run, 'data'), worker);
const privateFile = join(run, 'data', 'private.md');
writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_MUST_NOT_BE_READ');
const registry = createOperationRegistry(createHandoffOperations((id) => id === worker ? 'active' : null));
let mode = 'worker';
let step = 0;
let reference: Record<string, unknown>;
const results: Record<string, string> = {};
const strings = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(strings).join('\n') : value && typeof value === 'object' && 'text' in value ? strings(value.text) : JSON.stringify(value);
const object = (text: string) => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    if (!request.url.includes('/v1/messages')) return new Response('{}');
    const body = await request.json() as { messages?: { content?: unknown }[] };
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) if (block.type === 'tool_result') results[block.tool_use_id] = strings(block.content);
    }
    let tool: { name: string; input: unknown } | undefined;
    if (mode === 'worker') {
      if (step === 0) tool = { name: 'Write', input: { file_path: join(drafts, 'report.md'), content: text } };
      if (step === 1) tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.publish', input: { name: 'report.md' } } };
      if (step === 2) reference = object(results['worker-1']).reference;
    } else {
      if (step === 0) tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.read', input: { reference } } };
      if (step === 1) tool = { name: 'Read', input: { file_path: reference.path } };
      if (step === 2) tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.read', input: { reference: { ...reference, path: privateFile } } } };
      if (step === 3) {
        chmodSync(reference.path as string, 0o600);
        writeFileSync(reference.path as string, 'SYNTHETIC_TAMPERED_BYTES');
        tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.read', input: { reference } } };
      }
      if (step === 4) {
        const path = join(dirname(reference.path as string), 'linked.md');
        symlinkSync(privateFile, path);
        tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.read', input: { reference: { ...reference, path, name: 'linked.md' } } } };
      }
    }
    const id = `${mode}-${step++}`;
    const usage = { input_tokens: 20, output_tokens: 20 };
    const events = [
      ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Synthetic verification complete.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});
const execute = async (neo: boolean) => {
  const options: Options = {
    cwd: join(run, 'workspace'),
    executable: 'bun',
    pathToClaudeCodeExecutable: resolveSDKCliPath(),
    model: 'claude-sonnet-4-20250514',
    tools: ['Write', 'Read'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    additionalDirectories: [drafts],
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-devproxy-test-key', HYPERNEO_HANDOFF_DIR: drafts, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    mcpServers: { 'hyperneo-operations': createOperationMcpServer(registry, () => ({ sessionId: neo ? 'neo:verify-handoff' : worker, ...(neo ? { role: 'neo' as const } : {}) })) },
    stderr: (data) => writeFileSync(join(run, `${mode}-stderr.log`), data, { flag: 'a' }),
    maxTurns: 8,
  };
  if (neo) options.systemPrompt = { type: 'custom', prompt: neoPrompt(neoSettingsPackBriefs()), snapshot: false };
  const stream = query({ prompt: 'Run the synthetic handoff verification.', options });
  try { for await (const event of stream) writeFileSync(join(run, `${mode}-events.jsonl`), `${JSON.stringify(event)}\n`, { flag: 'a' }); }
  finally { stream.close(); }
};
try {
  await execute(false);
  assert(reference!, 'worker must receive a real MCP publication receipt');
  assert.equal(reference.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(readFileSync(reference.path as string, 'utf8'), text);
  mode = 'neo'; step = 0;
  await execute(true);
  const read = object(results['neo-0']);
  assert.equal(Buffer.from(read.data, 'base64').toString(), text);
  assert(results['neo-1'].includes('SYNTHETIC_HANDOFF_REPORT'));
  for (const id of ['neo-2', 'neo-3', 'neo-4']) assert(!results[id].includes('SYNTHETIC_PRIVATE_MUST_NOT_BE_READ'));
  assert(results['neo-3'].includes('tampered'));
  assert.equal(object(results['neo-2']).kind, 'rejected');
  assert.equal(object(results['neo-4']).kind, 'rejected');
  writeFileSync(join(run, 'evidence.json'), JSON.stringify({ reference, reportBytes: Buffer.byteLength(text), actualWorkerWriteAndMcpPublish: true, actualNeoMcpRead: true, actualNeoNativeRead: true, tamperedDenied: true, privateSiblingDenied: true, symlinkDenied: true, results }, null, 2));
  console.log(join(run, 'evidence.json'));
} finally { await server.stop(true); }
