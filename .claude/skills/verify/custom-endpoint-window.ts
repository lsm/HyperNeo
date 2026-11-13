import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelInfo, Session } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import {
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../packages/daemon/src/lib/providers/registry.ts';
import { setModelsCache, clearModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
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

type Case = {
  label: string;
  providerId: string;
  model: ModelInfo;
  buildSdkConfig?: () => { envVars: Record<string, string>; isAnthropicCompatible: boolean };
};

const model = (id: string, providerId: string, contextWindow: number): ModelInfo => ({
  id,
  name: id,
  provider: providerId,
  alias: id,
  family: id,
  contextWindow,
  description: 'Synthetic model',
  releaseDate: '',
  available: true,
});

const sessionFor = (entry: ModelInfo, providerId: string): Session =>
  ({
    id: 'verify-session',
    title: 'Verify window rule',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { model: entry.id, maxTokens: 8192, temperature: 1, provider: providerId },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  }) as Session;

const sdkEnvFor = async (entry: Case): Promise<Record<string, string | undefined>> => {
  resetProviderRegistry();
  getProviderRegistry().register({
    id: entry.providerId,
    displayName: entry.providerId,
    capabilities: {
      streaming: true,
      extendedThinking: false,
      thinkingModes: 'off',
      maxContextWindow: entry.model.contextWindow,
      functionCalling: true,
      vision: false,
    },
    isAvailable: () => true,
    getModels: async () => [entry.model],
    ownsModel: (id: string) => id === entry.model.id,
    getModelForTier: () => entry.model.id,
    getModelContextWindow: () => entry.model.contextWindow,
    buildSdkConfig:
      entry.buildSdkConfig ??
      (() => ({
        envVars: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:40123',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: entry.model.id,
          ANTHROPIC_DEFAULT_SONNET_MODEL: entry.model.id,
          ANTHROPIC_DEFAULT_OPUS_MODEL: entry.model.id,
        },
        isAnthropicCompatible: true,
      })),
  } as Provider);
  setModelsCache(new Map([['global', [entry.model]]]));
  const context: QueryOptionsBuilderContext = {
    session: sessionFor(entry.model, entry.providerId),
    settingsManager: {
      getGlobalSettings: () => ({ settingSources: ['user', 'project', 'local'] }),
      prepareSDKOptions: async () => ({}),
    } as unknown as QueryOptionsBuilderContext['settingsManager'],
  };
  const options = await new QueryOptionsBuilder(context).build();
  const provider = getProviderRegistry().get(entry.providerId)!;
  const providerEnvVars = provider.buildSdkConfig(entry.model.id, {
    sessionId: 'verify-session',
  }).envVars;
  const childEnv = { ...process.env, ...providerEnvVars };
  return refreshQueryEnvFromProcess(options.env as Record<string, string | undefined>, childEnv, {
    refreshAutoCompactWindow: true,
    clearProviderManaged: true,
    skipAmbientAnthropicApiKey: true,
    extraProviderManagedEnvVars: NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
      (key) => providerEnvVars[key] !== undefined
    ),
  }) as Record<string, string | undefined>;
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
  const result = lines.findLast((line) => line.type === 'result') as
    | { modelUsage?: Record<string, { contextWindow?: number }> }
    | undefined;
  const usage = Object.entries(result?.modelUsage ?? {})[0];
  assert.ok(init && usage, `SDK returned no init or modelUsage: ${out.slice(0, 400)}`);
  return {
    model: String(init.model),
    contextWindow: Number(usage[1].contextWindow),
    sentOneMillionBeta,
  };
};

const evidence: Record<string, unknown> = {};
const cases: Case[] = [
  { label: '256k custom', providerId: 'custom:devin', model: model('swe-2-high', 'custom:devin', 256_000) },
  { label: '262144 Kimi', providerId: 'kimi', model: model('k3-256k', 'kimi', 262_144) },
  { label: '200k model', providerId: 'custom:mid', model: model('mid-200k', 'custom:mid', 200_000) },
  { label: '1M model', providerId: 'custom:big', model: model('big-1m', 'custom:big', 1_000_000) },
];
const expected: Record<string, { window: number; oneMillionBeta: boolean }> = {
  '256k custom': { window: 256_000, oneMillionBeta: false },
  '262144 Kimi': { window: 262_144, oneMillionBeta: false },
  '200k model': { window: 200_000, oneMillionBeta: false },
  '1M model': { window: 1_000_000, oneMillionBeta: false },
};
const results: Record<string, unknown> = {};
try {
  for (const entry of cases) {
    const env = await sdkEnvFor(entry);
    assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1', `${entry.label} env`);
    assert.equal(
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      String(entry.model.contextWindow),
      `${entry.label} env window`
    );
    const result = await runCli(env);
    results[entry.label] = {
      envWindow: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      autoCompactWindow: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      sdk: result,
    };
    assert.equal(result.contextWindow, expected[entry.label].window, `${entry.label} window`);
    assert.equal(
      result.sentOneMillionBeta,
      expected[entry.label].oneMillionBeta,
      `${entry.label} 1M beta`
    );
  }
  evidence.cases = results;

  setModelsCache(new Map());
  resetProviderRegistry();
  const nativeSession = sessionFor(model('claude-opus-5-5', 'anthropic', 200_000), 'anthropic');
  const nativeOptions = await new QueryOptionsBuilder({
    session: nativeSession,
    settingsManager: {
      getGlobalSettings: () => ({ settingSources: [] }),
      prepareSDKOptions: async () => ({}),
    } as unknown as QueryOptionsBuilderContext['settingsManager'],
  }).build();
  const nativeEnv = (nativeOptions.env ?? {}) as Record<string, string | undefined>;
  evidence.native = {
    CLAUDE_CODE_DISABLE_1M_CONTEXT: nativeEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: nativeEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  };
  assert.equal(nativeEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined);
  assert.equal(nativeEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);

  evidence.verified = true;
  console.log(
    'PASS: one rule declares each non-native model at its real window — 256k, 262144, 200k and 1M all arrive at the CLI with that window and no 1M beta, and native Anthropic sets neither variable.'
  );
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await new Promise<void>((done) => upstream.close(() => done()));
  clearModelsCache();
  resetProviderRegistry();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
