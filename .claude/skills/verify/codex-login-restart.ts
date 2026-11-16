import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';

const run = resolve(process.argv.at(-1)!);
const phase = process.argv.at(-2) === 'restart' ? 'restart' : 'first';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });

const jwt = (accountId: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
    ).toString('base64url'),
    '',
  ].join('.');
const accountA = jwt('synthetic-account-a');
const accountB = jwt('synthetic-account-b');

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  outbound.push(url.hostname);
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

if (phase === 'first') {
  mkdirSync(join(run, 'home/.codex'), { recursive: true });
  writeFileSync(
    join(run, 'home/.codex/auth.json'),
    JSON.stringify({ tokens: { access_token: accountB, refresh_token: 'synthetic-codex-refresh' } }),
    { mode: 0o600 }
  );
}

const boot = () =>
  createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
      disableWorktrees: true,
    },
    standalone: true,
    verbose: false,
  });

const openaiLogin = async () => {
  const provider = getProviderRegistry().get('anthropic-codex');
  const credentials = await provider?.getCredentials?.();
  const access = credentials?.type === 'oauth' ? credentials.accessToken : undefined;
  return { usesAccountA: access === accountA, usesCodexAccountB: access === accountB };
};

let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
try {
  app = await boot();
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();

  if (phase === 'first') {
    socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    await new Promise<void>((done, fail) => {
      socket!.onopen = () => done();
      socket!.onerror = () => fail(new Error('RPC connection failed'));
    });
    const id = crypto.randomUUID();
    const reply = await new Promise<{ error?: unknown }>((done) => {
      socket!.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.requestId === id || message.id === id) done(message);
      });
      socket!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method: 'providers.create',
          data: {
            params: {
              providerId: 'anthropic-codex',
              displayName: 'OpenAI (synthetic account A)',
              kind: 'built_in',
              authType: 'oauth',
              isEnabled: true,
              isDefault: false,
              sortOrder: 0,
            },
            credentials: { oauthAccessToken: accountA, oauthRefreshToken: 'synthetic-refresh-a' },
          },
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
    assert.equal(reply.error, undefined);
    const afterCreate = await openaiLogin();
    socket.close();
    socket = undefined;
    await app.cleanup();
    app = undefined;

    const child = Bun.spawnSync(['bun', import.meta.path, 'restart', run], {
      env: process.env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const afterRestart = JSON.parse(
      readFileSync(join(run, 'evidence/codex-login-restart-second.json'), 'utf-8')
    ) as { afterRestart: unknown; outbound: string[] };
    const evidence = { afterCreate, restartExit: child.exitCode, ...afterRestart, firstOutbound: outbound };
    writeFileSync(join(run, 'evidence/codex-login-restart.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));

    assert.deepEqual(afterCreate, { usesAccountA: true, usesCodexAccountB: false });
    assert.equal(child.exitCode, 0);
    assert.deepEqual(afterRestart.afterRestart, { usesAccountA: true, usesCodexAccountB: false });
    assert.deepEqual(afterRestart.outbound, []);
    assert.deepEqual(outbound, []);
    console.log(JSON.stringify({ passed: true }));
  } else {
    const afterRestart = await openaiLogin();
    writeFileSync(
      join(run, 'evidence/codex-login-restart-second.json'),
      JSON.stringify({ afterRestart, outbound })
    );
  }
} finally {
  socket?.close();
  await app?.cleanup();
  globalThis.fetch = realFetch;
}
