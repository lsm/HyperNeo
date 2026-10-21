import { strict as assert } from 'node:assert';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
const run = resolve(process.argv[2]);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[key], key);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const fixture = fileURLToPath(
  new URL('../../../packages/daemon/tests/fixtures/retry-acp.ts', import.meta.url)
);
process.env.HYPERNEO_ACP_COMMAND = process.execPath + ' ' + fixture + ' ' + join(run, 'home');
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { run };
const calls = () =>
  existsSync(join(run, 'home/acp-calls.jsonl'))
    ? readFileSync(join(run, 'home/acp-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x))
    : [];
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  await transport.initialize();
  await hub.request('providers.create', {
    params: {
      providerId: 'acp',
      displayName: 'Synthetic ACP',
      kind: 'built_in',
      authType: 'none',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
  });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'home'),
    title: 'ACP retry proof',
    config: { model: 'acp-default', provider: 'acp' },
  });
  evidence.sessionId = sessionId;
  const kickoff = await hub.request('message.send', { sessionId, content: 'ACP_KICKOFF_MARKER' });
  evidence.kickoff = kickoff;
  await until(() => calls().some((c) => c.method === 'session/prompt'), 'first prompt missing');
  evidence.followup = await hub.request('message.send', {
    sessionId,
    content: 'ACP_DEFERRED_MARKER',
    deliveryMode: 'defer',
  });
  await until(
    async () =>
      (
        await hub.request<{ total: number }>('session.messages.byStatus', {
          sessionId,
          status: 'deferred',
        })
      ).total === 1,
    'followup not deferred'
  );
  writeFileSync(join(run, 'home/release-error'), 'yes');
  await until(() => {
    const p = calls().filter((c) => c.method === 'session/prompt');
    return (
      p.length >= 3 &&
      ['ACP_KICKOFF_MARKER', 'ACP_DEFERRED_MARKER'].every((m) =>
        p.slice(1).some((c) => JSON.stringify(c.params).includes(m))
      )
    );
  }, 'replacement did not receive both prompts');
  evidence.counts = {
    consumed: await hub.request('session.messages.byStatus', { sessionId, status: 'consumed' }),
    deferred: await hub.request('session.messages.byStatus', { sessionId, status: 'deferred' }),
  };
  assert.equal((evidence.counts as { consumed: { total: number } }).consumed.total, 2);
  assert.equal((evidence.counts as { deferred: { total: number } }).deferred.total, 0);
  evidence.conversation = await hub.request('message.sdkMessages', { sessionId });
  assert(JSON.stringify(evidence.conversation).includes('ACP_RETRY_OK'));
  evidence.pass = true;
  console.log('PASS ACP actual RPC retry');
} finally {
  evidence.calls = calls();
  writeFileSync(join(run, 'evidence/acp.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
}
