import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import type { Session } from '@hyperneo/shared';
import {
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import {
  CustomEndpointProvider,
  customProviderIdFor,
} from '../../../packages/daemon/src/lib/providers/custom-endpoint-provider.ts';
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../packages/daemon/src/lib/providers/registry.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
const cli = resolve(
  process.env.VERIFY_CLAUDE ||
    new URL(
      '../../../node_modules/.bun/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      import.meta.url
    ).pathname
);
assert(existsSync(cli), `SDK CLI not found at ${cli}`);

const sse = (model: string) =>
  [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');

type Wire = { thinking?: unknown; output_config?: { effort?: unknown }; messages?: unknown };
let received: Wire[] = [];
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let model = 'unknown';
    if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
      const parsed = JSON.parse(body) as Wire & { model?: string };
      model = String(parsed.model);
      received.push(parsed);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(model));
  });
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

const providerId = customProviderIdFor('local-llama');
const sessionId = 'named-effort-proof';

const turn = async (namedEffort: boolean, thinkingLevel: string) => {
  resetProviderRegistry();
  const provider = new CustomEndpointProvider({
    id: 'local-llama',
    type: 'anthropic-messages',
    name: 'Local llama',
    baseUrl: upstreamUrl,
    models: [{ id: 'bonsai', capabilities: namedEffort ? { namedEffort } : {} }],
  });
  getProviderRegistry().register(provider);
  try {
    const session = {
      id: sessionId,
      title: 'Named effort proof',
      workspacePath: join(run, 'workspace'),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'bonsai', maxTokens: 32000, temperature: 1, provider: providerId, thinkingLevel },
      metadata: {},
    } as unknown as Session;
    const builder = new QueryOptionsBuilder({
      session,
      settingsManager: {
        getGlobalSettings: () => ({ settingSources: [] }),
        prepareSDKOptions: async () => ({}),
      } as unknown as QueryOptionsBuilderContext['settingsManager'],
    });
    const { thinking, effort } = builder.addSessionStateOptions({});
    await provider.ensureBridgeStarted('bonsai', { sessionId });
    provider.setSessionThinkingConfig(sessionId, builder.getEffectiveThinkingLevel());
    const { envVars } = provider.buildSdkConfig('bonsai', { sessionId });
    received = [];
    for await (const message of query({
      prompt: 'hello',
      options: {
        pathToClaudeCodeExecutable: cli,
        cwd: join(run, 'workspace'),
        model: 'default',
        maxTurns: 1,
        settingSources: [],
        thinking,
        effort,
        env: {
          HOME: join(run, 'home'),
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...envVars,
        },
      },
    })) {
      if (message.type === 'result') assert.equal(message.subtype, 'success');
    }
    const main = received.findLast((body) => JSON.stringify(body.messages).includes('hello'));
    assert.ok(main, `no main request reached the upstream (${received.length} requests)`);
    return {
      sdkOptions: { thinking, effort },
      wire: { thinking: (main.thinking as { type?: string } | undefined)?.type, budget: (main.thinking as { budget_tokens?: number } | undefined)?.budget_tokens, effort: main.output_config?.effort },
    };
  } finally {
    await provider.shutdown();
    resetProviderRegistry();
  }
};

const evidence: Record<string, unknown> = {};
try {
  const low = await turn(true, 'think8k');
  assert.deepEqual(low.wire, { thinking: 'adaptive', budget: undefined, effort: 'low' });
  const high = await turn(true, 'think32k');
  assert.deepEqual(high.wire, { thinking: 'adaptive', budget: undefined, effort: 'high' });
  const off = await turn(true, 'off');
  const plainOff = await turn(false, 'off');
  assert.equal(off.wire.thinking, 'disabled');
  assert.equal(off.sdkOptions.effort, undefined);
  assert.deepEqual(off.wire, plainOff.wire);
  const budget = await turn(false, 'think8k');
  assert.equal(budget.wire.thinking, 'enabled');
  assert.equal(budget.wire.budget, 8000);
  evidence.cases = { low, high, off, withoutCapabilityLow: budget, withoutCapabilityOff: plainOff };
  evidence.verified = true;
  console.log(
    'PASS: a custom Messages model with namedEffort sends adaptive thinking with effort low (Low) and high (High), Off is identical to a model without it (disabled thinking, no HyperNeo effort), and a model without it keeps the 8000-token budget.'
  );
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await new Promise<void>((done) => upstream.close(() => done()));
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
