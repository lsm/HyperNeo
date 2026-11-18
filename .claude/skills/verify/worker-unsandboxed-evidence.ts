import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'evidence', 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account']) mkdirSync(join(run, dir), { recursive: true });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-b1-cli.ts', import.meta.url));
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--session-id') && process.argv[process.argv.indexOf('-n') + 1] !== 'desktop-wake') writeFileSync(${JSON.stringify(join(run, 'evidence/worker-cwd'))}, process.cwd());\nif (existsSync(${JSON.stringify(join(run, 'fail-cli'))})) process.exit(1);\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/script'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (existsSync(${JSON.stringify(join(run, 'fail-import'))})) { writeFileSync(join(process.cwd(), 'retained-human-note.txt'), 'Synthetic human bytes during handoff'); process.exit(1); }\nprocess.argv.push('--synthetic-desktop-import');\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['open', 'gh']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ws!.removeEventListener('message', receive); fail(new Error(`${name} timed out`)); }, 30000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      ws!.removeEventListener('message', receive);
      clearTimeout(timer);
      evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: name.startsWith('rpc:') ? name.slice(4) : 'operation.invoke', data: name.startsWith('rpc:') ? input : { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const existingFolder = join(run, 'existing');
  mkdirSync(existingFolder);
  const sourceSettingsDir = join(existingFolder, '.claude');
  const sourceSettingsPath = join(sourceSettingsDir, 'settings.local.json');
  mkdirSync(sourceSettingsDir, { recursive: true });
  writeFileSync(sourceSettingsPath, JSON.stringify({ env: { HYPERNEO_EVIDENCE: '/synthetic/obsolete-evidence', CUSTOM_WORKER_VALUE: 'retain' } }));
  await rpc('rpc:settings.global.update', { updates: { workerSandbox: 'off' } });
  const unsandboxed = await rpc('work.start', {
    adapter: 'claude-desktop', place: { machine: hostname(), folder: existingFolder, name: 'Synthetic source' },
    title: 'Synthetic unsandboxed worker', message: 'Synthetic task only', inPlace: true,
  }) as Result<WorkStarted>;
  assert(unsandboxed.ok, JSON.stringify(unsandboxed));
  const unsandboxedSettings = JSON.parse(readFileSync(sourceSettingsPath, 'utf8'));
  assert.equal(unsandboxedSettings.env.HYPERNEO_EVIDENCE, undefined);
  assert.equal(unsandboxedSettings.env.CUSTOM_WORKER_VALUE, 'retain');
  unsandboxedSettings.env.HYPERNEO_EVIDENCE = '/synthetic/obsolete-evidence';
  writeFileSync(sourceSettingsPath, JSON.stringify(unsandboxedSettings));
  const resumed = await rpc('work.send', { ref: unsandboxed.value.ref, message: 'Continue synthetic work' });
  assert((resumed as { ok: boolean }).ok, JSON.stringify(resumed));
  const resumedSettings = JSON.parse(readFileSync(sourceSettingsPath, 'utf8'));
  assert.equal(resumedSettings.env.HYPERNEO_EVIDENCE, undefined);
  assert.equal(resumedSettings.env.CUSTOM_WORKER_VALUE, 'retain');
  writeFileSync(join(run, 'evidence/unsandboxed-evidence-refresh.json'), JSON.stringify({ passed: true, staleHintRemoved: true, resumeHintRemoved: true, customValueRetained: true }, null, 2));
  console.log('PASS: work.start and work.send removed the stale evidence hint and retained the custom setting');
} finally {
  ws?.close();
  await app?.cleanup();
}
