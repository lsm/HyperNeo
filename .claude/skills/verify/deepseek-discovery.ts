import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DeepSeekProvider } from '../../../packages/daemon/src/lib/providers/deepseek-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { clearModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
let requests = 0;
const fetchImpl: typeof fetch = async (url) => {
  requests++;
  assert(
    ['https://api.deepseek.com/models', 'https://api.deepseek.com/anthropic/v1/messages'].includes(
      String(url)
    )
  );
  return new Response(
    JSON.stringify(
      String(url).endsWith('/models')
        ? {
            data: [
              { id: 'deepseek-v4-pro', name: 'Synthetic Updated Pro', context_window: 262144 },
              { id: 'deepseek-future', name: 'Synthetic Flash', context_length: 524288 },
            ],
          }
        : {}
    )
  );
};
const provider = new DeepSeekProvider({}, fetchImpl);
provider.setCredentials({ type: 'api_key', apiKey: 'synthetic-discovery-only' });
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
  },
  verbose: false,
});
let socket: ReturnType<typeof createLocalSocket> | undefined;
try {
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const registry = getProviderRegistry();
  for (const registered of registry.getAll()) registry.unregister(registered.id);
  registry.register(provider);
  clearModelsCache();
  socket = createLocalSocket(
    `ws://127.0.0.1:${app.server.port}/ws`,
    join(run, 'data/local-rpc.credential')
  );
  await new Promise<void>((done, fail) => {
    socket!.once('open', done);
    socket!.once('error', fail);
  });
  const id = crypto.randomUUID();
  const reply = await new Promise<{
    models: { id: string; display_name: string; contextWindow: number }[];
  }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('models.list timeout')), 15000);
    socket!.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if ((frame.requestId ?? frame.id) !== id) return;
      clearTimeout(timer);
      if (frame.error) fail(new Error(JSON.stringify(frame.error)));
      else done(frame.data);
    });
    socket!.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'models.list',
        data: {},
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
  const pro = reply.models.find((model) => model.id === 'deepseek-v4-pro');
  assert.equal(pro?.display_name, 'Synthetic Updated Pro');
  assert.equal(pro.contextWindow, 262144);
  assert(reply.models.some((model) => model.id === 'deepseek-v4-flash'));
  assert.equal(provider.getModelForTier('opus'), 'deepseek-v4-pro');
  assert.equal(provider.getModelForTier('sonnet'), 'deepseek-future');
  assert.equal(
    provider.buildSdkConfig('deepseek-v4-pro').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    '262144'
  );
  assert.equal(provider.capabilities.vision, false);
  assert(requests > 0);
  evidence.passed = true;
  evidence.modelCount = reply.models.length;
  evidence.syntheticRequests = requests;
  evidence.models = reply.models.filter((model) => model.id.startsWith('deepseek-'));
} finally {
  socket?.close();
  clearModelsCache();
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/deepseek-discovery.json'), JSON.stringify(evidence, null, 2));
}
console.log(
  'PASS DeepSeek remote metadata, discovered tiers, fallback aliases and conservative vision'
);
