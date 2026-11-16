import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });

const jwt = (accountId: string, marker: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({ marker, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
    ).toString('base64url'),
    '',
  ].join('.');
const codexAuthPath = join(run, 'home/.codex/auth.json');
const hyperneoAuthPath = join(run, 'data/auth.json');
const writeCodexLogin = (access: string, refresh: string) => {
  mkdirSync(join(run, 'home/.codex'), { recursive: true });
  writeFileSync(codexAuthPath, JSON.stringify({ tokens: { access_token: access, refresh_token: refresh } }), {
    mode: 0o600,
  });
};
const firstAccess = jwt('synthetic-account', 'first');
const rotatedAccess = jwt('synthetic-account', 'rotated-by-codex');
writeCodexLogin(firstAccess, 'synthetic-codex-refresh');
const codexFileAtStart = readFileSync(codexAuthPath, 'utf-8');

const outbound: { host: string; path: string }[] = [];
const tokenEndpointCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  outbound.push({ host: url.hostname, path: url.pathname });
  if (url.hostname === 'auth.openai.com' && url.pathname === '/oauth/token') {
    tokenEndpointCalls.push(url.pathname);
    return Response.json({
      access_token: jwt('synthetic-account', 'refreshed-by-hyperneo'),
      refresh_token: 'synthetic-rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  }
  return new Response('offline fixture', { status: 503 });
}) as typeof fetch;

const hyperneoLogin = () => {
  const stored = (JSON.parse(readFileSync(hyperneoAuthPath, 'utf-8')) as {
    openai?: { access?: string; refresh?: string };
  }).openai;
  return {
    present: Boolean(stored?.access),
    holdsCodexAccessAsIs: stored?.access === firstAccess,
    holdsCodexRotatedAccess: stored?.access === rotatedAccess,
    holdsARefreshToken: stored?.refresh !== undefined,
  };
};

let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
      disableWorktrees: true,
    },
    standalone: true,
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();

  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    socket!.onopen = () => done();
    socket!.onerror = () => fail(new Error('RPC connection failed'));
  });
  const call = <T>(method: string, data: unknown): Promise<T> =>
    new Promise<T>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 10_000);
      const onMessage = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.requestId !== id && reply.id !== id) return;
        clearTimeout(timer);
        socket!.removeEventListener('message', onMessage);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data as T);
      };
      socket!.addEventListener('message', onMessage);
      socket!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method,
          data,
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });

  await call('providers.create', {
    params: {
      providerId: 'anthropic-codex',
      displayName: 'OpenAI (synthetic Codex import)',
      kind: 'built_in',
      authType: 'oauth',
      isEnabled: true,
      isDefault: false,
      sortOrder: 0,
    },
  });
  const afterEnable = {
    tokenEndpointCalls: tokenEndpointCalls.length,
    codexFileUnchanged: readFileSync(codexAuthPath, 'utf-8') === codexFileAtStart,
    hyperneoLogin: hyperneoLogin(),
  };

  writeCodexLogin(rotatedAccess, 'synthetic-codex-rotated-refresh');
  const codexFileAfterRotation = readFileSync(codexAuthPath, 'utf-8');
  const refresh = await call<{ success: boolean; error?: string }>('auth.refresh', {
    providerId: 'anthropic-codex',
  });
  const afterRefresh = {
    rpc: refresh,
    tokenEndpointCalls: tokenEndpointCalls.length,
    codexFileUnchanged: readFileSync(codexAuthPath, 'utf-8') === codexFileAfterRotation,
    hyperneoLogin: hyperneoLogin(),
  };

  const evidence = { afterEnable, afterRefresh, outbound };
  writeFileSync(join(run, 'evidence/codex-login-import.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));

  assert.deepEqual(afterEnable, {
    tokenEndpointCalls: 0,
    codexFileUnchanged: true,
    hyperneoLogin: {
      present: true,
      holdsCodexAccessAsIs: true,
      holdsCodexRotatedAccess: false,
      holdsARefreshToken: false,
    },
  });
  assert.deepEqual(afterRefresh, {
    rpc: { success: true },
    tokenEndpointCalls: 0,
    codexFileUnchanged: true,
    hyperneoLogin: {
      present: true,
      holdsCodexAccessAsIs: false,
      holdsCodexRotatedAccess: true,
      holdsARefreshToken: false,
    },
  });
  console.log(JSON.stringify({ passed: true }));
} finally {
  socket?.close();
  await app?.cleanup();
  globalThis.fetch = realFetch;
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
