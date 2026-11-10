import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import type { ExternalEventExtensionContext, HttpExternalEventExtension } from '../../../packages/daemon/src/lib/external-events/types.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const control = resolve(process.argv[2]);
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  standalone: true,
  verbose: false,
});
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  await waitForSdkBodyCopy(db);
  assert.notEqual(app.server.port, 8399);
  const base = `http://127.0.0.1:${app.server.port}`;
  const unpaired = await fetch(`${base}/ws`);
  assert.equal(unpaired.status, 401);
  assert.equal(await unpaired.text(), 'Device pairing required');
  const { code } = new DevicePairingRepository(db).createCode('human', 'Synthetic browser', true, Date.now());
  const html = `<!doctype html><html><meta charset="utf-8"><title>Browser HTTP auth gate</title>
  <style>body{font:20px system-ui;max-width:760px;margin:60px auto}button{font:inherit;padding:12px;margin:8px}pre{white-space:pre-wrap}</style>
  <h1>Browser HTTP authentication</h1>
  <p>Fresh synthetic daemon. Pair through the existing HTTP pairing endpoint, then make an ordinary GET.</p>
  <button id="check">Check ordinary GET</button>
  <button id="pair">Pair this synthetic browser</button>
  <pre id="result">Ready</pre>
  <script>
  const result = document.getElementById('result');
  document.getElementById('check').onclick = async () => {
    const response = await fetch('/ws', {cache: 'no-store'});
    result.textContent = 'Ordinary GET /ws returned ' + response.status;
  };
  document.getElementById('pair').onclick = async () => {
    const response = await fetch('/pair', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({code: ${JSON.stringify(code)}, name: 'Synthetic browser'})
    });
    const body = await response.json();
    result.textContent = 'Pairing returned ' + response.status + '. Credential in JSON: ' + ('credential' in body);
  };
  </script></html>`;
  const extension: HttpExternalEventExtension = {
    sourceId: 'synthetic-browser-http-gate',
    routes: [{ method: 'GET', path: '/synthetic-auth-gate', async handle() {
      return new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    } }],
    async start() {},
    async stop() {},
  };
  app.extensionManager.register(extension);
  app.extensionManager.registerRoutes(extension.routes, {} as ExternalEventExtensionContext);
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, 'browser.json'), JSON.stringify({
    url: `${base}/synthetic-auth-gate`, evidence: join(run, 'evidence'), doneFile: join(control, 'done'),
  }));
  const deadline = Date.now() + 15 * 60_000;
  while (!existsSync(join(control, 'done')) && Date.now() < deadline) await Bun.sleep(250);
  assert(existsSync(join(control, 'done')), 'Browser observations are required');
  const observed = JSON.parse(readFileSync(join(run, 'evidence/browser.json'), 'utf8'));
  assert.equal(observed.unpairedStatus, 401);
  assert.equal(observed.pairStatus, 200);
  assert.equal(observed.pairedGetStatus, 204);
  assert.equal(observed.passed, true);
  writeFileSync(join(run, 'evidence/auth-gate.json'), JSON.stringify({
    passed: true, ordinaryUnpairedGet: 401, ordinaryPairedGet: 204,
    pairing: 'Production POST /pair sets the browser cookie; no credential in the URL or response JSON',
  }, null, 2));
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
