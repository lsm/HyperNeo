import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CustomEndpointProvider } from '../../../packages/daemon/src/lib/providers/custom-endpoint-provider.ts';
import { refreshQueryEnvFromProcess } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { NON_ANTHROPIC_PREFIX_PROVIDER_VARS } from '../../../packages/daemon/src/lib/provider-service.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
const cli = resolve(
  process.env.VERIFY_CLAUDE ||
    new URL(
      '../../../node_modules/.bun/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
      import.meta.url
    ).pathname
);
assert(existsSync(cli), `SDK CLI not found at ${cli}`);

let sentOneMillionBeta = false;

const sse = (model: string) =>
  [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let model = 'unknown';
    try {
      model = String(JSON.parse(body).model);
    } catch {}
    sentOneMillionBeta = String(req.headers['anthropic-beta'] ?? '').includes('context-1m');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(model));
  });
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

type SdkRun = { model: string; contextWindow: number; sentOneMillionBeta: boolean };

const daemonEnvFor = async (maxContextTokens: number) => {
  const provider = new CustomEndpointProvider(
    {
      id: 'devin',
      type: 'anthropic-messages',
      name: 'devin',
      baseUrl: 'https://example.invalid/devin',
      models: [{ id: 'swe-2-high', capabilities: { maxContextTokens } }],
      defaultModelId: 'swe-2-high',
    },
    { bridgeFactories: { 'anthropic-messages': () => ({ port: 40123, stop: () => {} }) } }
  );
  await provider.ensureBridgeStarted('swe-2-high');
  const providerEnvVars = provider.buildSdkConfig('swe-2-high', { sessionId: 'verify' }).envVars;
  const extraProviderManagedEnvVars = NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
    (key) => providerEnvVars[key] !== undefined
  );
  const childEnv = { ...process.env, ...providerEnvVars };
  const env = refreshQueryEnvFromProcess(
    { ...providerEnvVars },
    childEnv,
    {
      refreshAutoCompactWindow: true,
      clearProviderManaged: true,
      skipAmbientAnthropicApiKey: true,
      extraProviderManagedEnvVars,
    }
  ) as Record<string, string | undefined>;
  return { providerEnvVars, env };
};

const runCli = async (envVars: Record<string, string | undefined>): Promise<SdkRun> => {
  const env: Record<string, string> = {
    HOME: join(run, 'home'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_ENV: 'test',
    ANTHROPIC_AUTH_TOKEN: 'verify-local-mock',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const [key, value] of Object.entries(envVars)) if (value !== undefined) env[key] = value;
  env.ANTHROPIC_BASE_URL = upstreamUrl;
  sentOneMillionBeta = false;
  const child = spawn(
    cli,
    ['-p', 'hello', '--model', 'default', '--output-format', 'stream-json', '--verbose'],
    { cwd: join(run, 'workspace'), env }
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  const code = await new Promise<number>((done) => child.on('close', (value) => done(value ?? -1)));
  assert.equal(code, 0, `SDK CLI exited ${code}: ${err.slice(0, 400)}`);
  const lines = out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const init = lines.find((line) => line.subtype === 'init');
  const result = lines.at(-1) as { modelUsage?: Record<string, { contextWindow?: number }> };
  const usage = Object.entries(result.modelUsage ?? {})[0];
  assert.ok(init && usage, `SDK returned no init or modelUsage: ${out.slice(0, 400)}`);
  return {
    model: String(init.model),
    contextWindow: Number(usage[1].contextWindow),
    sentOneMillionBeta,
  };
};

const evidence: Record<string, unknown> = {};
try {
  const small = await daemonEnvFor(256_000);
  assert.equal(small.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1');
  assert.equal(small.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '256000');
  evidence.belowLimit = {
    providerEnvVars: {
      CLAUDE_CODE_DISABLE_1M_CONTEXT: small.providerEnvVars.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: small.providerEnvVars.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    },
    daemonEnv: {
      CLAUDE_CODE_DISABLE_1M_CONTEXT: small.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: small.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: small.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    },
  };
  evidence.belowLimitRun = await runCli(small.env);
  assert.equal(evidence.belowLimitRun.model, 'swe-2-high');
  assert.equal(evidence.belowLimitRun.contextWindow, 256_000);
  assert.equal(evidence.belowLimitRun.sentOneMillionBeta, false);

  const large = await daemonEnvFor(1_000_000);
  assert.equal(large.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined);
  assert.equal(large.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  evidence.million = {
    daemonEnv: {
      CLAUDE_CODE_DISABLE_1M_CONTEXT: large.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: large.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    },
  };
  evidence.millionRun = await runCli(large.env);
  assert.equal(evidence.millionRun.model, 'swe-2-high[1m]');
  assert.equal(evidence.millionRun.contextWindow, 1_000_000);
  assert.equal(evidence.millionRun.sentOneMillionBeta, true);

  evidence.verified = true;
  console.log(
    'PASS: through the daemon env the CLI receives, a 256k custom model runs as swe-2-high with a 256000 window and no 1M beta; a 1M model still runs as swe-2-high[1m] at 1000000.'
  );
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await new Promise<void>((done) => upstream.close(() => done()));
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
