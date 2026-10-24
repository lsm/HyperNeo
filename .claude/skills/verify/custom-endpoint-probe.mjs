import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert(!existsSync(run));
for (const name of ['home', 'data', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const requests = [];
const cases = [];
let rejectProbe = false;
const endpoint = createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, headers: req.headers });
  const anthropic = req.url.startsWith('/anthropic/');
  const authorized = req.headers.authorization === 'Bearer synthetic-key' && req.headers['x-fixture'] === 'synthetic' &&
    (!anthropic || (req.headers['x-api-key'] === 'synthetic-key' && req.headers['anthropic-version'] === '2099-01-01'));
  const status = req.method === 'OPTIONS' ? 403 : rejectProbe ? 503 : !authorized ? 401 :
    /^\/(openai|anthropic)\/v1\/models\?editor=1$/.test(req.url) ? 200 : 404;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model', type: 'model' }] }));
});
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
const endpointPort = endpoint.address().port;
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
assert(port !== 8399 && endpointPort !== 8399);
const bun = process.env.VERIFY_BUN || 'bun';
const env = { PATH: join(run, 'bin') + ':' + process.env.PATH, HOME: join(run, 'home'), TMPDIR: run,
  NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), LOG_LEVEL: 'warn' };
const log = createWriteStream(join(run, 'daemon.log'));
const daemon = spawn(bun, ['packages/cli/main.ts', '--host', '127.0.0.1', '--port', String(port), '--db-path', join(run, 'data/daemon.db')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stdout.pipe(log); daemon.stderr.pipe(log);
let socket, browser;
const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), port, endpointPort, cases, requests };
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (daemon.exitCode !== null) throw new Error(readFileSync(join(run, 'daemon.log'), 'utf8'));
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'isolated daemon did not become ready');
  assert(readFileSync(join(run, 'daemon.log'), 'utf8').includes('HyperNeo Test Server'));
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  async function rpc(method, data) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => reject(new Error(method + ' timeout')), 15000);
      socket.onmessage = ({ data: raw }) => {
        const reply = JSON.parse(raw);
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.data);
      };
      socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  }
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const [id, type] of [['openai', 'openai-chat'], ['anthropic', 'anthropic-messages']]) {
    await rpc('customEndpoints.add', { endpoint: { id, name: `Synthetic ${id} endpoint`, type,
      baseUrl: `http://127.0.0.1:${endpointPort}/${id}`, apiKey: 'synthetic-key',
      headers: { 'X-Fixture': 'synthetic', ...(id === 'anthropic' ? { 'anthropic-version': '2099-01-01' } : {}) }, models: [{ id: 'fixture-model' }] } });
    await page.goto(`http://127.0.0.1:${port}/settings?tab=providers`);
    await page.getByText(`Synthetic ${id} endpoint`, { exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${endpointPort}/${id}/v1/${id === 'anthropic' ? 'messages' : 'chat/completions'}?editor=1`);
    const start = requests.length;
    await dialog.getByRole('button', { name: 'Fetch models', exact: true }).click();
    await dialog.getByText('1 model found', { exact: false }).waitFor();
    const discovery = requests.slice(start).find(request => request.method === 'GET');
    assert(discovery, 'discovery did not reach the fixture');
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    const reached = `Reached http://127.0.0.1:${endpointPort}/${id}/v1/models?editor=1`;
    let passed = true;
    try { await page.getByText(reached, { exact: true }).waitFor({ timeout: 3500 }); } catch { passed = false; }
    await page.screenshot({ path: join(run, 'evidence', `${id}.png`), fullPage: true });
    const probes = requests.slice(start).filter(request => request.method === 'GET');
    const item = { id, passed, discovery, probes, text: await page.locator('body').innerText() };
    cases.push(item);
    if (passed) {
      assert.equal(probes.length, 2);
      assert.equal(probes[1].url, discovery.url);
      assert.deepEqual(probes[1].headers, discovery.headers);
      assert(!probes[1].headers.origin, 'endpoint request came from the browser');
      rejectProbe = true;
      await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
      await page.getByText(/HTTP 503/).waitFor();
      item.uncachedFailureVisible = true;
      rejectProbe = false;
    }
  }
  evidence.browserErrors = errors;
  assert(cases.every(item => item.passed), 'editor Test connection must succeed through the daemon without CORS');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await browser?.close();
  socket?.close();
  daemon.kill('SIGTERM');
  if (daemon.exitCode === null) await new Promise(resolve => daemon.once('exit', resolve));
  await new Promise(resolve => endpoint.close(resolve));
  log.end();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
