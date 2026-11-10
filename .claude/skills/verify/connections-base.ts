import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { googleConnectionWrites } from '../../../packages/daemon/src/storage/repositories/google-connections-worker.ts';
import { artifactIdentityWrites } from '../../../packages/daemon/src/storage/repositories/artifact-file-identity-write.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const account = { id: 'synthetic-connection', provider: 'google' as const, accountId: 'subject-1', email: 'one@example.test', scopes: ['openid', 'email'], health: 'healthy' as const };
const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1234, scopes: account.scopes };
const evidence: unknown[] = [];
let originalIdentity = '';
for (const phase of ['initial', 'restart', 'second-instance']) {
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, phase === 'second-instance' ? 'second/daemon.db' : 'data/daemon.db') }), verbose: false });
  let ws: WebSocket | undefined;
  try {
    assert.notEqual(app.server.port, 8399);
    await app.jobProcessor.stop();
    const db = app.db.getDatabase();
    const prepare = db.prepare.bind(db);
    db.prepare = (...args) => {
      assert(!args[0].includes('google_connections'), 'connection SQL must run in the DB worker');
      return prepare(...args);
    };
    const gateway = gatewayFor(db);
    const identity = await gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID());
    const store = new DatabaseCredentialStore(db, 'synthetic-proof-key');
    const vault = new ConnectionVault(store, identity);
    ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket unavailable')); });
    const read = () => new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('status RPC timed out')), 10000);
      ws!.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        evidence.push({ phase, reply });
        if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
      };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'connections.list', input: {} }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    assert.deepEqual(await read(), { connections: phase === 'restart' ? [account] : [] });
    if (phase === 'initial') {
      originalIdentity = identity;
      await vault.replace(account, tokens);
      await gateway.call(googleConnectionWrites, 'put', account);
    } else if (phase === 'restart') {
      assert.equal(identity, originalIdentity);
      assert.deepEqual(await vault.read(account), tokens);
    } else {
      assert.notEqual(identity, originalIdentity);
      assert.equal(await vault.read(account), null);
    }
    if (phase !== 'second-instance') {
      assert.deepEqual(await read(), { connections: [account] });
      assert.equal(await new ConnectionVault(store, 'other-instance').read(account), null);
      const ciphertext = JSON.stringify(db.prepare('SELECT * FROM provider_credentials').all());
      assert(!ciphertext.includes(tokens.accessToken) && !ciphertext.includes(tokens.refreshToken));
    }
    const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-worker', role: 'neo' }));
    const refused = await mcp({ name: 'connections.list', input: {} });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).code, 'forbidden');
    evidence.push({ phase, identity, agentRefused: true, vaultChecksPassed: true });
  } finally { ws?.close(); await app.cleanup(); }
}
const output = JSON.stringify({ evidence, resourcesClosed: true }, null, 2);
assert(!output.includes(tokens.accessToken) && !output.includes(tokens.refreshToken));
writeFileSync(join(run, 'evidence/connections-base.json'), output);
console.log('PASS: empty instances, secret-free status through real RPC, encrypted bundle survives restart, instance isolation, agent access refused; resources closed');
