import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { query, type Options } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { handoffDraftDirectory } from '../../../packages/daemon/src/lib/handoffs/outbox.ts';
import { createHandoffOperations } from '../../../packages/daemon/src/lib/handoffs/operations.ts';
import { createSendMessageOperation } from '../../../packages/daemon/src/lib/messaging/message-send.ts';
import { startSessionDoor } from '../../../packages/daemon/src/lib/messaging/session-door.ts';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { neoPrompt as buildNeoPrompt } from '../../../packages/daemon/src/lib/neo/prompt.ts';

const run = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 9362);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(!existsSync(join(run, 'evidence.json')), 'requires a fresh synthetic run');
for (const part of ['home', 'data', 'workspace']) mkdirSync(join(run, part), { recursive: true });
const worker = 'verify-worker';
const text = 'SYNTHETIC_HANDOFF_REPORT\n'.padEnd(8192, 'x');
assert.equal(Buffer.byteLength(text), 8192);
const input = {to: 'neo:verify-handoff', text, idempotencyKey: 'synthetic-one-call'};
const drafts = handoffDraftDirectory(join(run, 'data'), worker);
const interruptedDraft = join(drafts, `message-${createHash('sha256').update(text).digest('hex')}.txt`);
writeFileSync(interruptedDraft, text.slice(0,32));
const privateFile = join(run, 'data', 'private.md');
writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_MUST_NOT_BE_READ');
assert(!existsSync(join(run, 'data/daemon.db')), 'requires a fresh synthetic DB');
let core = new DatabaseCore(join(run, 'data/daemon.db'));
await core.initialize();
const catalog = () => createOperationRegistry([createSendMessageOperation(new JobQueueRepository(core.getDb()), () => 'active'), ...createHandoffOperations(() => 'active')]);
let registry = catalog();
let door: Awaited<ReturnType<typeof startSessionDoor>> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let neoPrompt = '';
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
      if (step === 0) tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'message.send', input } };
      if (step === 1) { const receipt = object(results['worker-0']); reference = receipt.files?.[0]; if (reference) tool = {name:'mcp__hyperneo-operations__invoke',input:{name:'message.send',input:{to:'neo:verify-handoff',text:'Too many explicit files',files:Array.from({length:21},() => reference)}}}; }
    } else {
      if (step === 0) tool = { name: 'mcp__hyperneo-operations__invoke', input: { name: 'handoff.read', input: { reference } } };
      if (step === 1) tool = { name: 'Read', input: { file_path: reference.path } };

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
  if (neo) options.systemPrompt = { type: 'custom', prompt: buildNeoPrompt(), snapshot: false };
  const stream = query({ prompt: neo ? neoPrompt : 'Send the complete synthetic report in one operation call.', options });
  try { for await (const event of stream) writeFileSync(join(run, `${mode}-events.jsonl`), `${JSON.stringify(event)}\n`, { flag: 'a' }); }
  finally { stream.close(); }
};
let lastTick = performance.now();
let maxLagMs = 0;
const lagTimer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now-lastTick-10); lastTick=now; },10);
try {
  await execute(false);
  assert(reference!, results['worker-0'] ?? 'worker must receive a real MCP send receipt');
  assert.equal(reference.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(readFileSync(reference.path as string, 'utf8'), text);
  assert.equal(readFileSync(interruptedDraft,'utf8'),text.slice(0,32));
  const attachmentLimit = object(results['worker-1']);
  assert.equal(attachmentLimit.code,'invalid_input');
  assert(attachmentLimit.message.includes('20'));
  const receipt = object(results['worker-0']);
  const row = core.getDb().prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").get() as {payload:string};
  const entry = JSON.parse(row.payload);
  assert.equal(entry.origin, `session:${worker}`);
  assert.equal(entry.to.sessionId, 'neo:verify-handoff');
  assert.equal(entry.message.inputKind, 'task');
  neoPrompt = strings(entry.message.message.content);
  assert(neoPrompt.includes(reference.sha256 as string) && neoPrompt.includes(reference.path as string));
  assert(!neoPrompt.includes(text));
  assert(!neoPrompt.includes('[message id:'), 'session messages retain their ordinary envelope');
  core.getDb().exec('DELETE FROM job_queue');
  core.close();
  core = new DatabaseCore(join(run,'data/daemon.db'));
  await core.initialize();
  registry = catalog();
  const replay = await invokeOperation(registry, 'message.send', input, {source:'mcp',sessionId:worker});
  assert.deepEqual(replay, {kind:'completed', value:receipt});
  assert.equal((core.getDb().prepare('SELECT COUNT(*) AS n FROM job_queue').get() as {n:number}).n,0);
  door = await startSessionDoor(() => registry, join(run,'data/session-door.sock'));
  child = Bun.spawn([process.execPath,'run','packages/cli/main.ts','send','neo:verify-handoff',text], {cwd:process.cwd(), env:{...process.env, HYPERNEO_SESSION_ID:'synthetic-cli-worker',HYPERNEO_SESSION_DOOR:door.path},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  child=undefined;
  assert.equal(code,0,stderr);
  const cliReceipt=JSON.parse(stdout);
  assert.equal(cliReceipt.files[0].byteLength,8192);
  assert.equal(cliReceipt.files[0].sha256,reference.sha256);
  mode = 'neo'; step = 0;
  await execute(true);
  const read = object(results['neo-0']);
  assert.equal(Buffer.from(read.data, 'base64').toString(), text);
  assert(results['neo-1'].includes('SYNTHETIC_HANDOFF_REPORT'));
  writeFileSync(join(run, 'evidence.json'), JSON.stringify({ reference, receipt, cliReceipt, reportBytes: Buffer.byteLength(text), maxLagMs, actualWorkerMcpSend: true, interruptedDraftIgnored:true, actualMcpAttachmentLimit:true, actualNeoMcpRead: true, actualNeoNativeRead: true, actualCliUnixDoor:true, replayAfterDatabaseReopenAndJobCleanup:true, automaticSdkMailboxConsumptionVerified:false, results }, null, 2));
  assert(maxLagMs < 1000, `Synthetic send/read event-loop lag ${maxLagMs} ms`);
  console.log(join(run, 'evidence.json'));
} finally { clearInterval(lagTimer); child?.kill(); await door?.close(); await server.stop(true); core.close(); }
