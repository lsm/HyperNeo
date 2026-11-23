import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { GlmProvider } from '../../../packages/daemon/src/lib/providers/glm-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!process.env.GLM_API_KEY && !process.env.ZHIPU_API_KEY);

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
  },
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const provider = new GlmProvider({}, async (url) => {
    if (url === `${GlmProvider.BASE_URL}/v1/messages`) return Response.json({});
    assert.equal(url, GlmProvider.MODEL_LIST_URL);
    return Response.json({ data: [{ id: 'glm-5.4', object: 'model' }] });
  });
  provider.setCredentials({ type: 'api_key', apiKey: 'catalog-fixture' });
  const registry = getProviderRegistry();
  registry.unregister('glm');
  registry.register(provider);

  const rpc = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', 'rpc:models.list'], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(rpc.stdout).text();
  assert.equal(await rpc.exited, 0, output);
  const { reply } = JSON.parse(output);
  assert(Array.isArray(reply.models), output);
  const models = reply.models.filter((model: { provider: string }) => model.provider === 'glm');
  const added = models.filter((model: { id: string }) => model.id.startsWith('glm-5.4'));
  assert.equal(added.length, 1, output);
  const [model] = added;
  assert.equal(model.id, 'glm-5.4[1m]');
  assert.equal(model.display_name, 'GLM-5.4');
  assert.equal(model.alias, 'glm-5.4');
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.available, true);
  for (const id of [model.alias, model.id]) {
    const { envVars } = provider.buildSdkConfig(id);
    assert.equal(envVars.ANTHROPIC_DEFAULT_SONNET_MODEL, model.id);
    assert.equal(envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(model.contextWindow));
  }
  console.log(JSON.stringify({ catalogMatches: added.length, model, routingChecks: 2 }, null, 2));
} finally {
  await app.cleanup();
}
