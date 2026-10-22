import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdirSync, readdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const [directory, portText = '9394', mode = 'verify'] = process.argv.slice(2);
const run = resolve(directory);
const port = Number(portText);
assert(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 8399);
assert(readdirSync(run).length === 0, 'use a fresh empty run directory');
await new Promise((accept, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(port, '127.0.0.1', () => listener.close(accept));
});
mkdirSync(`${run}/home`);
mkdirSync(`${run}/evidence`);
const env = { PATH: process.env.PATH, HOME: `${run}/home`, NODE_ENV: 'test', HYPERNEO_DATA_DIR: `${run}/data` };
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const persistent = mode === 'persistent' || mode === 'reproduce-loop';
const url = `http://127.0.0.1:${port}/neo?build-reconnect=synthetic#keep-route`;
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));
let daemon;
let browser;
const evidence = { mode, url, commitA, commitB, observations: [] };
function command(args, name, commit) {
  const log = openSync(`${run}/${name}.log`, 'a');
  const child = spawn('bun', args, { env: { ...env, HYPERNEO_BUILD_COMMIT: commit }, stdio: ['ignore', log, log] });
  closeSync(log);
  return child;
}
async function build(commit) {
  const child = command(['run', '--cwd', 'packages/web', 'build'], `build-${commit[0]}`, commit);
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  assert.equal(code, 0, 'web build failed');
}
async function stopDaemon() {
  if (!daemon) return;
  const child = daemon;
  daemon = null;
  if (child.exitCode !== null) return;
  const stopped = new Promise((accept) => child.once('exit', accept));
  child.kill('SIGTERM');
  await stopped;
}
async function startDaemon(commit) {
  daemon = command(['packages/cli/main.ts', '--port', String(port), '--host', '127.0.0.1', '--db-path', `${run}/data/daemon.db`], `daemon-${commit[0]}`, commit);
  for (let attempt = 0; attempt < 120; attempt++) {
    assert(daemon.exitCode === null, 'isolated daemon exited');
    if (await fetch(url).then((reply) => reply.ok).catch(() => false)) return;
    await pause(250);
  }
  throw new Error('isolated daemon did not become ready');
}
async function read(page, expected, stage) {
  await page.waitForFunction(() => window.__messageHubReady && window.connectionManager?.isConnected(), { timeout: 20000 });
  const value = await page.evaluate(async () => ({
    build: await window.__messageHub.request('operation.invoke', { name: 'system.build', input: {} }),
    loads: Number(sessionStorage.getItem('verify-build-loads')),
    url: location.href,
    reloadMarkers: Object.keys(sessionStorage).filter((key) => key.startsWith('hyperneo:web-build-reload:')),
    navigation: performance.getEntriesByType('navigation')[0].type,
  }));
  assert.equal(value.build.commit, expected);
  assert.equal(value.url, url);
  evidence.observations.push({ stage, ...value });
  writeFileSync(`${run}/evidence/reconnect.json`, JSON.stringify(evidence, null, 2));
  return value;
}
try {
  await build(commitA);
  await startDaemon(commitA);
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const count = Number(sessionStorage.getItem('verify-build-loads')) + 1;
    sessionStorage.setItem('verify-build-loads', String(count));
    console.log(`verify-build-load:${count}`);
  });
  const page = await context.newPage();
  const loads = [];
  page.on('console', (message) => {
    if (message.text().startsWith('verify-build-load:')) loads.push(Number(message.text().split(':')[1]));
  });
  await page.goto(url);
  assert.equal((await read(page, commitA, 'initial')).loads, 1);
  await page.screenshot({ path: `${run}/evidence/before.png` });
  await stopDaemon();
  await startDaemon(commitA);
  await read(page, commitA, 'same-build-reconnect');
  await pause(1500);
  assert.equal((await read(page, commitA, 'same-build-stable')).loads, 1);
  await stopDaemon();
  if (!persistent) await build(commitB);
  await startDaemon(commitB);
  if (mode === 'reproduce-loop') {
    for (let attempt = 0; attempt < 100 && loads.at(-1) < 4; attempt++) await pause(100);
    assert(loads.at(-1) >= 4, 'persistent mismatch did not reproduce a reload loop');
    evidence.observations.push({ stage: 'persistent-reload-loop', loads: [...loads] });
    writeFileSync(`${run}/evidence/reconnect.json`, JSON.stringify(evidence, null, 2));
    await stopDaemon();
  } else if (mode === 'reproduce') {
    await read(page, commitB, 'changed-build');
    await pause(3000);
    assert.equal((await read(page, commitB, 'stale-page')).loads, 1);
  } else {
    await page.waitForFunction(() => Number(sessionStorage.getItem('verify-build-loads')) === 2, { timeout: 20000 });
    assert.equal((await read(page, commitB, 'changed-build-reloaded')).navigation, 'reload');
    await pause(2000);
    assert.equal((await read(page, commitB, 'new-build-stable')).loads, 2);
    await stopDaemon();
    await startDaemon(commitB);
    await read(page, commitB, 'new-build-reconnect');
    await pause(1500);
    assert.equal((await read(page, commitB, 'new-build-reconnect-stable')).loads, 2);
  }
  if (mode !== 'reproduce-loop') await page.screenshot({ path: `${run}/evidence/after.png` });
  console.log(`${mode} PASS: ${run}/evidence/reconnect.json`);
} finally {
  await browser?.close();
  await stopDaemon();
}
