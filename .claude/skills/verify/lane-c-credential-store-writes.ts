import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { getDataDir } = await import('../../../packages/daemon/src/lib/data-dir.ts');
assert.equal(getDataDir(), join(run, 'data'));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const { DatabaseCredentialStore, credentialService } = await import('../../../packages/daemon/src/lib/credentials/credential-store.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = { keyLocationIsSynthetic: true };
try {
  app = await createDaemonApp({ config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true, disableGoalProcessing: true,
  }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const endpoint = 'https://synthetic.invalid/transcribe';
  await hub.request('settings.global.update', { updates: {
    voice: { endpoint, apiKey: 'synthetic-voice-before' },
    exa: { apiKey: 'synthetic-exa-before' },
  } });
  const raw = app.db.getDatabase();
  const store = new DatabaseCredentialStore(raw);
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+provider_credentials\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('credential mutation SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  async function update(name: string, updates: unknown) {
    try { evidence[name] = await hub.request('settings.global.update', { updates }); }
    catch (error) { evidence[name] = { error: error instanceof Error ? error.message : String(error) }; }
  }
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    await update('replaceVoice', { voice: { endpoint, apiKey: 'synthetic-voice-after' } });
    await update('removeExa', { exa: { hasApiKey: false } });
    const voice = await store.get(credentialService('voice-transcription'), 'default');
    evidence.voiceRoundTrip = voice !== null && JSON.parse(voice).apiKey === 'synthetic-voice-after';
    evidence.exaRemoved = await store.get(credentialService('exa'), 'default') === null;
    const row = raw.prepare('SELECT encrypted_data, iv, tag FROM provider_credentials WHERE provider_id = ?').get(`${credentialService('voice-transcription')}:default`) as { encrypted_data: Uint8Array; iv: Uint8Array; tag: Uint8Array };
    assert(row);
    evidence.encryptedAtRest = !Buffer.from(row.encrypted_data).toString('utf8').includes('synthetic-voice-after');
    evidence.ivBytes = row.iv.byteLength;
    evidence.tagBytes = row.tag.byteLength;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'credential RPC persistence must not write to the main SQLite connection');
    const replacement = evidence.replaceVoice as { success?: boolean; settings?: { voice?: { apiKey?: string; hasApiKey?: boolean } } };
    const removal = evidence.removeExa as { success?: boolean; settings?: { exa?: { apiKey?: string; hasApiKey?: boolean } } };
    assert.equal(replacement.success, true);
    assert.equal(replacement.settings?.voice?.hasApiKey, true);
    assert.equal(replacement.settings?.voice?.apiKey, undefined);
    assert.equal(removal.success, true);
    assert.equal(removal.settings?.exa?.hasApiKey, false);
    assert.equal(removal.settings?.exa?.apiKey, undefined);
    assert.equal(evidence.voiceRoundTrip, true);
    assert.equal(evidence.exaRemoved, true);
    assert.equal(evidence.encryptedAtRest, true);
    assert.equal(evidence.ivBytes, 12);
    assert.equal(evidence.tagBytes, 16);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  await transport?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/credential-store-writes.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok settings RPC replaces and removes encrypted credentials on the writer with redacted replies');
